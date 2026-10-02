# Security

## What this project handles

- **API key.** `OPENROUTER_API_KEY` (or, as a documented fallback, the first line of `~/.typesafe_key`) is read at
  call time, sent only in the `Authorization` header to the configured endpoint, and never printed, logged, cached
  or written to disk. Error text is redacted of the key before it is shown.
- **State text.** Whatever you pass as `state` and `questions` is sent to the Decisions API (OpenRouter and the
  model provider). Do not send secrets or personal data you would not send to a third-party API.
- **Call log.** `~/.mercury-decide/calls.jsonl` is metadata only (timestamp, caller, model, latency, token counts,
  outcome). It contains no state, questions, answers or keys. Set `MERCURY_DECIDE_LOG=off` to disable it.
- **MCP server.** Runs locally over stdio, exposes two read-only tools, writes nothing but protocol messages to
  stdout, and makes no network calls other than the Decisions API request.

## Hardening notes

- No dependencies, so no supply-chain surface beyond Node itself.
- `MERCURY_DECIDE_ENDPOINT` redirects requests, and the key goes with them. Only point it at an endpoint you trust.
- Do not paste a key into `config.toml`, `.mcp.json` or shell history; export it in your environment and forward it
  by name (`env_vars = ["OPENROUTER_API_KEY"]` for Codex).

## Reporting a vulnerability

Open a private security advisory on the repository host, or contact the maintainer privately. Please do not file
public issues for vulnerabilities. If a key was ever exposed, rotate it at the provider first.
