#!/usr/bin/env node
/**
 * mercury-decide - ask Inception's Mercury Decide a typed question.
 *
 * Mercury Decide is decision-only: you hand it a state and typed questions and it
 * returns typed answers with probabilities. It is served through OpenRouter's
 * Decisions API (POST /api/alpha/decisions) and the free tier costs nothing.
 *
 * Usage:
 *   decide --state "<text or JSON>" --questions '<questions JSON>'
 *   decide --state "..." --noul "Is this urgent?"
 *   decide --state "..." --choice "Which team?" --options billing,technical,sales
 *   decide --state "..." --score "How frustrated?" --levels Calm,Frustrated,Angry
 *   echo '<state>' | decide --noul "Does this mention an error?"
 *   decide --stats            # summary of the local call log
 *
 * Prints the answers JSON on stdout (--full prints model, usage and call metadata too).
 * Exit 0 on an answer, 1 on any failure.
 *
 * Auth: OPENROUTER_API_KEY, or the first line of ~/.typesafe_key. The key is only read
 * at call time. It is never logged, printed or stored.
 *
 * Environment (all optional):
 *   MERCURY_DECIDE_MODEL            primary model (default inception/mercury-decide:free)
 *   JEV_MODEL                       legacy alias for MERCURY_DECIDE_MODEL
 *   MERCURY_DECIDE_FALLBACKS        comma separated fallback models, tried in order
 *   MERCURY_DECIDE_ENDPOINT         endpoint override (JEV_ENDPOINT is a legacy alias)
 *   MERCURY_DECIDE_TIMEOUT_MS       per-request timeout, default 30000
 *   MERCURY_DECIDE_RETRIES          retries per model on 429/5xx/network errors, default 2
 *   MERCURY_DECIDE_BACKOFF_MS       first backoff delay, default 500 (doubles, with jitter)
 *   MERCURY_DECIDE_MAX_STATE_TOKENS primary model request budget, default 28000
 *   MERCURY_DECIDE_MAX_EVAL_TOKENS  cap on questions x state per request, default 600000;
 *                                   larger multi-question calls are split into sequential requests
 *   MERCURY_DECIDE_LOG              call log path (default ~/.mercury-decide/calls.jsonl;
 *                                   "off" disables logging)
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "inception/mercury-decide:free";
export const DEFAULT_MAX_STATE_TOKENS = 28000;
// Mercury evaluates every question against the whole state, so a request costs about
// questions x state tokens. Measured: ~870k tokens answered, ~1.0M was refused (HTTP 422).
export const DEFAULT_MAX_EVAL_TOKENS = 600000;
export const CHARS_PER_TOKEN = 3.5;
const REQUEST_OVERHEAD_TOKENS = 20;
const MAX_BACKOFF_MS = 15000;

export class DecideError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "DecideError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Configuration

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function defaultLogPath(env = process.env) {
  const override = env.MERCURY_DECIDE_LOG;
  if (override !== undefined) {
    return override === "" || override.toLowerCase() === "off" ? null : override;
  }
  return join(homedir(), ".mercury-decide", "calls.jsonl");
}

export function configFromEnv(env = process.env) {
  return {
    model: env.MERCURY_DECIDE_MODEL || env.JEV_MODEL || DEFAULT_MODEL,
    fallbacks: (env.MERCURY_DECIDE_FALLBACKS || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    endpoint: env.MERCURY_DECIDE_ENDPOINT || env.JEV_ENDPOINT || DEFAULT_ENDPOINT,
    timeoutMs: numberFrom(env.MERCURY_DECIDE_TIMEOUT_MS, 30000),
    retries: Math.max(0, Math.floor(numberFrom(env.MERCURY_DECIDE_RETRIES, 2))),
    backoffMs: Math.max(0, numberFrom(env.MERCURY_DECIDE_BACKOFF_MS, 500)),
    maxStateTokens: numberFrom(env.MERCURY_DECIDE_MAX_STATE_TOKENS, DEFAULT_MAX_STATE_TOKENS),
    maxEvalTokens: numberFrom(env.MERCURY_DECIDE_MAX_EVAL_TOKENS, DEFAULT_MAX_EVAL_TOKENS),
    logPath: defaultLogPath(env),
    truncate: false,
  };
}

/** Reads the API key at call time: OPENROUTER_API_KEY, else ~/.typesafe_key. Never logged. */
export function readKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY.trim();
  try {
    const value = readFileSync(join(homedir(), ".typesafe_key"), "utf8").trim();
    if (value) return value.split(/\r?\n/)[0].trim();
  } catch {
    /* no key file */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Token estimate, truncation

export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
}

/** Keeps the head and tail of `text` so that it fits `maxChars`, with a marker in between. */
export function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = (omitted) => `\n[... ${omitted} chars omitted by mercury-decide ...]\n`;
  const reserve = marker(text.length).length;
  const room = Math.max(0, maxChars - reserve);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + marker(omitted) + (tail > 0 ? text.slice(text.length - tail) : "");
}

// ---------------------------------------------------------------------------
// Question builders

export function typedQuestion({ type = "noul", question, options, criteria, levels }) {
  if (typeof question !== "string" || !question.trim()) {
    throw new DecideError("question text is required", "bad_input");
  }
  if (type === "noul" || type === "yes-no" || type === "yesno") {
    return { type: "noul", instructions: question };
  }
  if (type === "choice") {
    let map = criteria && typeof criteria === "object" && !Array.isArray(criteria) ? criteria : undefined;
    if (!map && Array.isArray(options) && options.length) {
      map = Object.fromEntries(options.map((option) => [String(option), String(option)]));
    }
    if (!map || !Object.keys(map).length) {
      throw new DecideError("a choice question needs options (or a criteria map)", "bad_input");
    }
    return { type: "choice", instructions: question, criteria: map };
  }
  if (type === "score") {
    if (!Array.isArray(levels) || !levels.length) {
      throw new DecideError("a score question needs levels", "bad_input");
    }
    return { type: "score", instructions: question, criteria: levels.map(String) };
  }
  throw new DecideError(`unknown question type "${type}" (use noul, choice or score)`, "bad_input");
}

/** A state given as a JSON object/array string becomes the object; anything else stays text. */
export function parseState(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* plain text */
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Call log (append-only JSONL: metadata only, never state text, questions or keys)

export function appendLog(path, row) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* logging must never break a call */
  }
}

export function readLog(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a damaged line */
    }
  }
  return rows;
}

export function computeStats(rows) {
  const ok = rows.filter((row) => row.outcome === "ok");
  const latencies = ok.map((row) => row.latencyMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
  let median = null;
  if (latencies.length) {
    const mid = Math.floor(latencies.length / 2);
    median = latencies.length % 2 ? latencies[mid] : Math.round((latencies[mid - 1] + latencies[mid]) / 2);
  }
  const tokensRouted = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.inputTokens) ? row.inputTokens : row.requestTokens || 0),
    0,
  );
  const byModel = {};
  for (const row of rows) byModel[row.model] = (byModel[row.model] || 0) + 1;
  return {
    calls: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    successRate: rows.length ? ok.length / rows.length : null,
    medianLatencyMs: median,
    tokensRouted,
    fallbackUsed: rows.filter((row) => row.fallbackUsed).length,
    truncated: rows.filter((row) => row.truncated).length,
    byModel,
    first: rows[0]?.ts ?? null,
    last: rows[rows.length - 1]?.ts ?? null,
  };
}

// ---------------------------------------------------------------------------
// The call

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function redactor(key) {
  return (text) => {
    let out = String(text ?? "");
    if (key) out = out.split(key).join("[redacted]");
    return out;
  };
}

function normalizeAnswers(parsed) {
  if (!parsed || typeof parsed !== "object") return undefined;
  if (parsed.answers && typeof parsed.answers === "object") return parsed.answers;
  if (parsed.answer && typeof parsed.answer === "object") return { answer: parsed.answer };
  return undefined;
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), MAX_BACKOFF_MS);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), MAX_BACKOFF_MS) : undefined;
}

/**
 * One request to one model. Returns {kind:"ok", ...} or {kind:"retry"|"next"|"fatal", status, note}.
 */
async function attemptOnce({ fetchImpl, endpoint, key, model, state, questions, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === "AbortError";
    return { kind: "retry", status: 0, note: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
  const status = response.status;
  if (status === 200 || (response.ok && status < 300)) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "retry", status, note: "bad_json" };
    }
    const answers = normalizeAnswers(parsed);
    if (!answers) return { kind: "next", status, note: "no_answers" };
    return { kind: "ok", status, parsed, answers };
  }
  if (status === 429 || status >= 500) {
    return { kind: "retry", status, note: `http_${status}`, retryAfter: retryAfterMs(response.headers) };
  }
  if (status === 401 || status === 403) return { kind: "fatal", status, note: `http_${status}` };
  return { kind: "next", status, note: `http_${status}` };
}

/**
 * Asks Mercury Decide. `request` is {state, questions}; `options` overrides the environment config.
 * Resolves to {answers, model, usage, provider, meta}. Rejects with DecideError (code: no_key,
 * bad_input, state_too_large, auth, failed). Every call, success or not, appends one metadata row to
 * the call log.
 */
export async function decide(request, options = {}) {
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const cfg = { ...configFromEnv(), ...defined };
  const started = Date.now();
  const caller = cfg.caller || "api";
  const questions = request.questions;
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length) {
    throw new DecideError("no questions given", "bad_input");
  }
  if (request.state === undefined || request.state === null || request.state === "") {
    throw new DecideError("no state given", "bad_input");
  }
  // Several questions over a big state: split so that questions x state stays under the cap.
  const questionEntries = Object.entries(questions);
  if (questionEntries.length > 1) {
    const stateTokensGuess = Math.min(
      estimateTokens(typeof request.state === "string" ? request.state : JSON.stringify(request.state)),
      cfg.maxStateTokens,
    );
    const perChunk = Math.max(1, Math.floor(cfg.maxEvalTokens / (stateTokensGuess + REQUEST_OVERHEAD_TOKENS + 40)));
    if (perChunk < questionEntries.length) {
      const parts = [];
      for (let i = 0; i < questionEntries.length; i += perChunk) {
        parts.push(await decide({ state: request.state, questions: Object.fromEntries(questionEntries.slice(i, i + perChunk)) }, { ...options, caller }));
      }
      const sum = (pick) => parts.reduce((total, part) => total + (pick(part) || 0), 0);
      return {
        answers: Object.assign({}, ...parts.map((part) => part.answers)),
        model: parts[0].model,
        usage: parts.some((part) => part.usage)
          ? { input_tokens: sum((p) => p.usage?.input_tokens), output_tokens: sum((p) => p.usage?.output_tokens), cost: sum((p) => p.usage?.cost) }
          : null,
        provider: parts[0].provider,
        meta: {
          ...parts[0].meta,
          chunks: parts.length,
          attempts: sum((p) => p.meta.attempts),
          fallbackUsed: parts.some((part) => part.meta.fallbackUsed),
          truncated: parts.some((part) => part.meta.truncated),
          latencyMs: Date.now() - started,
        },
      };
    }
  }

  const key = cfg.key ?? readKey();
  const redact = redactor(key);
  const fetchImpl = cfg.fetch || globalThis.fetch;

  let state = request.state;
  let stateText = typeof state === "string" ? state : JSON.stringify(state);
  const questionsTokens = estimateTokens(JSON.stringify(questions));
  let stateTokens = estimateTokens(stateText);
  const originalStateTokens = stateTokens;
  const budget = cfg.maxStateTokens;
  let truncated = false;
  let chain = [cfg.model, ...cfg.fallbacks].filter((m, i, all) => m && all.indexOf(m) === i);
  let skippedPrimary = false;

  const finish = (row) => {
    appendLog(cfg.logPath, {
      ts: new Date().toISOString(),
      caller,
      latencyMs: Date.now() - started,
      stateTokens: originalStateTokens,
      requestTokens: stateTokens + questionsTokens + REQUEST_OVERHEAD_TOKENS,
      truncated,
      ...row,
    });
  };

  if (stateTokens + questionsTokens + REQUEST_OVERHEAD_TOKENS > budget) {
    if (cfg.truncate) {
      const roomTokens = budget - questionsTokens - REQUEST_OVERHEAD_TOKENS;
      if (roomTokens < 200) {
        finish({ model: chain[0], outcome: "error", error: "state_too_large" });
        throw new DecideError("the questions alone leave no room for state within the token budget", "state_too_large");
      }
      stateText = truncateMiddle(stateText, Math.floor(roomTokens * CHARS_PER_TOKEN));
      state = stateText;
      stateTokens = estimateTokens(stateText);
      truncated = true;
    } else if (cfg.fallbacks.length) {
      chain = chain.filter((model) => model !== cfg.model);
      skippedPrimary = true;
    } else {
      finish({ model: chain[0], outcome: "error", error: "state_too_large" });
      throw new DecideError(
        `state is ~${stateTokens + questionsTokens} tokens, over the ~${budget} token budget for ${cfg.model} ` +
          "(32k context). Shorten it, pass --truncate to keep the head and tail, " +
          "or set MERCURY_DECIDE_FALLBACKS to a larger-context model.",
        "state_too_large",
        { estimatedTokens: stateTokens + questionsTokens, budget },
      );
    }
  }

  if (!key) {
    finish({ model: chain[0], outcome: "error", error: "no_key" });
    throw new DecideError("no API key (set OPENROUTER_API_KEY, or put it in ~/.typesafe_key)", "no_key");
  }

  const attempts = [];
  let lastNote = "no_model";
  for (const model of chain) {
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      const t0 = Date.now();
      const result = await attemptOnce({
        fetchImpl,
        endpoint: cfg.endpoint,
        key,
        model,
        state,
        questions,
        timeoutMs: cfg.timeoutMs,
      });
      attempts.push({ model, status: result.status, ms: Date.now() - t0, note: result.note });
      if (result.kind === "ok") {
        const usage = result.parsed.usage && typeof result.parsed.usage === "object" ? result.parsed.usage : null;
        const fallbackUsed = model !== cfg.model;
        const answeredBy = typeof result.parsed.model === "string" ? result.parsed.model : model;
        finish({
          model: answeredBy,
          requestedModel: model,
          outcome: "ok",
          attempts: attempts.length,
          fallbackUsed: fallbackUsed || skippedPrimary,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cost: usage?.cost,
        });
        return {
          answers: result.answers,
          model: answeredBy,
          usage,
          provider: result.parsed.provider ?? null,
          meta: {
            requestedModel: model,
            attempts: attempts.length,
            fallbackUsed,
            skippedPrimary,
            truncated,
            latencyMs: Date.now() - started,
            stateTokens: originalStateTokens,
          },
        };
      }
      lastNote = result.note;
      if (result.kind === "fatal") {
        finish({ model, outcome: "error", error: result.note, attempts: attempts.length });
        throw new DecideError(
          `authentication failed (HTTP ${result.status}); check OPENROUTER_API_KEY`,
          "auth",
          { status: result.status },
        );
      }
      if (result.kind === "next") break;
      if (attempt < cfg.retries) {
        const exp = cfg.backoffMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
        await sleep(Math.min(result.retryAfter ?? exp, MAX_BACKOFF_MS));
      }
    }
  }
  finish({
    model: chain[0] ?? cfg.model,
    outcome: "error",
    error: lastNote,
    attempts: attempts.length,
    fallbackUsed: chain.length > 1 || skippedPrimary,
  });
  throw new DecideError(
    redact(
      `all models failed (${attempts.map((a) => `${a.model}:${a.note}`).join(", ") || "none tried"})`,
    ),
    "failed",
    { attempts },
  );
}

// ---------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = new Set([
  "state", "file", "noul", "choice", "options", "score", "levels", "questions",
  "model", "fallbacks", "endpoint", "timeout", "retries", "max-tokens",
]);
const BOOL_FLAGS = new Set(["truncate", "stats", "full", "json", "help", "version"]);

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new DecideError(`unexpected argument "${token}"`, "bad_input");
    let name = token.slice(2);
    let inline;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (name === "choices") name = "options";
    if (BOOL_FLAGS.has(name)) {
      flags[name] = inline === undefined ? true : inline !== "false";
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new DecideError(`--${name} needs a value`, "bad_input");
      flags[name] = value;
    } else {
      throw new DecideError(`unknown flag --${name} (see --help)`, "bad_input");
    }
  }
  return flags;
}

function splitList(raw) {
  return raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : undefined;
}

export function questionsFromFlags(flags) {
  if (flags.questions) {
    try {
      return JSON.parse(flags.questions);
    } catch {
      throw new DecideError("--questions is not valid JSON", "bad_input");
    }
  }
  if (flags.noul) return { answer: typedQuestion({ type: "noul", question: flags.noul }) };
  if (flags.choice) {
    const options = splitList(flags.options);
    if (!options?.length) throw new DecideError("--choice needs --options a,b,c", "bad_input");
    return { answer: typedQuestion({ type: "choice", question: flags.choice, options }) };
  }
  if (flags.score) {
    const levels = splitList(flags.levels);
    if (!levels?.length) throw new DecideError("--score needs --levels low,mid,high", "bad_input");
    return { answer: typedQuestion({ type: "score", question: flags.score, levels }) };
  }
  throw new DecideError("pass --questions JSON, or --noul / --choice / --score", "bad_input");
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

const HELP = `mercury-decide ${VERSION} - typed decisions from Inception's Mercury Decide

  decide --state "<text|JSON>" --noul "Is this urgent?"
  decide --state "..." --choice "Which team?" --options billing,technical,sales
  decide --state "..." --score "How frustrated?" --levels Calm,Frustrated,Angry
  decide --state "..." --questions '{"q":{"type":"noul","instructions":"..."}}'
  cat state.txt | decide --noul "Does this mention an error?"
  decide --stats [--json]

State comes from --state, --file <path>, or stdin.
Other flags: --model, --fallbacks a,b, --endpoint, --timeout <ms>, --retries <n>,
  --max-tokens <n>, --truncate (keep head+tail of an oversized state), --full.
Key: OPENROUTER_API_KEY, or ~/.typesafe_key. See README for the MERCURY_DECIDE_* variables.`;

export async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    console.error(`mercury-decide: ${error.message}`);
    return 1;
  }
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags.stats) {
    const path = defaultLogPath();
    if (!path) {
      console.error("mercury-decide: logging is disabled (MERCURY_DECIDE_LOG=off)");
      return 1;
    }
    const stats = computeStats(readLog(path));
    if (flags.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      const pct = stats.successRate === null ? "n/a" : `${(stats.successRate * 100).toFixed(1)}%`;
      console.log(`log:             ${path}`);
      console.log(`calls:           ${stats.calls} (${stats.ok} ok, ${stats.failed} failed)`);
      console.log(`success rate:    ${pct}`);
      console.log(`median latency:  ${stats.medianLatencyMs === null ? "n/a" : `${stats.medianLatencyMs} ms`} (successful calls)`);
      console.log(`tokens routed:   ${stats.tokensRouted}`);
      console.log(`fallback used:   ${stats.fallbackUsed}   truncated: ${stats.truncated}`);
      for (const [model, count] of Object.entries(stats.byModel)) console.log(`  ${model}: ${count}`);
    }
    return 0;
  }

  let stateRaw = flags.state;
  if (stateRaw === undefined && flags.file) {
    try {
      stateRaw = readFileSync(flags.file, "utf8");
    } catch (error) {
      console.error(`mercury-decide: cannot read --file (${error.code || "error"})`);
      return 1;
    }
  }
  if (stateRaw === undefined) stateRaw = readStdin();
  if (!stateRaw) {
    console.error("mercury-decide: no state (pass --state, --file, or pipe it on stdin)");
    return 1;
  }

  try {
    const questions = questionsFromFlags(flags);
    const result = await decide(
      { state: parseState(stateRaw), questions },
      {
        caller: "cli",
        model: flags.model,
        fallbacks: flags.fallbacks ? splitList(flags.fallbacks) : undefined,
        endpoint: flags.endpoint,
        timeoutMs: flags.timeout !== undefined ? numberFrom(flags.timeout, undefined) : undefined,
        retries: flags.retries !== undefined ? Math.max(0, numberFrom(flags.retries, 2)) : undefined,
        maxStateTokens: flags["max-tokens"] !== undefined ? numberFrom(flags["max-tokens"], undefined) : undefined,
        truncate: flags.truncate ? true : undefined,
      },
    );
    if (flags.full) {
      console.log(JSON.stringify(
        { answers: result.answers, model: result.model, usage: result.usage, provider: result.provider, meta: result.meta },
        null,
        2,
      ));
    } else {
      console.log(JSON.stringify(result.answers, null, 2));
    }
    return 0;
  } catch (error) {
    console.error(`mercury-decide: ${error.message}`);
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

if (isMain()) {
  process.exitCode = await main();
}
