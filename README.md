# mercury-decide

A small, dependency-free toolkit for [Inception's Mercury Decide](https://openrouter.ai/inception/mercury-decide:free),
a decision-only model served through OpenRouter's Decisions API. You give it a state and typed questions;
it answers with typed answers and probabilities, in a fraction of a second, for free on the `:free` tier.

It never writes prose. That makes it the cheap way to make a mechanical choice (classify, route, yes/no, pick one
of N) inside a script or an agent loop instead of spending a whole model turn on it.

Three pieces, Node 18+, no npm dependencies:

| Piece | File | What it does |
|---|---|---|
| CLI | `bin/decide.mjs` | Ask one typed question from a shell. Retries, fallback models, call log, `--stats`. |
| MCP server | `bin/mcp.mjs` | Tools `decide` and `decide_batch` over stdio, for Claude Code, Codex and any MCP client. |
| Task router | `bin/route.mjs` | Reads a task description, recommends a tier and flags web / images / production. Advisory only. |

## Why

- The Decisions API takes `{model, state, questions}` and returns `{answers: {...}}`. Question types: `noul`
  (yes/no, returned as a probability of yes), `choice` (pick one option, returns per-option probabilities and a
  confidence), `score` (rate on ordered levels).
- The free model has a 32,768-token context. This toolkit estimates request size (characters / 3.5), refuses or
  truncates oversized states instead of letting the API fail, and can fall through to larger-context models.
- Rate limits and transient errors happen on a free tier, so calls retry with exponential backoff on 429 and 5xx
  and can fall back through an ordered list of models.

## Install

```sh
git clone <this repo> mercury-decide
cd mercury-decide
npm test            # no install step needed; there are no dependencies
```

Run the files directly (`node bin/decide.mjs ...`), or `npm link` to get the `mercury-decide`,
`mercury-decide-mcp` and `mercury-route` commands. `package.json` is marked `"private": true` so nothing is
published by accident.

Authentication: set `OPENROUTER_API_KEY`. If it is not set, the first line of `~/.typesafe_key` is used as a
fallback. The key is only read at call time. It is never printed, logged or stored by this project.

## CLI

```sh
node bin/decide.mjs --state "Build failed with TypeError in parser.ts" --noul "Is this urgent?"
node bin/decide.mjs --state "Customer cannot log in" --choice "Which team?" --options billing,technical,sales
node bin/decide.mjs --state "Why is nothing working?!" --score "How frustrated?" --levels Calm,Frustrated,Angry
node bin/decide.mjs --state "..." --questions '{"q":{"type":"noul","instructions":"Is this a bug?"}}'
cat log.txt | node bin/decide.mjs --noul "Does this mention an error?"
node bin/decide.mjs --file big-state.json --noul "Is this a regression?" --truncate
node bin/decide.mjs --stats
```

Output is the `answers` object as JSON; `--full` adds model, usage and call metadata. Exit code 0 on an answer, 1
on any failure. State can come from `--state`, `--file` or stdin; a JSON object or array is sent as structured
state, anything else as text.

Other flags: `--model`, `--fallbacks a,b`, `--endpoint`, `--timeout <ms>`, `--retries <n>`, `--max-tokens <n>`,
`--truncate`, `--full`, `--help`, `--version`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | none | API key (fallback: `~/.typesafe_key`) |
| `MERCURY_DECIDE_MODEL` | `inception/mercury-decide:free` | Primary model. `JEV_MODEL` is honored as a legacy alias. |
| `MERCURY_DECIDE_FALLBACKS` | none | Comma-separated fallback models, tried in order |
| `MERCURY_DECIDE_ENDPOINT` | OpenRouter Decisions API | Endpoint override (`JEV_ENDPOINT` legacy alias) |
| `MERCURY_DECIDE_TIMEOUT_MS` | `30000` | Per-request timeout |
| `MERCURY_DECIDE_RETRIES` | `2` | Retries per model on 429, 5xx, timeout or network error |
| `MERCURY_DECIDE_BACKOFF_MS` | `500` | First backoff delay; doubles each retry, with jitter; `Retry-After` is honored |
| `MERCURY_DECIDE_MAX_STATE_TOKENS` | `28000` | Request budget for the primary model |
| `MERCURY_DECIDE_MAX_EVAL_TOKENS` | `600000` | Cap on questions x state tokens per request; larger multi-question calls are split |
| `MERCURY_DECIDE_LOG` | `~/.mercury-decide/calls.jsonl` | Call log path; `off` disables logging |

### Behavior

- **Retries**: 429, 5xx, timeouts and network errors are retried per model. 400/404-style errors are not retried
  and move on to the next model. 401/403 fail immediately.
- **Fallbacks**: after the primary model is exhausted, each model in `MERCURY_DECIDE_FALLBACKS` is tried in order.
- **Context limit**: if the state plus questions are estimated over the budget, the call fails with a clear message.
  With `--truncate` the head (60%) and tail (40%) are kept and the middle is replaced by a marker (the state becomes
  text). If fallbacks are configured and `--truncate` is not set, the primary model is skipped and the fallbacks
  (assumed larger) are used.
- **Many questions, big state**: Mercury evaluates every question against the whole state, so a request costs about
  `questions x state` input tokens (the `usage.input_tokens` it reports scales that way). Measured on the free tier:
  about 870k tokens answered, about 1.0M was refused with HTTP 422. `decide` and `decide_batch` therefore split a
  multi-question call into sequential requests that stay under `MERCURY_DECIDE_MAX_EVAL_TOKENS` and merge the answers.
- **Call log**: one JSON line per call at `~/.mercury-decide/calls.jsonl`: timestamp, caller, model, latency,
  estimated state and request tokens, reported input/output tokens, attempts, fallback/truncation flags, outcome
  (`ok` or a short error code). It never contains state text, questions, answers or keys.
- **`--stats`** prints calls, success rate, median latency (successful calls) and tokens routed.

## MCP server

`bin/mcp.mjs` speaks JSON-RPC 2.0 over stdio (newline-delimited) and implements `initialize`, `ping`, `tools/list`
and `tools/call`.

- `decide`: `state` + `question`, optional `type` (`noul` | `choice` | `score`), `options` / `criteria` (choice),
  `levels` (score), `model`. Returns the typed answer with probabilities. Noul answers also carry a plain `verdict`.
- `decide_batch`: one `state` and a `questions` array (each with optional `id`); answers come back keyed by id.

Oversized states are truncated (head + tail) by the server, and the result says `truncated: true`.

### Claude Code

```sh
claude mcp add mercury-decide --scope user -- node /absolute/path/to/mercury-decide/bin/mcp.mjs
```

The server inherits `OPENROUTER_API_KEY` from your environment. To pass it explicitly without typing it into a
config file, prefer exporting it in your shell profile.

### Codex

```sh
codex mcp add mercury-decide -- node /absolute/path/to/mercury-decide/bin/mcp.mjs
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.mercury-decide]
command = "node"
args = ["/absolute/path/to/mercury-decide/bin/mcp.mjs"]
# Codex only forwards a few variables by default; forward the key by name (never paste the value here):
env_vars = ["OPENROUTER_API_KEY"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

On Windows use the full path with forward slashes or doubled backslashes, for example
`C:/path/to/mercury-decide/bin/mcp.mjs`. If the server cannot see the environment variable it falls back to
`~/.typesafe_key`.

## Task router

```sh
echo "Refactor the retry policy for the ingest queue and deploy it" | node bin/route.mjs
node bin/route.mjs --file queue-block.md
node bin/route.mjs --tiers my-tiers.json --file queue-block.md
```

One call asks the tier (`heavy-reasoning`, `standard-coding`, `mechanical-small`) plus three yes/no questions (needs
live web? needs images? touches production?) and prints a recommendation:

```json
{
  "advisory": true,
  "tier": "heavy-reasoning",
  "suggestedModel": null,
  "confidence": 0.41,
  "lowConfidence": false,
  "probabilities": { "heavy-reasoning": 0.7, "standard-coding": 0.2, "mechanical-small": 0.1 },
  "needsWeb": { "value": false, "probability": 0.08 },
  "needsImages": { "value": false, "probability": 0.03 },
  "touchesProduction": { "value": true, "probability": 0.91 },
  "notes": ["touches production: a human or the heavy tier should review before anything is applied"],
  "model": "inception/mercury-decide-20260930"
}
```

It is advisory only: it never starts, switches or configures anything. `--tiers` takes
`{"tier-name": {"criteria": "when to pick it", "model": "optional slug"}}`; `model` is echoed back as
`suggestedModel`. `--strict` exits 2 when the tier confidence is below `MERCURY_ROUTE_MIN_CONFIDENCE` (default 0.15).

## Tests

```sh
npm test            # node --test, with a local mock server: retries, fallback, truncation, log, MCP, router
npm run smoke       # live, opt-in: runs only when OPENROUTER_API_KEY is set; ~9 free calls
npm run scan        # secret / personal-path scan of the tracked files
```

## Privacy

- No key is ever stored, logged or printed. Keys are read from the environment (or `~/.typesafe_key`) at call time
  and sent only in the `Authorization` header of the request to the configured endpoint. Error messages are
  redacted of the key.
- The call log holds metadata only (timestamps, model, latency, token counts, outcome). It has no state text, no
  questions and no answers.
- The only network traffic is the request to the Decisions API endpoint. Whatever you put in `state` is sent to
  OpenRouter and Inception; do not send secrets or personal data you would not send to a third-party API.

## License

MIT, see `LICENSE`. Security notes: `SECURITY.md`.
