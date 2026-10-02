#!/usr/bin/env node
/**
 * mercury-route - advisory task router.
 *
 * Reads a queue block (a task description) from stdin, --file, or arguments, and asks Mercury
 * Decide in one call:
 *   - which tier should handle it: heavy-reasoning | standard-coding | mechanical-small
 *   - needs live web?  needs images?  touches production?
 * and prints a recommendation JSON. It is advisory only: it never spawns or switches anything,
 * and the caller owns what happens next.
 *
 *   mercury-route --file task.md
 *   echo "rename foo_bar to fooBar across src/" | mercury-route
 *   mercury-route --tiers my-tiers.json --file task.md
 *
 * Exit codes: 0 recommendation printed, 1 failure, 2 only with --strict when the tier confidence
 * is below the floor (MERCURY_ROUTE_MIN_CONFIDENCE, default 0.15, in the choice-confidence scale).
 *
 * --tiers <file> is a JSON map {"tier-name": {"criteria": "when to pick it", "model": "optional slug"}}
 * that replaces the default tiers; any "model" values are echoed back as `suggestedModel`.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DecideError, decide } from "./decide.mjs";

export const DEFAULT_TIERS = {
  "heavy-reasoning": {
    criteria:
      "Genuinely hard or high-stakes work: architecture and design decisions, subtle correctness or " +
      "accuracy problems, security, anything touching production data or money, debugging with an " +
      "unknown cause, or anything cheaper attempts have already failed at.",
  },
  "standard-coding": {
    criteria:
      "Ordinary implementation inside a bounded task: write or change a function or a few files to a " +
      "clear spec, fix a bug whose cause is known, write tests that mirror existing ones, summarize a " +
      "codebase area.",
  },
  "mechanical-small": {
    criteria:
      "Mechanical work with one obvious right answer: renames, formatting, moving text, reading a file " +
      "and reporting what is in it, applying an already-specified edit, running a known command.",
  },
};

const MIN_CONFIDENCE_DEFAULT = 0.15;

export function buildQuestions(tiers = DEFAULT_TIERS) {
  return {
    tier: {
      type: "choice",
      instructions:
        "Which tier of model should handle this task? Pick the cheapest tier that can do it correctly " +
        "on the first attempt. Do not pick a higher tier for a task that is merely long.",
      criteria: Object.fromEntries(Object.entries(tiers).map(([name, tier]) => [name, tier.criteria])),
    },
    needs_web: {
      type: "noul",
      instructions: "Does completing this task require live web access (browsing, fetching URLs, current information that is not in the repository)?",
    },
    needs_images: {
      type: "noul",
      instructions: "Does completing this task require looking at images or screenshots, or producing visual output that must be judged by eye?",
    },
    touches_production: {
      type: "noul",
      instructions: "Does this task touch production systems, live data, deployments, payments, or anything hard to undo?",
    },
  };
}

function flag(answer) {
  const p = typeof answer?.noul === "number" ? answer.noul : null;
  return { value: p === null ? null : p >= 0.5, probability: p };
}

/** Turns Mercury's answers into the recommendation JSON. Pure, so it can be tested without a network. */
export function recommend(answers, tiers = DEFAULT_TIERS, meta = {}) {
  const tierAnswer = answers?.tier;
  if (!tierAnswer || typeof tierAnswer.choice !== "string" || !tiers[tierAnswer.choice]) {
    throw new DecideError("no usable tier in the response", "failed");
  }
  const confidence = typeof tierAnswer.confidence === "number" ? tierAnswer.confidence : null;
  const minConfidence = Number(process.env.MERCURY_ROUTE_MIN_CONFIDENCE || MIN_CONFIDENCE_DEFAULT);
  const needsWeb = flag(answers.needs_web);
  const needsImages = flag(answers.needs_images);
  const touchesProduction = flag(answers.touches_production);
  const notes = [];
  if (touchesProduction.value) notes.push("touches production: a human or the heavy tier should review before anything is applied");
  if (needsImages.value) notes.push("needs images: pick a model that can see them");
  if (needsWeb.value) notes.push("needs live web: pick a seat with browsing");
  if (confidence !== null && confidence < minConfidence) notes.push("low tier confidence: decide yourself");
  return {
    advisory: true,
    tier: tierAnswer.choice,
    suggestedModel: tiers[tierAnswer.choice].model ?? null,
    confidence,
    lowConfidence: confidence !== null && confidence < minConfidence,
    probabilities: tierAnswer.probabilities ?? null,
    needsWeb,
    needsImages,
    touchesProduction,
    notes,
    model: meta.model ?? null,
  };
}

function parseCli(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--file") out.file = argv[++i];
    else if (token === "--tiers") out.tiers = argv[++i];
    else if (token === "--strict") out.strict = true;
    else if (token === "--help" || token === "-h") out.help = true;
    else out.rest.push(token);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) {
    console.log("usage: mercury-route [--file task.md] [--tiers tiers.json] [--strict] [task text]   (or pipe the task on stdin)");
    return 0;
  }
  let task = cli.rest.join(" ").trim();
  try {
    if (!task && cli.file) task = readFileSync(cli.file, "utf8").trim();
    if (!task && !process.stdin.isTTY) task = readFileSync(0, "utf8").trim();
  } catch (error) {
    console.error(`mercury-route: cannot read the task (${error.code || "error"})`);
    return 1;
  }
  if (!task) {
    console.error("mercury-route: no task (pass --file, text arguments, or pipe it on stdin)");
    return 1;
  }
  let tiers = DEFAULT_TIERS;
  if (cli.tiers) {
    try {
      tiers = JSON.parse(readFileSync(cli.tiers, "utf8"));
      if (!tiers || typeof tiers !== "object" || !Object.keys(tiers).length) throw new Error("empty");
    } catch {
      console.error("mercury-route: --tiers must be a JSON file mapping tier name -> {criteria, model?}");
      return 1;
    }
  }
  try {
    const result = await decide(
      { state: { task }, questions: buildQuestions(tiers) },
      { caller: "route", truncate: true },
    );
    const recommendation = recommend(result.answers, tiers, { model: result.model });
    console.log(JSON.stringify(recommendation, null, 2));
    return cli.strict && recommendation.lowConfidence ? 2 : 0;
  } catch (error) {
    console.error(`mercury-route: ${error.message}`);
    return 1;
  }
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main();
