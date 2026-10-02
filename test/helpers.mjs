import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_KEY = "TESTKEY-not-a-real-credential-0000";

/** Canned answer for one typed question, shaped like the Decisions API. */
export function cannedAnswer(question) {
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.7 : 0.3 / Math.max(1, options.length - 1)]));
    return { type: "choice", choice: options[0], probabilities, confidence: 0.4 };
  }
  if (question.type === "score") {
    return { type: "score", score: question.criteria[0], probabilities: Object.fromEntries(question.criteria.map((c) => [c, 1 / question.criteria.length])) };
  }
  return { type: "noul", noul: 0.9 };
}

/**
 * A mock Decisions API. `script` is an array of handlers/status codes consumed one request at a
 * time; when exhausted, requests succeed. Every request body is recorded in `server.requests`.
 */
export async function mockServer(script = []) {
  const requests = [];
  const queue = [...script];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      requests.push({ body, headers: req.headers, raw });
      const step = queue.shift();
      if (typeof step === "function") return step(req, res, body);
      if (typeof step === "number") {
        res.writeHead(step, step === 429 ? { "retry-after": "0" } : {});
        return res.end(JSON.stringify({ error: { message: `mock ${step}` } }));
      }
      const answers = Object.fromEntries(Object.entries(body.questions || {}).map(([k, q]) => [k, cannedAnswer(q)]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 123, output_tokens: 4, cost: 0 }, provider: "mock" }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/decisions`;
  return { url, requests, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) };
}

export function tempLog() {
  return join(mkdtempSync(join(tmpdir(), "mercury-decide-test-")), "calls.jsonl");
}

/** Base options for decide(): fake key, tiny backoff, private log. Never touches the real key or log. */
export function testOptions(server, extra = {}) {
  return {
    key: FAKE_KEY,
    endpoint: server.url,
    backoffMs: 1,
    timeoutMs: 2000,
    retries: 2,
    logPath: tempLog(),
    fallbacks: [],
    ...extra,
  };
}

/** Environment for child processes: no real key or log, endpoint pointed at the mock. */
export function childEnv(server, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(MERCURY_|JEV_|OPENROUTER_|TYPESAFE_)/.test(name)) delete env[name];
  return {
    ...env,
    OPENROUTER_API_KEY: FAKE_KEY,
    MERCURY_DECIDE_ENDPOINT: server.url,
    MERCURY_DECIDE_LOG: tempLog(),
    MERCURY_DECIDE_BACKOFF_MS: "1",
    MERCURY_DECIDE_TIMEOUT_MS: "3000",
    PYTHONIOENCODING: "utf-8",
    // keep a developer's real ~/.typesafe_key out of child runs
    HOME: tmpdir(),
    USERPROFILE: tmpdir(),
    ...extra,
  };
}
