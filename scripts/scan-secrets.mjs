#!/usr/bin/env node
/**
 * Scans the repository's files (git-tracked plus untracked-but-not-ignored if this is a git repo,
 * otherwise everything outside node_modules/.git) for key material, personal paths and e-mail
 * addresses. Exits 1 on any hit. The NAME of the OPENROUTER_API_KEY variable and the documented
 * ~/.typesafe_key fallback are allowed. If ~/.typesafe_key or OPENROUTER_API_KEY holds a value,
 * that value is also searched for (and never printed).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return files;
  } catch {
    /* not a repo */
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return files;
}

// Patterns are built from parts so that this file does not match itself.
const P = (...parts) => parts.join("");
const PATTERNS = [
  ["OpenRouter-style key", new RegExp(P("sk", "-or-", String.raw`[A-Za-z0-9_-]{6,}`))],
  ["generic sk- key", new RegExp(P(String.raw`\bsk`, String.raw`-[A-Za-z0-9_-]{20,}`))],
  ["bearer token literal", new RegExp(String.raw`[Bb]earer\s+[A-Za-z0-9_.=-]{24,}`)],
  [
    "key assignment with a literal value",
    new RegExp(String.raw`(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_.=-]{16,}["']`, "i"),
  ],
  ["Windows user path", new RegExp(P(String.raw`C:[\\/]+Users[\\/]+`, "[A-Za-z]"), "i")],
  ["home path", new RegExp(P("/(?:home|Users)/", String.raw`[a-z][a-z0-9_-]+/`), "i")],
  ["personal name in a path or id", new RegExp(P("jk", "oreman"), "i")],
  ["e-mail address", /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["private key block", new RegExp(P("-----BEGIN [A-Z ]*", "PRIVATE KEY-----"))],
];

const secrets = [];
const envKey = process.env.OPENROUTER_API_KEY;
if (envKey && envKey.trim().length >= 12) secrets.push(["OPENROUTER_API_KEY value", envKey.trim()]);
try {
  const fileKey = readFileSync(join(homedir(), ".typesafe_key"), "utf8").trim().split(/\r?\n/)[0];
  if (fileKey && fileKey.length >= 12) secrets.push([".typesafe_key value", fileKey]);
} catch {
  /* none */
}

const hits = [];
let scanned = 0;
for (const file of listFiles()) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  scanned++;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [label, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${index + 1}: ${label}`);
    for (const [label, value] of secrets) if (line.includes(value)) hits.push(`${file}:${index + 1}: ${label}`);
  });
}

if (hits.length) {
  console.log(`scan: ${hits.length} hit(s) in ${scanned} files`);
  for (const hit of hits) console.log("  " + hit);
  process.exit(1);
}
console.log(`scan: clean (${scanned} files, ${PATTERNS.length} patterns, ${secrets.length} runtime secret value(s) checked)`);
