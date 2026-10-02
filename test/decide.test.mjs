import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DEFAULT_MODEL,
  DecideError,
  computeStats,
  configFromEnv,
  decide,
  estimateTokens,
  parseState,
  readLog,
  truncateMiddle,
  typedQuestion,
} from "../bin/decide.mjs";
import { FAKE_KEY, mockServer, testOptions } from "./helpers.mjs";

const NOUL = { answer: { type: "noul", instructions: "Is this fine?" } };

test("success: request shape, auth header, answers returned", async () => {
  const server = await mockServer();
  try {
    const opts = testOptions(server);
    const result = await decide({ state: { a: 1 }, questions: NOUL }, opts);
    assert.equal(result.answers.answer.type, "noul");
    assert.equal(result.model, DEFAULT_MODEL);
    assert.equal(server.requests.length, 1);
    const { body, headers } = server.requests[0];
    assert.equal(body.model, DEFAULT_MODEL);
    assert.deepEqual(body.state, { a: 1 });
    assert.deepEqual(body.questions, NOUL);
    assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
  } finally {
    await server.close();
  }
});

test("accepts a bare `answer` response shape", async () => {
  const server = await mockServer([
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: { type: "noul", noul: 0.2 } }));
    },
  ]);
  try {
    const result = await decide({ state: "x", questions: NOUL }, testOptions(server));
    assert.equal(result.answers.answer.noul, 0.2);
  } finally {
    await server.close();
  }
});

test("retries 429 and 5xx with backoff, then succeeds", async () => {
  const server = await mockServer([429, 503]);
  try {
    const opts = testOptions(server);
    const result = await decide({ state: "x", questions: NOUL }, opts);
    assert.equal(server.requests.length, 3);
    assert.equal(result.meta.attempts, 3);
    const rows = readLog(opts.logPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempts, 3);
    assert.equal(rows[0].outcome, "ok");
  } finally {
    await server.close();
  }
});

test("a 400 is not retried", async () => {
  const server = await mockServer([400]);
  try {
    await assert.rejects(decide({ state: "x", questions: NOUL }, testOptions(server)), (e) => e.code === "failed");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("401 fails fast as an auth error and skips fallbacks", async () => {
  const server = await mockServer([401]);
  try {
    await assert.rejects(
      decide({ state: "x", questions: NOUL }, testOptions(server, { fallbacks: ["other/model"] })),
      (e) => e.code === "auth",
    );
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("fallback: primary exhausts its retries, the fallback model answers", async () => {
  const server = await mockServer([500, 500, 500]);
  try {
    const opts = testOptions(server, { fallbacks: ["fallback/one"] });
    const result = await decide({ state: "x", questions: NOUL }, opts);
    assert.equal(server.requests.length, 4);
    assert.equal(server.requests[3].body.model, "fallback/one");
    assert.equal(result.meta.fallbackUsed, true);
    assert.equal(result.model, "fallback/one");
    const [row] = readLog(opts.logPath);
    assert.equal(row.fallbackUsed, true);
    assert.equal(row.model, "fallback/one");
  } finally {
    await server.close();
  }
});

test("fallbacks run in order and a 4xx moves on without retrying", async () => {
  const server = await mockServer([404, 404]);
  try {
    const result = await decide({ state: "x", questions: NOUL }, testOptions(server, { model: "m/primary", fallbacks: ["m/two", "m/three"] }));
    assert.deepEqual(server.requests.map((r) => r.body.model), ["m/primary", "m/two", "m/three"]);
    assert.equal(result.model, "m/three");
  } finally {
    await server.close();
  }
});

test("all models failing is an error and is logged", async () => {
  const server = await mockServer([500, 500, 500, 500, 500, 500]);
  try {
    const opts = testOptions(server, { fallbacks: ["fallback/one"] });
    await assert.rejects(decide({ state: "x", questions: NOUL }, opts), (e) => e.code === "failed");
    const [row] = readLog(opts.logPath);
    assert.equal(row.outcome, "error");
    assert.equal(row.attempts, 6);
  } finally {
    await server.close();
  }
});

test("timeout: a hung server is aborted and retried", async () => {
  const server = await mockServer([
    () => {
      /* never answers */
    },
  ]);
  try {
    const started = Date.now();
    const result = await decide({ state: "x", questions: NOUL }, testOptions(server, { timeoutMs: 150 }));
    assert.equal(result.meta.attempts, 2);
    assert.ok(Date.now() - started < 1500);
  } finally {
    await server.close();
  }
});

test("oversize state without --truncate fails clearly and makes no request", async () => {
  const server = await mockServer();
  try {
    const big = "word ".repeat(40000); // ~57k tokens at 3.5 chars/token
    const opts = testOptions(server);
    await assert.rejects(decide({ state: big, questions: NOUL }, opts), (e) => {
      assert.equal(e.code, "state_too_large");
      assert.match(e.message, /truncate/);
      assert.match(e.message, /FALLBACKS/);
      return true;
    });
    assert.equal(server.requests.length, 0);
    assert.equal(readLog(opts.logPath)[0].error, "state_too_large");
  } finally {
    await server.close();
  }
});

test("oversize state with fallbacks skips the primary model", async () => {
  const server = await mockServer();
  try {
    const big = "word ".repeat(40000);
    const result = await decide({ state: big, questions: NOUL }, testOptions(server, { fallbacks: ["big/context"] }));
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].body.model, "big/context");
    assert.equal(server.requests[0].body.state.length, big.length);
    assert.equal(result.meta.skippedPrimary, true);
  } finally {
    await server.close();
  }
});

test("--truncate keeps head and tail and fits the budget", async () => {
  const server = await mockServer();
  try {
    const big = "HEADMARK " + "filler ".repeat(40000) + " TAILMARK";
    const opts = testOptions(server, { truncate: true });
    const result = await decide({ state: big, questions: NOUL }, opts);
    const sent = server.requests[0].body.state;
    assert.ok(sent.startsWith("HEADMARK"));
    assert.ok(sent.endsWith("TAILMARK"));
    assert.match(sent, /chars omitted by mercury-decide/);
    assert.ok(estimateTokens(sent) <= 28000);
    assert.equal(result.meta.truncated, true);
    assert.equal(readLog(opts.logPath)[0].truncated, true);
  } finally {
    await server.close();
  }
});

test("log rows carry metadata only: no state text, no questions, no key", async () => {
  const server = await mockServer();
  try {
    const opts = testOptions(server);
    const secretState = "PRIVATE-STATE-SENTINEL-93721";
    await decide({ state: secretState, questions: { q: { type: "noul", instructions: "QUESTION-SENTINEL-5521" } } }, opts);
    const raw = readFileSync(opts.logPath, "utf8");
    assert.ok(!raw.includes("SENTINEL"));
    assert.ok(!raw.includes(FAKE_KEY));
    assert.ok(!/authorization|bearer/i.test(raw));
    const [row] = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      Object.keys(row).sort(),
      ["attempts", "caller", "cost", "fallbackUsed", "inputTokens", "latencyMs", "model", "outcome", "outputTokens", "requestedModel", "requestTokens", "stateTokens", "truncated", "ts"].sort(),
    );
    assert.equal(row.outcome, "ok");
    assert.equal(row.inputTokens, 123);
    assert.ok(Number.isFinite(row.latencyMs));
    assert.ok(Date.parse(row.ts) > 0);
  } finally {
    await server.close();
  }
});

test("a log failure never breaks a call", async () => {
  const server = await mockServer();
  try {
    const result = await decide({ state: "x", questions: NOUL }, testOptions(server, { logPath: "Z:\\definitely\\not\\here\0\\calls.jsonl" }));
    assert.equal(result.answers.answer.type, "noul");
  } finally {
    await server.close();
  }
});

test("missing key is a clear error", async () => {
  const server = await mockServer();
  try {
    const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    delete process.env.OPENROUTER_API_KEY;
    process.env.HOME = process.env.USERPROFILE = tmpdir(); // a home with no ~/.typesafe_key
    try {
      await assert.rejects(decide({ state: "x", questions: NOUL }, testOptions(server, { key: undefined })), (e) => e.code === "no_key");
      assert.equal(server.requests.length, 0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  } finally {
    await server.close();
  }
});

test("stats: success rate, median latency, tokens routed", () => {
  const rows = [
    { outcome: "ok", latencyMs: 100, inputTokens: 50, model: "a" },
    { outcome: "ok", latencyMs: 300, requestTokens: 70, model: "a" },
    { outcome: "ok", latencyMs: 200, inputTokens: 10, model: "b", fallbackUsed: true },
    { outcome: "error", latencyMs: 9999, requestTokens: 5, model: "a" },
  ];
  const s = computeStats(rows);
  assert.equal(s.calls, 4);
  assert.equal(s.ok, 3);
  assert.equal(s.successRate, 0.75);
  assert.equal(s.medianLatencyMs, 200);
  assert.equal(s.tokensRouted, 135);
  assert.equal(s.fallbackUsed, 1);
  assert.deepEqual(computeStats([]).successRate, null);
});

test("config: MERCURY_DECIDE_MODEL beats JEV_MODEL, both beat the default", () => {
  assert.equal(configFromEnv({}).model, DEFAULT_MODEL);
  assert.equal(configFromEnv({ JEV_MODEL: "legacy/m" }).model, "legacy/m");
  assert.equal(configFromEnv({ JEV_MODEL: "legacy/m", MERCURY_DECIDE_MODEL: "new/m" }).model, "new/m");
  assert.deepEqual(configFromEnv({ MERCURY_DECIDE_FALLBACKS: " a/b , c/d ,," }).fallbacks, ["a/b", "c/d"]);
  assert.deepEqual(configFromEnv({}).fallbacks, []);
  assert.equal(configFromEnv({ MERCURY_DECIDE_ENDPOINT: "http://e" }).endpoint, "http://e");
  assert.equal(configFromEnv({ JEV_ENDPOINT: "http://j" }).endpoint, "http://j");
  assert.equal(configFromEnv({ MERCURY_DECIDE_LOG: "off" }).logPath, null);
});

test("helpers: typedQuestion, parseState, truncateMiddle", () => {
  assert.deepEqual(typedQuestion({ type: "choice", question: "q", options: ["a", "b"] }).criteria, { a: "a", b: "b" });
  assert.deepEqual(typedQuestion({ type: "score", question: "q", levels: ["lo", "hi"] }).criteria, ["lo", "hi"]);
  assert.throws(() => typedQuestion({ type: "choice", question: "q" }), DecideError);
  assert.throws(() => typedQuestion({ type: "bogus", question: "q" }), DecideError);
  assert.deepEqual(parseState('{"a":1}'), { a: 1 });
  assert.equal(parseState("42"), "42");
  assert.equal(parseState("plain text"), "plain text");
  const t = truncateMiddle("a".repeat(1000) + "b".repeat(1000), 500);
  assert.ok(t.length <= 500);
  assert.ok(t.startsWith("a") && t.endsWith("b"));
  assert.equal(truncateMiddle("short", 500), "short");
});

test("many questions over a big state are split so questions x state stays under the cap", async () => {
  const server = await mockServer();
  try {
    const state = "word ".repeat(17000); // ~24k tokens estimated
    const questions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` }]));
    const opts = testOptions(server);
    const result = await decide({ state, questions }, opts);
    assert.equal(Object.keys(result.answers).length, 40);
    assert.ok(server.requests.length >= 2);
    for (const { body } of server.requests) {
      assert.ok(Object.keys(body.questions).length * estimateTokens(body.state) <= 650000);
    }
    assert.equal(result.meta.chunks, server.requests.length);
    assert.equal(result.usage.input_tokens, 123 * server.requests.length);
    assert.equal(readLog(opts.logPath).length, server.requests.length);
    // a small state keeps all questions in one request
    const before = server.requests.length;
    await decide({ state: "short", questions }, testOptions(server));
    assert.equal(server.requests.length, before + 1);
  } finally {
    await server.close();
  }
});
