/**
 * Diagnostic tool. Ported from Python doctor.py.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { loadCodexAuth } from "./providers/codex-responses.js";
import { loadGeminiCreds } from "./providers/gemini-cloudcode.js";
import { maybeRefreshClaudeOauth } from "./providers/claude-oauth.js";

// Import config so presets are applied, mirroring the server.
import "./config.js";

function which(name: string): string | null {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function parseEnvBool(name: string, defaultVal: boolean): [boolean, string | null] {
  const raw = process.env[name];
  if (raw === undefined) return [defaultVal, null];
  const v = raw.trim().toLowerCase();
  if (!v) return [defaultVal, null];
  if (["1", "true", "yes", "y", "on"].includes(v)) return [true, null];
  if (["0", "false", "no", "n", "off"].includes(v)) return [false, null];
  return [defaultVal, `invalid boolean value ${JSON.stringify(raw)} (expected one of 1/0 true/false yes/no on/off)`];
}

function normalizeProvider(raw: string | undefined): string {
  const p = (raw ?? "").trim().toLowerCase();
  if (!p) return "auto";
  if (["auto", "codex", "gemini", "claude", "cursor-agent"].includes(p)) return p;
  if (["cursor", "cursoragent", "cursor_agent"].includes(p)) return "cursor-agent";
  return "auto";
}

interface CheckResult {
  name: string;
  ok: boolean;
  required: boolean;
  details: string;
}

function fmtStatus(ok: boolean, required: boolean): string {
  return ok ? "OK" : required ? "FAIL" : "WARN";
}

function checkBinary(label: string, binName: string, required: boolean): CheckResult {
  const p = which(binName);
  return {
    name: `${label} binary`,
    ok: Boolean(p),
    required,
    details: p ?? `not found on PATH: ${binName}`,
  };
}

function checkCodexAuth(required: boolean): CheckResult {
  const auth = loadCodexAuth(process.env.CODEX_CLI_HOME ?? null);
  const ok = Boolean(auth.accessToken || auth.apiKey);
  return {
    name: "Codex auth",
    ok,
    required,
    details: ok ? "auth ok" : "missing ~/.codex/auth.json tokens (run `codex login`)",
  };
}

function checkGeminiCreds(required: boolean): CheckResult {
  const path = (process.env.GEMINI_OAUTH_CREDS_PATH ?? "~/.gemini/oauth_creds.json").replace(
    /^~/,
    homedir()
  );
  if (!existsSync(path)) {
    return {
      name: "Gemini OAuth cache",
      ok: false,
      required,
      details: `missing: ${path} (run \`gemini auth login\`)`,
    };
  }
  const creds = loadGeminiCreds(path);
  const ok = Boolean(creds.accessToken || creds.refreshToken);
  return {
    name: "Gemini OAuth cache",
    ok,
    required,
    details: `${path} (access=${Boolean(creds.accessToken)} refresh=${Boolean(creds.refreshToken)})`,
  };
}

async function checkClaudeOauthRefreshable(required: boolean): Promise<CheckResult> {
  const path = (process.env.CLAUDE_OAUTH_CREDS_PATH ?? "~/.claude/oauth_creds.json").replace(
    /^~/,
    homedir()
  );
  if (!existsSync(path)) {
    return {
      name: "Claude OAuth cache",
      ok: false,
      required,
      details: `missing: ${path} (run \`uv run python -m codex_gateway.claude_oauth_login\`)`,
    };
  }
  try {
    const creds = await maybeRefreshClaudeOauth(path);
    const ok = Boolean(creds.accessToken || creds.refreshToken);
    return {
      name: "Claude OAuth cache",
      ok,
      required,
      details: `${path} (access=${Boolean(creds.accessToken)} refresh=${Boolean(creds.refreshToken)})`,
    };
  } catch (e) {
    return {
      name: "Claude OAuth cache",
      ok: false,
      required,
      details: `${path} (refresh failed: ${e})`,
    };
  }
}

function checkWorkspace(required: boolean): CheckResult {
  const workspace = process.env.CODEX_WORKSPACE;
  if (!workspace) {
    return { name: "CODEX_WORKSPACE", ok: true, required, details: "not set" };
  }
  const path = workspace.replace(/^~/, homedir());
  const ok = existsSync(path);
  if (ok) {
    try {
      const stat = statSync(path);
      const isDir = stat.isDirectory();
      return {
        name: "CODEX_WORKSPACE",
        ok: isDir,
        required,
        details: isDir ? path : `missing or not a directory: ${path}`,
      };
    } catch {
      return { name: "CODEX_WORKSPACE", ok: false, required, details: `missing or not a directory: ${path}` };
    }
  }
  return { name: "CODEX_WORKSPACE", ok: false, required, details: `missing or not a directory: ${path}` };
}

export async function runDoctor(): Promise<number> {
  const provider = normalizeProvider(process.env.CODEX_PROVIDER);
  const [claudeUseOauth, claudeUseOauthErr] = parseEnvBool("CLAUDE_USE_OAUTH_API", false);
  const [geminiUseCloudcode, geminiUseCloudcodeErr] = parseEnvBool("GEMINI_USE_CLOUDCODE_API", false);

  const codexBin = checkBinary("codex", "codex", provider === "codex");
  const codexAuth = checkCodexAuth(provider === "codex");
  const codexReady = codexBin.ok && codexAuth.ok;

  const geminiBin = checkBinary("gemini", "gemini", provider === "gemini");
  const geminiCreds = checkGeminiCreds(provider === "gemini" && geminiUseCloudcode);
  const geminiReady = geminiBin.ok && (geminiUseCloudcode ? geminiCreds.ok : true);

  const claudeBin = checkBinary("claude", "claude", provider === "claude" && !claudeUseOauth);
  const claudeOauth = await checkClaudeOauthRefreshable(provider === "claude" && claudeUseOauth);
  const claudeReady = claudeUseOauth ? claudeOauth.ok : claudeBin.ok;

  const cursorBin = checkBinary("cursor-agent", "cursor-agent", provider === "cursor-agent");
  const cursorReady = cursorBin.ok;

  const checks: CheckResult[] = [];

  if (claudeUseOauthErr) {
    checks.push({ name: "CLAUDE_USE_OAUTH_API", ok: false, required: false, details: claudeUseOauthErr });
  }
  if (geminiUseCloudcodeErr) {
    checks.push({ name: "GEMINI_USE_CLOUDCODE_API", ok: false, required: false, details: geminiUseCloudcodeErr });
  }

  if (provider === "codex") {
    checks.push(codexBin, codexAuth);
  } else if (provider === "gemini") {
    checks.push(geminiBin);
    if (geminiUseCloudcode) checks.push(geminiCreds);
  } else if (provider === "claude") {
    if (claudeUseOauth) {
      checks.push(claudeOauth);
      checks.push(checkBinary("claude", "claude", false));
    } else {
      checks.push(claudeBin);
      checks.push(await checkClaudeOauthRefreshable(false));
    }
  } else if (provider === "cursor-agent") {
    checks.push(cursorBin);
  } else {
    checks.push(
      checkBinary("codex", "codex", false),
      checkCodexAuth(false),
      checkBinary("gemini", "gemini", false),
      checkGeminiCreds(false),
      checkBinary("claude", "claude", false),
      await checkClaudeOauthRefreshable(false),
      checkBinary("cursor-agent", "cursor-agent", false)
    );
  }

  if (process.env.CODEX_WORKSPACE) {
    checks.push(checkWorkspace(true));
  }

  const width = checks.length ? Math.max(...checks.map((c) => c.name.length)) : 10;

  console.log("agent-cli-to-api doctor\n");
  for (const c of checks) {
    console.log(`- ${c.name.padEnd(width)} : ${fmtStatus(c.ok, c.required)}  ${c.details}`);
  }

  let requiredFailed = checks.some((c) => !c.ok && c.required);
  const warnings = checks.some((c) => !c.ok && !c.required);

  if (provider === "auto") {
    if (!(codexReady || geminiReady || claudeReady || cursorReady)) {
      requiredFailed = true;
    }
  }

  let result: string;
  let code: number;
  if (requiredFailed) {
    result = "FAIL";
    code = 1;
  } else if (warnings) {
    result = "OK (with warnings)";
    code = 0;
  } else {
    result = "OK";
    code = 0;
  }

  console.log(`\nResult: ${result}`);
  return code;
}
