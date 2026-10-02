#!/usr/bin/env node
/**
 * mercury-decide MCP server (stdio, dependency-free JSON-RPC 2.0).
 *
 * Implements initialize, ping, tools/list and tools/call, with newline-delimited JSON
 * messages on stdin/stdout. Nothing but protocol messages is ever written to stdout; any
 * diagnostics go to stderr.
 *
 * Tools:
 *   decide        one state + one typed question (noul | choice | score) -> typed answer
 *   decide_batch  several typed questions about one state in a single call
 *
 * Auth and configuration are the same as the CLI: OPENROUTER_API_KEY (or ~/.typesafe_key)
 * and the MERCURY_DECIDE_* variables. The key is read at call time and never echoed.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DecideError, VERSION, decide, parseState, typedQuestion } from "./decide.mjs";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const QUESTION_PROPS = {
  type: {
    type: "string",
    enum: ["noul", "choice", "score"],
    description: "noul = yes/no probability, choice = pick one option, score = rate on ordered levels. Default noul.",
  },
  question: { type: "string", description: "The question to ask about the state." },
  options: {
    type: "array",
    items: { type: "string" },
    description: "For type=choice: the candidate options.",
  },
  criteria: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "For type=choice: option name -> description of when to pick it (alternative to options).",
  },
  levels: {
    type: "array",
    items: { type: "string" },
    description: "For type=score: ordered levels, lowest first.",
  },
};

export const TOOLS = [
  {
    name: "decide",
    description:
      "Ask Mercury Decide (a fast, free, decision-only model, 32k context) one typed question about a state. " +
      "Returns a typed answer with probabilities: noul -> probability of yes; choice -> chosen option, " +
      "per-option probabilities and confidence; score -> level with probabilities. Use it for cheap mechanical " +
      "decisions (classify, route, yes/no), not for prose or analysis.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "The situation to decide about: plain text, or a JSON object/array encoded as a string. Keep under ~25k tokens.",
        },
        ...QUESTION_PROPS,
        model: { type: "string", description: "Optional model override." },
      },
      required: ["state", "question"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "decide_batch",
    description:
      "Ask Mercury Decide several typed questions about the same state in one call. Cheaper and faster than " +
      "calling decide repeatedly. Each question has an optional id; answers come back keyed by id.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "The shared state: plain text, or a JSON object/array encoded as a string." },
        questions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { id: { type: "string", description: "Key for this question's answer (default q1, q2, ...)." }, ...QUESTION_PROPS },
            required: ["question"],
          },
          description: "The questions to ask.",
        },
        model: { type: "string", description: "Optional model override." },
      },
      required: ["state", "questions"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

/** Adds a plain reading of each answer without removing any of the raw fields. */
export function annotateAnswer(answer) {
  if (!answer || typeof answer !== "object") return answer;
  if (answer.type === "noul" && typeof answer.noul === "number") {
    return { ...answer, verdict: answer.noul >= 0.5 ? "yes" : "no" };
  }
  return answer;
}

function asText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resultView(result) {
  return { model: result.model, usage: result.usage, truncated: result.meta.truncated, fallbackUsed: result.meta.fallbackUsed };
}

export async function callTool(name, args = {}, options = {}) {
  try {
    if (name === "decide") {
      const question = typedQuestion({
        type: args.type || "noul",
        question: args.question,
        options: args.options,
        criteria: args.criteria,
        levels: args.levels,
      });
      const result = await decide(
        { state: parseState(args.state), questions: { answer: question } },
        { caller: "mcp", model: args.model || undefined, truncate: true, ...options },
      );
      return asText({ answer: annotateAnswer(result.answers.answer ?? Object.values(result.answers)[0]), ...resultView(result) });
    }
    if (name === "decide_batch") {
      if (!Array.isArray(args.questions) || !args.questions.length) {
        return toolError("questions must be a non-empty array");
      }
      const questions = {};
      args.questions.forEach((q, index) => {
        const id = typeof q.id === "string" && q.id ? q.id : `q${index + 1}`;
        if (questions[id]) throw new DecideError(`duplicate question id "${id}"`, "bad_input");
        questions[id] = typedQuestion({ ...q, type: q.type || "noul" });
      });
      const result = await decide(
        { state: parseState(args.state), questions },
        { caller: "mcp", model: args.model || undefined, truncate: true, ...options },
      );
      const answers = Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, annotateAnswer(a)]));
      return asText({ answers, ...resultView(result) });
    }
    return toolError(`unknown tool "${name}"`);
  } catch (error) {
    return toolError(`mercury-decide: ${error?.message || String(error)}`);
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Handles one JSON-RPC message; resolves to a response object, or undefined for notifications. */
export async function handleMessage(message, options = {}) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    // A response or garbage from the client: ignore responses, flag anything else.
    if (message && typeof message === "object" && ("result" in message || "error" in message)) return undefined;
    return rpcError(message?.id, -32600, "Invalid Request");
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mercury-decide", version: VERSION },
          instructions: "Typed decisions (yes/no, choice, score) from Mercury Decide. Use decide for one question, decide_batch for several about the same state.",
        },
      };
    }
    case "ping":
      return isNotification ? undefined : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      if (typeof params?.name !== "string") return rpcError(id, -32602, "tools/call needs a tool name");
      return { jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments || {}, options) };
    }
    default:
      if (isNotification || method.startsWith("notifications/")) return undefined;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function serve(input = process.stdin, output = process.stdout, options = {}) {
  let buffer = "";
  const pending = new Set();
  const send = (payload) => output.write(JSON.stringify(payload) + "\n");

  const dispatch = async (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, "Parse error"));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses = [];
    for (const message of messages) {
      try {
        const response = await handleMessage(message, options);
        if (response) responses.push(response);
      } catch (error) {
        responses.push(rpcError(message?.id, -32603, `Internal error: ${error?.message || error}`));
      }
    }
    if (!responses.length) return;
    send(Array.isArray(parsed) ? responses : responses[0]);
  };

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const job = dispatch(line).finally(() => pending.delete(job));
      pending.add(job);
    }
  });
  input.on("end", async () => {
    if (buffer.trim()) {
      const job = dispatch(buffer.trim());
      pending.add(job);
    }
    await Promise.allSettled([...pending]);
  });
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) serve();
