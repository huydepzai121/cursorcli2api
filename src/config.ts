/**
 * Configuration module. Ported from Python config.py.
 */

import { readFileSync, existsSync, mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// --- Type literals ---
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type GatewayProvider = "auto" | "codex" | "cursor-agent" | "claude" | "gemini";

// --- Paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _GATEWAY_ROOT = resolve(__dirname, "..");
const _DEFAULT_CODEX_CLI_HOME = join(_GATEWAY_ROOT, ".codex-gateway-home");

// --- Helper functions ---
export function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const lower = raw.trim().toLowerCase();
  return ["1", "true", "t", "yes", "y", "on"].includes(lower);
}

export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? defaultValue : n;
}

export function envStr(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw === undefined ? defaultValue : raw;
}

export function envCsv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function envJsonDictStrStr(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Minimal shell-arg parser (shlex.split equivalent) for CURSOR_AGENT_EXTRA_ARGS. */
function parseShellArgs(s: string): string[] {
  if (!s.trim()) return [];
  const result: string[] = [];
  let i = 0;
  const len = s.length;
  while (i < len) {
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len) break;
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      i++;
      let start = i;
      while (i < len && s[i] !== quote) i++;
      result.push(s.slice(start, i));
      if (i < len) i++;
    } else {
      let start = i;
      while (i < len && !/\s/.test(s[i]) && s[i] !== '"' && s[i] !== "'") i++;
      result.push(s.slice(start, i));
    }
  }
  return result;
}

// --- Dotenv loader ---
function _maybeLoadDotenv(path: string): void {
  if (process.env.CODEX_NO_DOTENV) return;
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (!stat.isFile()) return;
  } catch {
    return;
  }
  const content = readFileSync(path, { encoding: "utf-8" });
  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function _autoloadDotenv(): void {
  const cwdEnv = join(process.cwd(), ".env");
  _maybeLoadDotenv(cwdEnv);
  const repoEnv = join(_GATEWAY_ROOT, ".env");
  if (resolve(repoEnv) !== resolve(cwdEnv)) _maybeLoadDotenv(repoEnv);
}

_autoloadDotenv();

// --- Preset system ---
function _applyPreset(): void {
  const raw = (process.env.CODEX_PRESET ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return;

  const presets: Record<string, Record<string, string>> = {
    "codex-fast": {
      CODEX_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.2",
      CODEX_MODEL_REASONING_EFFORT: "low",
      CODEX_USE_CODEX_RESPONSES_API: "1",
      CODEX_SANDBOX: "read-only",
      CODEX_APPROVAL_POLICY: "never",
      CODEX_SKIP_GIT_REPO_CHECK: "1",
      CODEX_DISABLE_SHELL_TOOL: "1",
      CODEX_DISABLE_VIEW_IMAGE_TOOL: "1",
      CODEX_SSE_KEEPALIVE_SECONDS: "2",
      CODEX_MAX_CONCURRENCY: "100",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
      CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE: "0",
      CODEX_ALLOW_CLIENT_MODEL_OVERRIDE: "0",
    },
    "multi-fast": {
      CODEX_PROVIDER: "auto",
      CODEX_MODEL: "gpt-5.2",
      CODEX_MODEL_REASONING_EFFORT: "low",
      CODEX_USE_CODEX_RESPONSES_API: "1",
      CODEX_SANDBOX: "read-only",
      CODEX_APPROVAL_POLICY: "never",
      CODEX_SKIP_GIT_REPO_CHECK: "1",
      CODEX_DISABLE_SHELL_TOOL: "1",
      CODEX_DISABLE_VIEW_IMAGE_TOOL: "1",
      CODEX_SSE_KEEPALIVE_SECONDS: "2",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
      CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE: "1",
      CODEX_ALLOW_CLIENT_MODEL_OVERRIDE: "1",
    },
    "autoglm-phone": {
      CODEX_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.2",
      CODEX_MODEL_REASONING_EFFORT: "low",
      CODEX_USE_CODEX_RESPONSES_API: "1",
      CODEX_SANDBOX: "read-only",
      CODEX_APPROVAL_POLICY: "never",
      CODEX_SKIP_GIT_REPO_CHECK: "1",
      CODEX_DISABLE_SHELL_TOOL: "1",
      CODEX_DISABLE_VIEW_IMAGE_TOOL: "1",
      CODEX_STRIP_ANSWER_TAGS: "1",
      CODEX_SSE_KEEPALIVE_SECONDS: "2",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "8000",
      CODEX_LOG_EVENTS: "0",
      CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE: "0",
      CODEX_ALLOW_CLIENT_MODEL_OVERRIDE: "0",
    },
    "cursor-fast": {
      CODEX_PROVIDER: "cursor-agent",
      CURSOR_AGENT_MODEL: "gpt-5.3-codex",
      CURSOR_AGENT_DISABLE_INDEXING: "1",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
    },
    "cursor-auto": {
      CODEX_PROVIDER: "cursor-agent",
      CURSOR_AGENT_MODEL: "auto",
      CURSOR_AGENT_DISABLE_INDEXING: "1",
      CURSOR_AGENT_WORKSPACE: "/tmp/cursor-empty-workspace",
      CODEX_MAX_CONCURRENCY: "100",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
    },
    "claude-oauth": {
      CODEX_PROVIDER: "claude",
      CLAUDE_USE_OAUTH_API: "1",
      CODEX_MAX_CONCURRENCY: "100",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
    },
    "gemini-cloudcode": {
      CODEX_PROVIDER: "gemini",
      GEMINI_USE_CLOUDCODE_API: "1",
      GEMINI_MODEL: "gemini-3-flash-preview",
      CODEX_MAX_CONCURRENCY: "100",
      CODEX_LOG_MODE: "qa",
      CODEX_LOG_MAX_CHARS: "4000",
      CODEX_LOG_EVENTS: "0",
    },
  };

  const conf = presets[raw];
  if (!conf) return;

  for (const [key, value] of Object.entries(conf)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

_applyPreset();

// --- Workspace resolution ---
function _defaultTmpRoot(): string {
  const candidate = (process.env.CODEX_TMP_ROOT ?? "").trim();
  if (candidate) {
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      /* ignore */
    }
  }
  if (existsSync("/tmp")) return "/tmp";
  return tmpdir();
}

function _resolveWorkspace(): string {
  const raw = (process.env.CODEX_WORKSPACE ?? "").trim();
  if (raw) {
    const expanded = raw.startsWith("~") ? join(process.env.HOME ?? "", raw.slice(1)) : raw;
    return resolve(expanded);
  }
  return mkdtempSync(join(_defaultTmpRoot(), "agent-cli-to-api-workspace-"));
}

// --- Settings interface ---
export interface Settings {
  effectiveLogMode(): string;
  readonly host: string;
  readonly port: number;
  readonly bearer_token: string | null;
  readonly workspace: string;
  readonly codex_cli_home: string | null;
  readonly default_model: string;
  readonly model_reasoning_effort: string | null;
  readonly force_reasoning_effort: string | null;
  readonly sandbox: SandboxMode;
  readonly approval_policy: ApprovalPolicy;
  readonly skip_git_repo_check: boolean;
  readonly enable_search: boolean;
  readonly add_dirs: readonly string[];
  readonly model_aliases: Readonly<Record<string, string>>;
  readonly advertised_models: readonly string[];
  readonly disable_shell_tool: boolean;
  readonly disable_view_image_tool: boolean;
  readonly use_codex_responses_api: boolean;
  readonly codex_responses_base_url: string;
  readonly codex_responses_version: string;
  readonly codex_responses_user_agent: string;
  readonly codex_allow_tools: boolean;
  readonly provider: GatewayProvider;
  readonly allow_client_provider_override: boolean;
  readonly allow_client_model_override: boolean;
  readonly cursor_agent_bin: string;
  readonly cursor_agent_workspace: string | null;
  readonly cursor_agent_api_key: string | null;
  readonly cursor_agent_model: string | null;
  readonly cursor_agent_stream_partial_output: boolean;
  readonly cursor_agent_disable_indexing: boolean;
  readonly cursor_agent_extra_args: readonly string[];
  readonly claude_bin: string;
  readonly claude_model: string | null;
  readonly claude_use_oauth_api: boolean;
  readonly claude_oauth_creds_path: string;
  readonly claude_oauth_base_url: string;
  readonly claude_oauth_client_id: string;
  readonly claude_api_base_url: string;
  readonly gemini_bin: string;
  readonly gemini_model: string | null;
  readonly gemini_use_cloudcode_api: boolean;
  readonly gemini_oauth_creds_path: string;
  readonly gemini_oauth_client_id: string;
  readonly gemini_oauth_client_secret: string;
  readonly gemini_cloudcode_base_url: string;
  readonly gemini_project_id: string;
  readonly max_prompt_chars: number;
  readonly timeout_seconds: number;
  readonly max_concurrency: number;
  readonly subprocess_stream_limit: number;
  readonly sse_keepalive_seconds: number;
  readonly enable_image_input: boolean;
  readonly max_image_count: number;
  readonly max_image_bytes: number;
  readonly cors_origins: string;
  readonly strip_answer_tags: boolean;
  readonly log_mode: string;
  readonly debug_log: boolean;
  readonly log_events: boolean;
  readonly log_max_chars: number;
  readonly rich_logs: boolean;
  readonly log_render_markdown: boolean;
  readonly log_request_curl: boolean;
  readonly log_stream_deltas: boolean;
  readonly log_stream_inline: boolean;
  readonly log_stream_inline_suppress_final: boolean;
}

function _expandUser(path: string): string {
  if (path.startsWith("~")) {
    return join(process.env.HOME ?? "", path.slice(1));
  }
  return path;
}

function _createSettings(): Settings {
  const codexCliHome = envBool("CODEX_USE_SYSTEM_CODEX_HOME", false)
    ? null
    : (envStr("CODEX_CLI_HOME", "").trim() || null);

  const sandboxRaw = (process.env.CODEX_SANDBOX ?? "read-only").trim().toLowerCase();
  const sandbox: SandboxMode =
    sandboxRaw === "workspace-write"
      ? "workspace-write"
      : sandboxRaw === "danger-full-access"
        ? "danger-full-access"
        : "read-only";

  const approvalRaw = (process.env.CODEX_APPROVAL_POLICY ?? "never").trim().toLowerCase();
  const approval_policy: ApprovalPolicy =
    approvalRaw === "untrusted"
      ? "untrusted"
      : approvalRaw === "on-failure"
        ? "on-failure"
        : approvalRaw === "on-request"
          ? "on-request"
          : "never";

  const providerRaw = envStr("CODEX_PROVIDER", "auto").trim().toLowerCase();
  const provider: GatewayProvider =
    providerRaw === "codex"
      ? "codex"
      : providerRaw === "cursor-agent"
        ? "cursor-agent"
        : providerRaw === "claude"
          ? "claude"
          : providerRaw === "gemini"
            ? "gemini"
            : "auto";

  const claudeOauthPath = envStr("CLAUDE_OAUTH_CREDS_PATH", "~/.claude/oauth_creds.json").trim() || "~/.claude/oauth_creds.json";
  const geminiOauthPath = envStr("GEMINI_OAUTH_CREDS_PATH", "~/.gemini/oauth_creds.json").trim() || "~/.gemini/oauth_creds.json";

  const s: Settings = {
    effectiveLogMode(): string {
      const mode = (this.log_mode ?? "").trim().toLowerCase();
      if (mode) return mode;
      return this.debug_log ? "qa" : "summary";
    },
    host: process.env.CODEX_GATEWAY_HOST ?? "0.0.0.0",
    port: envInt("CODEX_GATEWAY_PORT", 8000),
    bearer_token: process.env.CODEX_GATEWAY_TOKEN ?? null,
    workspace: _resolveWorkspace(),
    codex_cli_home: codexCliHome,
    default_model: process.env.CODEX_MODEL ?? "gpt-5.2",
    model_reasoning_effort: envStr("CODEX_MODEL_REASONING_EFFORT", "low").trim() || null,
    force_reasoning_effort: envStr("CODEX_FORCE_REASONING_EFFORT", "").trim() || null,
    sandbox,
    approval_policy,
    skip_git_repo_check: envBool("CODEX_SKIP_GIT_REPO_CHECK", true),
    enable_search: envBool("CODEX_ENABLE_SEARCH", false),
    add_dirs: Object.freeze([...envCsv("CODEX_ADD_DIRS")]),
    model_aliases: Object.freeze({ ...envJsonDictStrStr("CODEX_MODEL_ALIASES") }),
    advertised_models: Object.freeze([...envCsv("CODEX_ADVERTISED_MODELS")]),
    disable_shell_tool: envBool("CODEX_DISABLE_SHELL_TOOL", true),
    disable_view_image_tool: envBool("CODEX_DISABLE_VIEW_IMAGE_TOOL", true),
    use_codex_responses_api: envBool("CODEX_USE_CODEX_RESPONSES_API", false),
    codex_responses_base_url: envStr("CODEX_CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex"),
    codex_responses_version: envStr("CODEX_CODEX_VERSION", "0.21.0"),
    codex_responses_user_agent: envStr(
      "CODEX_CODEX_USER_AGENT",
      "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464"
    ),
    codex_allow_tools: envBool("CODEX_CODEX_ALLOW_TOOLS", true),
    provider,
    allow_client_provider_override: envBool("CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE", false),
    allow_client_model_override: envBool("CODEX_ALLOW_CLIENT_MODEL_OVERRIDE", false),
    cursor_agent_bin: process.env.CURSOR_AGENT_BIN ?? "cursor-agent",
    cursor_agent_workspace: envStr("CURSOR_AGENT_WORKSPACE", "").trim() || null,
    cursor_agent_api_key: process.env.CURSOR_AGENT_API_KEY ?? process.env.CURSOR_API_KEY ?? null,
    cursor_agent_model: envStr("CURSOR_AGENT_MODEL", "").trim() || null,
    cursor_agent_stream_partial_output: envBool("CURSOR_AGENT_STREAM_PARTIAL_OUTPUT", true),
    cursor_agent_disable_indexing: envBool("CURSOR_AGENT_DISABLE_INDEXING", true),
    cursor_agent_extra_args: Object.freeze(
      parseShellArgs(process.env.CURSOR_AGENT_EXTRA_ARGS ?? "")
    ),
    claude_bin: process.env.CLAUDE_BIN ?? "claude",
    claude_model: envStr("CLAUDE_MODEL", "").trim() || null,
    claude_use_oauth_api: envBool("CLAUDE_USE_OAUTH_API", false),
    claude_oauth_creds_path: _expandUser(claudeOauthPath),
    claude_oauth_base_url: envStr("CLAUDE_OAUTH_BASE_URL", "https://console.anthropic.com").trim(),
    claude_oauth_client_id: envStr("CLAUDE_OAUTH_CLIENT_ID", "").trim(),
    claude_api_base_url: envStr("CLAUDE_API_BASE_URL", "https://api.anthropic.com").trim(),
    gemini_bin: process.env.GEMINI_BIN ?? "gemini",
    gemini_model: envStr("GEMINI_MODEL", "").trim() || null,
    gemini_use_cloudcode_api: envBool("GEMINI_USE_CLOUDCODE_API", false),
    gemini_oauth_creds_path: _expandUser(geminiOauthPath),
    gemini_oauth_client_id: envStr("GEMINI_OAUTH_CLIENT_ID", "").trim(),
    gemini_oauth_client_secret: envStr("GEMINI_OAUTH_CLIENT_SECRET", "").trim(),
    gemini_cloudcode_base_url: envStr("GEMINI_CLOUDCODE_BASE_URL", "https://cloudcode-pa.googleapis.com").trim(),
    gemini_project_id: envStr("GEMINI_PROJECT_ID", "").trim(),
    max_prompt_chars: envInt("CODEX_MAX_PROMPT_CHARS", 200_000),
    timeout_seconds: envInt("CODEX_TIMEOUT_SECONDS", 600),
    max_concurrency: envInt("CODEX_MAX_CONCURRENCY", 100),
    subprocess_stream_limit: envInt("CODEX_SUBPROCESS_STREAM_LIMIT", 16 * 1024 * 1024),
    sse_keepalive_seconds: envInt("CODEX_SSE_KEEPALIVE_SECONDS", 2),
    enable_image_input: envBool("CODEX_ENABLE_IMAGE_INPUT", true),
    max_image_count: envInt("CODEX_MAX_IMAGE_COUNT", 4),
    max_image_bytes: envInt("CODEX_MAX_IMAGE_BYTES", 8 * 1024 * 1024),
    cors_origins: process.env.CODEX_CORS_ORIGINS ?? "",
    strip_answer_tags: envBool("CODEX_STRIP_ANSWER_TAGS", true),
    log_mode: envStr("CODEX_LOG_MODE", "").trim().toLowerCase(),
    debug_log: envBool("CODEX_DEBUG_LOG", false),
    log_events: envBool("CODEX_LOG_EVENTS", true),
    log_max_chars: envInt("CODEX_LOG_MAX_CHARS", 4000),
    rich_logs: envBool("CODEX_RICH_LOGS", false),
    log_render_markdown: envBool("CODEX_LOG_RENDER_MARKDOWN", false),
    log_request_curl: envBool("CODEX_LOG_REQUEST_CURL", false),
    log_stream_deltas: envBool("CODEX_LOG_STREAM_DELTAS", false),
    log_stream_inline: envBool("CODEX_LOG_STREAM_INLINE", false),
    log_stream_inline_suppress_final: envBool("CODEX_LOG_STREAM_INLINE_SUPPRESS_FINAL", true),
  };
  return Object.freeze(s);
}

export const settings: Settings = _createSettings();
