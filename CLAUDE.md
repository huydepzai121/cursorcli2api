# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Development (tsx, no build step)
npm run dev -- cursor-agent --host 0.0.0.0

# Build (tsc + copy codex_instructions/)
npm run build

# Production (requires build first)
npm start

# Type checking only
npm run typecheck

# Environment check / CLI doctor
npm run doctor
```

**CLI usage pattern:**
```bash
# Provider as positional arg (auto-selects preset)
npm run dev -- cursor-agent --host 0.0.0.0
npm run dev -- codex --host 0.0.0.0
npm run dev -- claude --host 0.0.0.0
npm run dev -- gemini --host 0.0.0.0

# With explicit preset
CODEX_PRESET=cursor-auto npm run dev

# With token
CODEX_GATEWAY_TOKEN=sk-xxx npm run dev -- cursor-agent --host 0.0.0.0
```

## Architecture

This is an **HTTP API gateway** that wraps AI CLI tools (Cursor Agent, Codex, Claude Code, Gemini CLI) and exposes them as OpenAI/Anthropic-compatible REST APIs. Built with Hono on `@hono/node-server`.

### Request flow

```
HTTP client → Hono routes (server.ts)
           → auth check (Bearer token)
           → semaphore (concurrency limit)
           → provider dispatch (cursor-agent / codex / claude / gemini)
               → child_process.spawn or HTTP API call
               → NDJSON/stream-json parsing (stream-json-cli.ts)
           → SSE stream or JSON response
```

### Key files

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry: parses args, sets `CODEX_PROVIDER`/`CODEX_PRESET`, starts server |
| `src/config.ts` | All settings from env vars; preset system; auto-loads `.env` |
| `src/server.ts` | Hono app, all routes, `handleChatCompletions()` — core dispatch logic |
| `src/lib/openai-compat.ts` | OpenAI schema types/validation, `messagesToPrompt()`, Tool Call parsing |
| `src/lib/anthropic-compat.ts` | Anthropic schema types/validation, SSE format helpers |
| `src/lib/http-client.ts` | Shared HTTP client with connection pool cleanup |
| `src/providers/stream-json-cli.ts` | `iterStreamJsonEvents()` — spawns CLIs, parses NDJSON output; `TextAssembler`; delta extractors per provider |
| `src/providers/codex-cli.ts` | Codex CLI subprocess provider |
| `src/providers/codex-responses.ts` | Codex Responses HTTP API provider (auth, headers, SSE) |
| `src/providers/claude-oauth.ts` | Claude OAuth direct API provider |
| `src/providers/gemini-cloudcode.ts` | Gemini Cloud Code direct API provider |
| `src/codex_instructions/` | System prompt templates injected into Codex requests |

### Provider routing

The model string in requests determines which backend runs:
- `cursor-agent:model` or `cursor:model` → Cursor Agent CLI
- `claude:model` or `claude-code:model` → Claude Code CLI or OAuth API
- `gemini:model` → Gemini CLI or Cloud Code API
- anything else → Codex (CLI or Responses API)

`CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE=true` must be set for clients to use `provider:model` routing.

### Tool Call simulation (Cursor Agent)

Cursor Agent doesn't natively support function calling. The gateway implements it via prompt engineering: tool schemas are injected as a system prompt, the model outputs a special marker format, and `parseToolCallResponse()` in `openai-compat.ts` extracts the tool calls from the text before returning the response.

### Streaming

Both SSE paths (OpenAI and Anthropic) pump events through `iterStreamJsonEvents()`. The Anthropic handler re-encodes OpenAI SSE chunks as Anthropic SSE events on the fly. Keepalive pings are sent at `CODEX_SSE_KEEPALIVE_SECONDS` intervals.

### Presets

Presets in `config.ts` (`_applyPreset()`) set groups of env vars at startup. The CLI auto-selects a default preset based on the provider argument. Preset env vars only apply if the corresponding env var is not already set.

## Configuration

All configuration is via environment variables (or `.env` file). The `.env` file is auto-loaded from CWD or repo root unless `CODEX_NO_DOTENV=1`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_GATEWAY_TOKEN` | — | Bearer token auth (unset = no auth) |
| `CODEX_PROVIDER` | `auto` | `cursor-agent` / `codex` / `claude` / `gemini` |
| `CODEX_PRESET` | — | Apply a named config preset |
| `CURSOR_AGENT_BIN` | `cursor-agent` | Path to cursor-agent CLI |
| `CURSOR_AGENT_WORKSPACE` | — | Workspace dir for cursor-agent (recommend `/tmp/cursor-empty-workspace`) |
| `CODEX_MAX_CONCURRENCY` | `100` | Max concurrent requests (semaphore) |
| `CODEX_TIMEOUT_SECONDS` | `600` | Per-request subprocess timeout |
| `CODEX_ADVERTISED_MODELS` | — | Comma-separated model list for `/v1/models` |

See `.env.example` for the full list.
