/**
 * Gemini via Cloud Code Assist API. Ported from Python gemini_cloudcode.py.
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { fetch } from "undici";
import { settings } from "../config.js";
import { getAgent, requestJsonWithRetries } from "../lib/http-client.js";
import type { ChatCompletionRequest, ChatMessage } from "../lib/openai-compat.js";
import { normalizeMessageContent } from "../lib/openai-compat.js";

// Google OAuth credentials for Cloud Code API
// These are public credentials used by Google Cloud Code extension
// Can be overridden via environment variables
const BUILTIN_GEMINI_OAUTH_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID ||
  "681255809395-REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com";
const BUILTIN_GEMINI_OAUTH_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET || "REPLACE_WITH_YOUR_CLIENT_SECRET";

export interface GeminiOAuthCreds {
  accessToken: string | null;
  refreshToken: string | null;
  expiryDateMs: number | null;
  tokenType: string | null;
  scope: string | null;
  projectId: string | null;
}

let _cachedOauthClient: [string, string] | null = null;
let _accessTokenLockResolver: (() => void) | null = null;
let _accessTokenLockPromise: Promise<void> = Promise.resolve();
let _cachedAccessToken: string | null = null;
let _cachedAccessTokenExpiryMs: number | null = null;
let _projectIdLockResolver: (() => void) | null = null;
let _projectIdLockPromise: Promise<void> = Promise.resolve();
let _cachedProjectId: string | null = null;

const OAUTH_CLIENT_ID_RE = /\bOAUTH_CLIENT_ID\b\s*=\s*['"]([^'"]+)['"]/;
const OAUTH_CLIENT_SECRET_RE = /\bOAUTH_CLIENT_SECRET\b\s*=\s*['"]([^'"]+)['"]/;

/** Acquire mutex; returns release function. */
async function acquireAccessTokenLock(): Promise<() => void> {
  const waitFor = _accessTokenLockPromise;
  let release: () => void;
  _accessTokenLockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  await waitFor;
  return release!;
}

/** Acquire mutex; returns release function. */
async function acquireProjectIdLock(): Promise<() => void> {
  const waitFor = _projectIdLockPromise;
  let release: () => void;
  _projectIdLockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  await waitFor;
  return release!;
}

function whichSync(cmd: string): string | null {
  if (cmd.includes("/") || cmd.includes("\\")) return cmd;
  const pathEnv = process.env.PATH ?? "";
  const sep = platform() === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    const d = dir.trim();
    if (!d) continue;
    const full = join(d, cmd);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) return full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readOauthClientFromOauth2Js(path: string): [string | null, string | null] {
  try {
    const text = fs.readFileSync(path, "utf-8");
    const m1 = OAUTH_CLIENT_ID_RE.exec(text);
    const m2 = OAUTH_CLIENT_SECRET_RE.exec(text);
    const cid = m1?.[1]?.trim() ?? null;
    const sec = m2?.[1]?.trim() ?? null;
    return [cid ?? null, sec ?? null];
  } catch {
    return [null, null];
  }
}

function resolveGeminiOauth2JsPath(): string | null {
  const binPath = whichSync(settings.gemini_bin) ?? settings.gemini_bin;
  const expanded = binPath.startsWith("~")
    ? join(process.env.HOME ?? "", binPath.slice(1))
    : binPath;
  const entrypointDir = dirname(expanded);

  const roots: string[] = [];
  let current = entrypointDir;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(join(current, "bin")) && fs.existsSync(join(current, "libexec"))) {
      roots.push(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push(entrypointDir);

  const candidates = [
    "libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
    "libexec/lib/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
    "lib/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
  ];

  for (const root of roots) {
    for (const rel of candidates) {
      const full = join(root, rel);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Resolve OAuth client id/secret. Priority: env vars, oauth2.js from CLI, builtin.
 */
export function resolveGeminiOauthClient(): [string, string] {
  if (_cachedOauthClient) return _cachedOauthClient;

  if (settings.gemini_oauth_client_id && settings.gemini_oauth_client_secret) {
    _cachedOauthClient = [settings.gemini_oauth_client_id, settings.gemini_oauth_client_secret];
    return _cachedOauthClient;
  }
  if (settings.gemini_oauth_client_id || settings.gemini_oauth_client_secret) {
    throw new Error(
      "Gemini OAuth client credentials are partially configured. " +
        "Set both GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET, or unset both."
    );
  }

  const oauth2Js = resolveGeminiOauth2JsPath();
  if (oauth2Js) {
    const [cid, sec] = readOauthClientFromOauth2Js(oauth2Js);
    if (cid && sec) {
      _cachedOauthClient = [cid, sec];
      return _cachedOauthClient;
    }
  }

  _cachedOauthClient = [BUILTIN_GEMINI_OAUTH_CLIENT_ID, BUILTIN_GEMINI_OAUTH_CLIENT_SECRET];
  return _cachedOauthClient;
}

function expandUser(path: string): string {
  if (path.startsWith("~")) {
    return join(process.env.HOME ?? "", path.slice(1));
  }
  return path;
}

function secureWriteJson(path: string, obj: Record<string, unknown>): void {
  const p = expandUser(path);
  const dir = dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  const data = JSON.stringify(obj, null, 2) + "\n";
  const tmpDir = dirname(p);
  const tmpPath = join(tmpDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpPath, data, "utf-8");
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmpPath, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }
}

function loadOauthCreds(path: string): GeminiOAuthCreds {
  const p = expandUser(path);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (typeof raw !== "object" || raw === null) raw = {};

  function getStr(name: string): string | null {
    const v = raw[name];
    if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  }

  const expiry = raw.expiry_date;
  let expiryMs: number | null = null;
  if (typeof expiry === "number") expiryMs = Math.floor(expiry);

  return {
    accessToken: getStr("access_token"),
    refreshToken: getStr("refresh_token"),
    expiryDateMs: expiryMs,
    tokenType: getStr("token_type"),
    scope: getStr("scope"),
    projectId: getStr("project_id") ?? getStr("projectId"),
  };
}

/**
 * Load Gemini OAuth creds from JSON file.
 */
export function loadGeminiCreds(path: string): GeminiOAuthCreds {
  return loadOauthCreds(path);
}

function isExpired(expiryDateMs: number | null, skewSeconds = 60): boolean {
  if (!expiryDateMs) return true;
  const nowMs = Date.now();
  return expiryDateMs <= nowMs + skewSeconds * 1000;
}

async function refreshAccessToken(refreshToken: string, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const [clientId, clientSecret] = resolveGeminiOauthClient();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }).toString();
  const agent = getAgent("gemini-oauth");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
      dispatcher: agent,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gemini OAuth refresh failed: ${resp.status} ${text}`);
    }
    const obj = (await resp.json()) as unknown;
    if (typeof obj !== "object" || obj === null) {
      throw new Error("Gemini OAuth refresh failed: invalid JSON response");
    }
    return obj as Record<string, unknown>;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

/**
 * Get or refresh access token with caching and mutex.
 */
export async function getGeminiAccessToken(timeoutMs: number): Promise<string> {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  if (_cachedAccessToken && !isExpired(_cachedAccessTokenExpiryMs)) {
    return _cachedAccessToken;
  }

  const release = await acquireAccessTokenLock();
  try {
    if (_cachedAccessToken && !isExpired(_cachedAccessTokenExpiryMs)) {
      return _cachedAccessToken;
    }

    const credsPath = settings.gemini_oauth_creds_path;
    const creds = loadOauthCreds(credsPath);
    if (creds.accessToken && !isExpired(creds.expiryDateMs)) {
      _cachedAccessToken = creds.accessToken;
      _cachedAccessTokenExpiryMs = creds.expiryDateMs;
      return _cachedAccessToken;
    }
    if (!creds.refreshToken) {
      throw new Error(
        `Gemini OAuth refresh_token missing. Ensure Gemini CLI is logged in and ${credsPath} exists.`
      );
    }

    const tokenResp = await refreshAccessToken(creds.refreshToken, timeoutSeconds);
    const access = tokenResp.access_token;
    const expiresIn = tokenResp.expires_in;
    if (typeof access !== "string" || !access.trim()) {
      throw new Error("Gemini OAuth refresh failed: missing access_token");
    }
    let expiryMs: number | null = null;
    if (typeof expiresIn === "number") {
      expiryMs = Date.now() + Math.floor(expiresIn) * 1000;
    }

    _cachedAccessToken = access.trim();
    _cachedAccessTokenExpiryMs = expiryMs;

    if (process.env.GEMINI_CLOUDCODE_PERSIST_CACHE) {
      const p = expandUser(credsPath);
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      if (typeof raw !== "object" || raw === null) raw = {};
      raw.access_token = _cachedAccessToken;
      if (expiryMs != null) raw.expiry_date = expiryMs;
      try {
        secureWriteJson(p, raw);
      } catch {
        /* ignore */
      }
    }

    return _cachedAccessToken;
  } finally {
    release();
  }
}

/**
 * Resolve GCP project ID from creds file or Cloud Resource Manager API.
 */
export async function resolveGeminiProjectId(
  accessToken: string,
  timeoutMs: number
): Promise<string> {
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  if (settings.gemini_project_id) return settings.gemini_project_id;
  if (_cachedProjectId) return _cachedProjectId;

  const release = await acquireProjectIdLock();
  try {
    if (_cachedProjectId) return _cachedProjectId;

    const credsPath = settings.gemini_oauth_creds_path;
    const creds = loadOauthCreds(credsPath);
    if (creds.projectId) {
      _cachedProjectId = creds.projectId;
      return _cachedProjectId;
    }

    const url = "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=10";
    const agent = getAgent("gemini-cloudresourcemanager");
    const resp = await requestJsonWithRetries({
      url,
      method: "GET",
      timeoutMs: timeoutSeconds * 1000,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      agent,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Cloud Resource Manager failed: ${resp.status} ${text}`);
    }
    const obj = (await resp.json()) as Record<string, unknown>;
    let projectId: string | null = null;
    const projects = obj.projects as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(projects)) {
      for (const item of projects) {
        if (item?.lifecycleState !== "ACTIVE") continue;
        const pid = item.projectId;
        if (typeof pid === "string" && pid.trim()) {
          projectId = pid.trim();
          break;
        }
      }
    }
    if (!projectId) {
      throw new Error("gemini cloudcode: could not resolve a valid GCP project_id; set GEMINI_PROJECT_ID");
    }
    _cachedProjectId = projectId;

    if (!process.env.GEMINI_CLOUDCODE_NO_PERSIST_CACHE) {
      const p = expandUser(credsPath);
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      if (typeof raw !== "object" || raw === null) raw = {};
      raw.project_id = projectId;
      try {
        secureWriteJson(p, raw);
      } catch {
        /* ignore */
      }
    }

    return _cachedProjectId;
  } finally {
    release();
  }
}

/**
 * Pre-warm token and project caches.
 */
export async function warmupGeminiCaches(timeoutMs: number): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = { access_token: null, project_id: null };
  try {
    const access = await getGeminiAccessToken(timeoutMs);
    result.access_token = "cached";
    const projectId = await resolveGeminiProjectId(access, timeoutMs);
    result.project_id = projectId;
  } catch (e) {
    // Log warning would go here
  }
  return result;
}

function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (typeof content === "object" && !Array.isArray(content) && content !== null) {
    return [content as Record<string, unknown>];
  }
  if (Array.isArray(content)) {
    return content.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null);
  }
  return [{ type: "text", text: String(content) }];
}

function decodeDataUrl(url: string): [Buffer, string] {
  const raw = (url ?? "").trim();
  if (!raw.startsWith("data:")) {
    throw new Error("image_url must be a data: URL for Gemini CloudCode mode");
  }
  const commaIdx = raw.indexOf(",");
  if (commaIdx < 0) throw new Error("invalid data URL");
  const header = raw.slice(0, commaIdx);
  const b64 = raw.slice(commaIdx + 1);
  if (!header.includes(";base64")) throw new Error("data URL must be base64-encoded");
  const mime = header
    .slice(5)
    .split(";")[0]
    ?.trim()
    .toLowerCase() || "application/octet-stream";
  const data = Buffer.from(b64, "base64");
  return [data, mime];
}

/**
 * Convert OpenAI function tools to Gemini functionDeclarations format.
 */
export function openaiToolsToGemini(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const declarations: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    if (tool.type !== "function") continue;
    const func = tool.function as Record<string, unknown> | undefined;
    if (typeof func !== "object" || func === null) continue;
    const name = func.name;
    if (typeof name !== "string" || !name) continue;
    const entry: Record<string, unknown> = { name };
    const desc = func.description;
    if (typeof desc === "string" && desc) entry.description = desc;
    const params = func.parameters;
    if (typeof params === "object" && params !== null) entry.parameters = params;
    declarations.push(entry);
  }
  if (declarations.length === 0) return [];
  return [{ functionDeclarations: declarations }];
}

/**
 * Convert OpenAI tool_choice to Gemini functionCallingConfig.
 */
export function openaiToolChoiceToGemini(choice: unknown): Record<string, unknown> | null {
  if (choice === null || choice === undefined) return null;
  if (typeof choice === "string") {
    const lowered = choice.trim().toLowerCase();
    if (lowered === "auto" || lowered === "") return null;
    if (lowered === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (lowered === "required" || lowered === "any") return { functionCallingConfig: { mode: "ANY" } };
    return null;
  }
  if (typeof choice === "object" && choice !== null) {
    const obj = choice as Record<string, unknown>;
    if (obj.type === "function") {
      const fn = obj.function as Record<string, unknown> | undefined;
      if (typeof fn === "object" && fn !== null && typeof fn.name === "string" && fn.name) {
        return {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: [fn.name] },
        };
      }
    }
  }
  return null;
}

function applyOpenaiTools(payload: Record<string, unknown>, req: ChatCompletionRequest): void {
  const extra = (req as Record<string, unknown>).model_extra as Record<string, unknown> | undefined;
  if (typeof extra !== "object" || extra === null) return;
  const tools = extra.tools;
  const toolChoice = extra.tool_choice;
  if (toolChoice === "none") return;
  const request = (payload.request as Record<string, unknown>) ?? {};
  payload.request = request;
  if (Array.isArray(tools) && tools.length > 0) {
    const converted = openaiToolsToGemini(tools as Array<Record<string, unknown>>);
    if (converted.length > 0) request.tools = converted;
  }
  const config = openaiToolChoiceToGemini(toolChoice);
  if (config !== null) request.toolConfig = config;
}

export interface MessagesToCloudcodePayloadOpts {
  projectId: string;
  modelName: string;
  reasoningEffort: string;
}

/**
 * Convert ChatMessage[] to CloudCode request payload.
 */
export function messagesToCloudcodePayload(
  messages: ChatMessage[],
  opts: MessagesToCloudcodePayloadOpts
): Record<string, unknown> {
  const { projectId, modelName, reasoningEffort } = opts;
  const payload: Record<string, unknown> = {
    project: projectId,
    request: { contents: [] },
    model: modelName,
  };

  const sysTextParts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      let text = "";
      for (const part of contentParts(m.content)) {
        if (part.type === "text" && typeof part.text === "string") text += part.text;
      }
      if (text.trim()) sysTextParts.push(text.trim());
    }
  }
  if (sysTextParts.length > 0) {
    (payload.request as Record<string, unknown>).systemInstruction = {
      role: "user",
      parts: [{ text: sysTextParts.join("\n\n") }],
    };
  }

  const budgetMap: Record<string, number> = { medium: 1024, high: 8192, xhigh: 16384 };
  const budget = budgetMap[reasoningEffort];
  if (budget != null) {
    const req = payload.request as Record<string, unknown>;
    req.generationConfig = req.generationConfig ?? {};
    (req.generationConfig as Record<string, unknown>).thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: false,
    };
  }

  const toolCallNameMap: Record<string, string> = {};
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") continue;
    const role = m.role === "user" || m.role === "tool" ? "user" : "model";
    const node: Record<string, unknown> = { role, parts: [] };
    const extra = (m as Record<string, unknown>).model_extra as Record<string, unknown> | undefined;
    const toolCalls = extra?.tool_calls;

    if (m.role === "tool") {
      let toolCallId = extra?.tool_call_id ?? (m as Record<string, unknown>).tool_call_id;
      if (typeof toolCallId === "string" && toolCallId) {
        const toolName = toolCallNameMap[toolCallId] ?? "tool";
        const content = normalizeMessageContent(m.content);
        (node.parts as Array<Record<string, unknown>>).push({
          functionResponse: { name: toolName, response: { content } },
        });
      }
      if ((node.parts as unknown[]).length > 0) {
        (payload.request as Record<string, unknown>).contents = (payload.request as Record<string, unknown>).contents ?? [];
        ((payload.request as Record<string, unknown>).contents as unknown[]).push(node);
      }
      continue;
    }

    for (const part of contentParts(m.content)) {
      const ptype = part.type;
      if (ptype === "text" && typeof part.text === "string") {
        (node.parts as Array<Record<string, unknown>>).push({ text: part.text });
        continue;
      }
      if (ptype === "image_url" || ptype === "input_image") {
        const image = part.image_url;
        let url: string | undefined;
        if (typeof image === "object" && image !== null && !Array.isArray(image)) {
          url = (image as Record<string, unknown>).url as string;
        } else if (typeof image === "string") {
          url = image;
        }
        if (typeof url !== "string" || !url.trim()) continue;
        const [data, mime] = decodeDataUrl(url);
        if (settings.max_image_bytes > 0 && data.length > settings.max_image_bytes) {
          throw new Error(`Image too large (${data.length} bytes > ${settings.max_image_bytes})`);
        }
        (node.parts as Array<Record<string, unknown>>).push({
          inlineData: { mime_type: mime, data: data.toString("base64") },
        });
        continue;
      }
    }

    if (m.role === "assistant" && Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (typeof call !== "object" || call === null) continue;
        const c = call as Record<string, unknown>;
        const func = c.function as Record<string, unknown> | undefined;
        let name = func?.name ?? c.name;
        if (typeof name !== "string" || !name) continue;
        let args = func?.arguments;
        let parsedArgs: Record<string, unknown> = {};
        if (typeof args === "string") {
          try {
            const parsed = JSON.parse(args) as unknown;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              parsedArgs = parsed as Record<string, unknown>;
            }
          } catch {
            parsedArgs = {};
          }
        } else if (typeof args === "object" && args !== null) {
          parsedArgs = args as Record<string, unknown>;
        }
        (node.parts as Array<Record<string, unknown>>).push({ functionCall: { name, args: parsedArgs } });
        const callId = c.id ?? c.tool_call_id;
        if (typeof callId === "string" && callId) toolCallNameMap[callId] = String(name);
      }
    }

    if ((node.parts as unknown[]).length > 0) {
      (payload.request as Record<string, unknown>).contents = (payload.request as Record<string, unknown>).contents ?? [];
      ((payload.request as Record<string, unknown>).contents as unknown[]).push(node);
    }
  }
  return payload;
}

function extractTextFromCloudcodeResponse(obj: Record<string, unknown>): string {
  let o = obj;
  if (typeof o.response === "object" && o.response !== null) {
    o = o.response as Record<string, unknown>;
  }
  const candidates = o.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const content = (candidates[0] ?? {}) as Record<string, unknown>;
  const c = content.content;
  if (typeof c !== "object" || c === null) return "";
  const parts = (c as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string") {
      out.push((p as Record<string, unknown>).text as string);
    }
  }
  return out.join("");
}

function extractUsageFromCloudcodeResponse(obj: Record<string, unknown>): Record<string, number> | null {
  let o = obj;
  if (typeof o.response === "object" && o.response !== null) {
    o = o.response as Record<string, unknown>;
  }
  const usage = o.usageMetadata;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const prompt = Math.floor(Number(u.promptTokenCount) || 0);
  const completion = Math.floor(Number(u.candidatesTokenCount) || 0);
  const total = prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function cloudcodeHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    Accept: stream ? "text/event-stream" : "application/json",
  };
}

export interface GenerateCloudcodeOpts {
  modelName: string;
  reasoningEffort: string;
  timeoutMs: number;
}

/**
 * Non-streaming POST to /v1internal:generateContent.
 */
export async function generateCloudcode(
  req: ChatCompletionRequest,
  opts: GenerateCloudcodeOpts
): Promise<[string, Record<string, number> | null]> {
  const { modelName, reasoningEffort, timeoutMs } = opts;
  const timeoutSec = Math.min(Math.ceil(timeoutMs / 1000), 30) * 1000;
  const access = await getGeminiAccessToken(timeoutSec);
  const projectId = await resolveGeminiProjectId(access, timeoutSec);
  const payload = messagesToCloudcodePayload(req.messages, {
    projectId,
    modelName,
    reasoningEffort,
  });
  applyOpenaiTools(payload, req);

  const url = `${settings.gemini_cloudcode_base_url}/v1internal:generateContent`;
  const agent = getAgent("gemini-cloudcode");
  const resp = await requestJsonWithRetries({
    url,
    method: "POST",
    timeoutMs: Math.ceil(timeoutMs / 1000) * 1000,
    body: payload,
    headers: cloudcodeHeaders(access, false),
    agent,
  });

  if (resp.status < 200 || resp.status >= 300) {
    let detail = (await resp.text()).trim();
    if (detail.length > 2000) detail = detail.slice(0, 2000) + "…";
    throw new Error(`gemini cloudcode failed: ${resp.status} ${detail}`);
  }

  const obj = (await resp.json()) as Record<string, unknown>;
  if (typeof obj !== "object" || obj === null) {
    return ["", null];
  }
  return [
    extractTextFromCloudcodeResponse(obj),
    extractUsageFromCloudcodeResponse(obj),
  ];
}

export interface IterCloudcodeStreamEventsOpts {
  modelName: string;
  reasoningEffort: string;
  timeoutMs: number;
  eventCallback?: (evt: Record<string, unknown>) => void;
}

/**
 * Streaming SSE from /v1internal:streamGenerateContent?alt=sse.
 * Yields {type:"message", role:"assistant", content} and {type:"result", stats}.
 */
export async function* iterCloudcodeStreamEvents(
  req: ChatCompletionRequest,
  opts: IterCloudcodeStreamEventsOpts
): AsyncGenerator<Record<string, unknown>> {
  const { modelName, reasoningEffort, timeoutMs, eventCallback } = opts;
  const timeoutSec = Math.min(Math.ceil(timeoutMs / 1000), 30) * 1000;
  const access = await getGeminiAccessToken(timeoutSec);
  const projectId = await resolveGeminiProjectId(access, timeoutSec);
  const payload = messagesToCloudcodePayload(req.messages, {
    projectId,
    modelName,
    reasoningEffort,
  });
  applyOpenaiTools(payload, req);

  const url = `${settings.gemini_cloudcode_base_url}/v1internal:streamGenerateContent?alt=sse`;
  const agent = getAgent("gemini-cloudcode-stream");
  const resp = await fetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: cloudcodeHeaders(access, true),
    dispatcher: agent,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const detail = (await resp.text()).trim();
    throw new Error(`gemini cloudcode failed: ${resp.status} ${detail.length > 2000 ? detail.slice(0, 2000) + "…" : detail}`);
  }

  const body = resp.body;
  if (!body) throw new Error("No response body");

  let lastUsage: Record<string, number> | null = null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as Record<string, unknown>;
          if (typeof obj !== "object" || obj === null) continue;
          const text = extractTextFromCloudcodeResponse(obj);
          if (text) {
            const evt = { type: "message", role: "assistant", content: text };
            if (eventCallback) eventCallback(evt);
            yield evt;
          }
          const usage = extractUsageFromCloudcodeResponse(obj);
          if (usage) lastUsage = usage;
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastUsage) {
    const evt = {
      type: "result",
      stats: {
        input_tokens: lastUsage.prompt_tokens,
        output_tokens: lastUsage.completion_tokens,
        total_tokens: lastUsage.total_tokens,
      },
    };
    if (eventCallback) eventCallback(evt);
    yield evt;
  }
}
