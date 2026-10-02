import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLog } from "../bin/decide.mjs";
import { recommend, DEFAULT_TIERS } from "../bin/route.mjs";
import { callTool, handleMessage, TOOLS } from "../bin/mcp.mjs";
import { FAKE_KEY, childEnv, mockServer, testOptions } from "./helpers.mjs";

const bin = (name) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));

// Async on purpose: the mock server lives in this process, so a blocking spawnSync would starve it.
function run(file, args, { env, input } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin(file), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 30000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

test("cli: --noul, --choice and --score build the typed questions", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server);
    let r = await run("decide.mjs", ["--state", "build is red", "--noul", "Is this urgent?"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).answer.type, "noul");
    r = await run("decide.mjs", ["--state", '{"a":1}', "--choice", "Which team?", "--options", "billing,technical,sales"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).answer.choice, "billing");
    r = await run("decide.mjs", ["--state", "x", "--score", "How angry?", "--levels", "Calm,Angry"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).answer.type, "score");
    const [a, b, c] = server.requests.map((q) => q.body);
    assert.deepEqual(a.questions.answer, { type: "noul", instructions: "Is this urgent?" });
    assert.deepEqual(b.state, { a: 1 });
    assert.deepEqual(b.questions.answer.criteria, { billing: "billing", technical: "technical", sales: "sales" });
    assert.deepEqual(c.questions.answer.criteria, ["Calm", "Angry"]);
  } finally {
    await server.close();
  }
});

test("cli: stdin state, --questions JSON, JEV_MODEL alias, --full, --model", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server, { JEV_MODEL: "legacy/model" });
    let r = await run("decide.mjs", ["--questions", '{"q1":{"type":"noul","instructions":"ok?"}}'], { env, input: "state from stdin" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).q1);
    assert.equal(server.requests[0].body.state, "state from stdin");
    assert.equal(server.requests[0].body.model, "legacy/model");
    r = await run("decide.mjs", ["--state", "x", "--noul", "q", "--model", "flag/model", "--full"], { env });
    assert.equal(r.status, 0, r.stderr);
    const full = JSON.parse(r.stdout);
    assert.equal(full.model, "flag/model");
    assert.equal(full.usage.input_tokens, 123);
    assert.equal(server.requests[1].body.model, "flag/model");
  } finally {
    await server.close();
  }
});

test("cli: --file, bad flags and missing pieces exit 1 with a message", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server);
    const file = join(tmpdir(), `md-state-${process.pid}.txt`);
    writeFileSync(file, "state in a file");
    let r = await run("decide.mjs", ["--file", file, "--noul", "q"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(server.requests[0].body.state, "state in a file");
    r = await run("decide.mjs", ["--state", "x"], { env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--noul/);
    r = await run("decide.mjs", ["--state", "x", "--choice", "q"], { env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--options/);
    r = await run("decide.mjs", ["--bogus"], { env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
    r = await run("decide.mjs", ["--noul", "q"], { env, input: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no state/);
  } finally {
    await server.close();
  }
});

test("cli: oversize + --truncate / failure output never contains the key; --stats reads the log", async () => {
  const server = await mockServer([500, 500, 500]);
  try {
    const env = childEnv(server, { MERCURY_DECIDE_RETRIES: "2" });
    const big = "x ".repeat(80000);
    let r = await run("decide.mjs", ["--noul", "q"], { env, input: big });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /over the ~28000 token budget/);
    r = await run("decide.mjs", ["--noul", "q", "--truncate", "--full"], { env, input: "small state" });
    assert.equal(r.status, 1); // the scripted 500s exhaust the retries
    assert.ok(!r.stderr.includes(FAKE_KEY) && !r.stdout.includes(FAKE_KEY));
    r = await run("decide.mjs", ["--noul", "q", "--truncate", "--full"], { env, input: big });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).meta.truncated, true);
    r = await run("decide.mjs", ["--stats"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /calls:\s+3 \(1 ok, 2 failed\)/);
    assert.match(r.stdout, /success rate:\s+33\.3%/);
    r = await run("decide.mjs", ["--stats", "--json"], { env });
    const stats = JSON.parse(r.stdout);
    assert.equal(stats.calls, 3);
    assert.equal(stats.tokensRouted > 0, true);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// MCP

function startMcp(env) {
  const child = spawn(process.execPath, [bin("mcp.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
    let i;
    while ((i = out.indexOf("\n")) !== -1) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      const message = JSON.parse(line); // every stdout line must be valid JSON-RPC
      const waiter = waiters.shift();
      if (waiter) waiter(message);
    }
  });
  const next = () => new Promise((done) => waiters.push(done));
  const call = async (message) => {
    const reply = next();
    child.stdin.write(JSON.stringify(message) + "\n");
    return reply;
  };
  return { child, call, notify: (m) => child.stdin.write(JSON.stringify(m) + "\n"), close: () => child.kill() };
}

test("mcp stdio: initialize, tools/list, decide, decide_batch, errors", async () => {
  const server = await mockServer();
  const mcp = startMcp(childEnv(server));
  try {
    const init = await mcp.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "mercury-decide");
    assert.ok(init.result.capabilities.tools);
    mcp.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await mcp.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.result.tools.map((t) => t.name), ["decide", "decide_batch"]);
    assert.ok(list.result.tools.every((t) => t.inputSchema.type === "object"));

    const one = await mcp.call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: { state: "tests failing on main", question: "Is this urgent?" } } });
    assert.ok(!one.result.isError);
    const parsed = JSON.parse(one.result.content[0].text);
    assert.equal(parsed.answer.type, "noul");
    assert.equal(parsed.answer.verdict, "yes");
    assert.equal(one.result.structuredContent.answer.type, "noul");

    const batch = await mcp.call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "decide_batch",
        arguments: {
          state: '{"task":"fix login"}',
          questions: [
            { id: "web", question: "Needs the web?" },
            { type: "choice", question: "Which tier?", options: ["heavy", "light"] },
          ],
        },
      },
    });
    const answers = JSON.parse(batch.result.content[0].text).answers;
    assert.deepEqual(Object.keys(answers), ["web", "q2"]);
    assert.equal(answers.q2.choice, "heavy");
    const sent = server.requests.at(-1).body;
    assert.deepEqual(sent.state, { task: "fix login" });
    assert.deepEqual(Object.keys(sent.questions), ["web", "q2"]);

    const bad = await mcp.call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "decide", arguments: { state: "x" } } });
    assert.equal(bad.result.isError, true);
    const unknown = await mcp.call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
    assert.equal(unknown.result.isError, true);
    const missing = await mcp.call({ jsonrpc: "2.0", id: 7, method: "does/not/exist" });
    assert.equal(missing.error.code, -32601);
    const ping = await mcp.call({ jsonrpc: "2.0", id: 8, method: "ping" });
    assert.deepEqual(ping.result, {});
    const key = JSON.stringify([init, list, one, batch, bad, unknown, missing]);
    assert.ok(!key.includes(FAKE_KEY));
  } finally {
    mcp.close();
    await server.close();
  }
});

test("mcp: handleMessage ignores notifications and rejects garbage; tool errors are not thrown", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal((await handleMessage({ foo: 1, id: 3 })).error.code, -32600);
  assert.equal(TOOLS.length, 2);
  const server = await mockServer([401]);
  try {
    const r = await callTool("decide", { state: "x", question: "q" }, testOptions(server));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /authentication failed/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// route

test("route: one request asks tier + three yes/no questions and prints advisory JSON", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server);
    const r = await run("route.mjs", [], { env, input: "Refactor the retry policy for the ingest queue and deploy it to prod." });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.advisory, true);
    assert.equal(out.tier, "heavy-reasoning"); // mock picks the first criteria key
    assert.equal(out.needsWeb.value, true);
    assert.equal(out.touchesProduction.value, true);
    assert.ok(out.notes.some((n) => /production/.test(n)));
    const sent = server.requests[0].body;
    assert.deepEqual(Object.keys(sent.questions), ["tier", "needs_web", "needs_images", "touches_production"]);
    assert.deepEqual(Object.keys(sent.questions.tier.criteria), ["heavy-reasoning", "standard-coding", "mechanical-small"]);
    assert.equal(sent.state.task.startsWith("Refactor"), true);
  } finally {
    await server.close();
  }
});

test("route: --file, custom --tiers with model slugs, no input fails", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server);
    const task = join(tmpdir(), `md-task-${process.pid}.md`);
    const tiers = join(tmpdir(), `md-tiers-${process.pid}.json`);
    writeFileSync(task, "rename a variable");
    writeFileSync(tiers, JSON.stringify({ cheap: { criteria: "easy", model: "m/cheap" }, pricey: { criteria: "hard", model: "m/pricey" } }));
    let r = await run("route.mjs", ["--file", task, "--tiers", tiers], { env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.tier, "cheap");
    assert.equal(out.suggestedModel, "m/cheap");
    r = await run("route.mjs", [], { env, input: "" });
    assert.equal(r.status, 1);
  } finally {
    await server.close();
  }
});

test("route: recommend() flags low confidence and rejects unusable tiers", () => {
  const answers = {
    tier: { type: "choice", choice: "standard-coding", probabilities: { "standard-coding": 0.51 }, confidence: 0.02 },
    needs_web: { type: "noul", noul: 0.1 },
    needs_images: { type: "noul", noul: 0.8 },
    touches_production: { type: "noul", noul: 0.2 },
  };
  const rec = recommend(answers, DEFAULT_TIERS, { model: "m" });
  assert.equal(rec.lowConfidence, true);
  assert.equal(rec.needsImages.value, true);
  assert.equal(rec.needsWeb.value, false);
  assert.throws(() => recommend({ tier: { choice: "not-a-tier" } }), /usable tier/);
});

test("the shipped files contain no key material", () => {
  for (const name of ["decide.mjs", "mcp.mjs", "route.mjs"]) {
    const text = readFileSync(bin(name), "utf8");
    assert.ok(!new RegExp("sk" + "-or" + "-[A-Za-z0-9]").test(text), name);
  }
});

test("log rows from child processes carry the caller", async () => {
  const server = await mockServer();
  try {
    const env = childEnv(server);
    await run("route.mjs", ["rename x"], { env });
    await run("decide.mjs", ["--state", "s", "--noul", "q"], { env });
    const rows = readLog(env.MERCURY_DECIDE_LOG);
    assert.deepEqual(rows.map((row) => row.caller), ["route", "cli"]);
  } finally {
    await server.close();
  }
});
