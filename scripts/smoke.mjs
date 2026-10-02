#!/usr/bin/env node
/**
 * Live smoke test (opt-in). Runs only when OPENROUTER_API_KEY is set in the environment; otherwise
 * it prints "skipped" and exits 0. Uses the free Mercury Decide model (cost 0) and makes about 9
 * calls. The key is read from the environment by the library at call time and is never printed.
 *
 *   OPENROUTER_API_KEY=... npm run smoke
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, computeStats, decide, estimateTokens, readLog, typedQuestion } from "../bin/decide.mjs";
import { buildQuestions, recommend } from "../bin/route.mjs";
import { callTool } from "../bin/mcp.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OPENROUTER_API_KEY) {
  console.log("smoke: skipped (OPENROUTER_API_KEY is not set)");
  process.exit(0);
}

const logPath = join(mkdtempSync(join(tmpdir(), "mercury-smoke-")), "calls.jsonl");
const base = { logPath, caller: "smoke", fallbacks: [] };
let failures = 0;
let calls = 0;

async function check(name, fn) {
  const t0 = Date.now();
  try {
    calls++;
    const note = await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)${note ? " " + note : ""}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const state = "Build #4821 failed on main: TypeError: Cannot read properties of undefined (reading 'map') in parser.ts line 40. Deploy window opens in 20 minutes.";

await check("noul", async () => {
  const r = await decide({ state, questions: { urgent: typedQuestion({ type: "noul", question: "Is this urgent?" }) } }, base);
  assert(typeof r.answers.urgent.noul === "number", "no noul probability");
  return `p=${r.answers.urgent.noul.toFixed(2)} model=${r.model}`;
});

await check("choice", async () => {
  const r = await decide({ state, questions: { team: typedQuestion({ type: "choice", question: "Who should handle this?", options: ["frontend", "backend", "devops"] }) } }, base);
  const a = r.answers.team;
  assert(["frontend", "backend", "devops"].includes(a.choice), "choice not among options");
  assert(a.probabilities && typeof a.confidence === "number", "no probabilities/confidence");
  return `choice=${a.choice} conf=${a.confidence.toFixed(2)}`;
});

await check("score", async () => {
  const r = await decide({ state, questions: { sev: typedQuestion({ type: "score", question: "How severe is this?", levels: ["low", "medium", "high"] }) } }, base);
  assert(r.answers.sev && r.answers.sev.type === "score", "no score answer");
  return JSON.stringify(Object.keys(r.answers.sev));
});

await check("batch (3 questions, one state)", async () => {
  const r = await decide(
    {
      state,
      questions: {
        a: typedQuestion({ type: "noul", question: "Does this mention a deadline?" }),
        b: typedQuestion({ type: "noul", question: "Is the error in test code?" }),
        c: typedQuestion({ type: "choice", question: "Fix type?", options: ["hotfix", "revert", "wait"] }),
      },
    },
    base,
  );
  assert(Object.keys(r.answers).length === 3, "expected 3 answers");
});

await check("fallback (bogus primary -> real model)", async () => {
  const r = await decide(
    { state, questions: { q: typedQuestion({ type: "noul", question: "Is this urgent?" }) } },
    { ...base, model: "inception/mercury-decide-does-not-exist", fallbacks: [DEFAULT_MODEL], retries: 0 },
  );
  assert(r.meta.fallbackUsed, "fallback was not used");
});

await check("route", async () => {
  const task = "Rename the config key retry_ms to retryMs across the repo and update the docs.";
  const r = await decide({ state: { task }, questions: buildQuestions() }, base);
  const rec = recommend(r.answers, undefined, { model: r.model });
  assert(typeof rec.tier === "string", "no tier");
  return `tier=${rec.tier} conf=${rec.confidence?.toFixed?.(2)}`;
});

await check("mcp decide tool", async () => {
  const r = await callTool("decide", { state, question: "Is this urgent?" }, base);
  assert(!r.isError, r.content?.[0]?.text);
});

await check("token estimate vs reported usage", async () => {
  // A code-heavy state built from this repo's own sources, trimmed to ~20k estimated tokens.
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  let text = ["../bin/decide.mjs", "../bin/mcp.mjs", "../bin/route.mjs", "../README.md"].map((p) => readFileSync(here(p), "utf8")).join("\n");
  const target = Math.floor(20000 * 3.5);
  while (text.length < target) text += "\n" + text;
  text = text.slice(0, target);
  const r = await decide({ state: text, questions: { q: typedQuestion({ type: "noul", question: "Is this text JavaScript source code?" }) } }, base);
  const est = estimateTokens(text);
  const actual = r.usage?.input_tokens;
  assert(Number.isFinite(actual), "no usage.input_tokens");
  return `estimate=${est} reported=${actual} ratio=${(actual / est).toFixed(2)}`;
});

const stats = computeStats(readLog(logPath));
console.log(`log: ${stats.calls} rows, ${stats.ok} ok, tokens routed ${stats.tokensRouted}, median ${stats.medianLatencyMs} ms`);
console.log(`smoke: ${calls - failures}/${calls} checks passed`);
process.exit(failures ? 1 : 0);
