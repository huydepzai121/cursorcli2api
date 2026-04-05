/**
 * Codex backend /responses API (HTTP, not CLI). Ported from Python codex_responses.py.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetch } from "undici";
import type { ChatCompletionRequest, ChatMessage } from "../lib/openai-compat.js";

export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const _DEFAULT_CODEX_VERSION = "0.21.0";
const _DEFAULT_CODEX_USER_AGENT =
  "codex_cli_rs/0.50.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464";

export interface CodexAuth {
  apiKey: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _authJsonPath(codexCliHome: string | null): string {
  const home = codexCliHome
    ? path.resolve(codexCliHome)
    : (process.env.HOME ?? homedir());
  return path.join(home, ".codex", "auth.json");
}

export function loadCodexAuth(codexCliHome: string | null): CodexAuth {
  const p = _authJsonPath(codexCliHome);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    let apiKey = raw.OPENAI_API_KEY;
    if (typeof apiKey !== "string" || !apiKey.trim()) apiKey = null;

    const tokens = (raw.tokens as Record<string, unknown>) ?? {};
    const getToken = (name: string): string | null => {
      const val = tokens[name];
      if (typeof val === "string" && val.trim()) return val.trim();
      return null;
    };

    let lastRefresh = raw.last_refresh;
    if (typeof lastRefresh !== "string" || !lastRefresh.trim()) lastRefresh = null;

    return {
      apiKey: apiKey as string | null,
      accessToken: getToken("access_token"),
      refreshToken: getToken("refresh_token"),
      accountId: getToken("account_id"),
      lastRefresh: lastRefresh as string | null,
    };
  } catch {
    return {
      apiKey: null,
      accessToken: null,
      refreshToken: null,
      accountId: null,
      lastRefresh: null,
    };
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    });

    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OAuth token refresh failed: ${resp.status} ${text}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

export async function warmupCodexAuth(
  codexCliHome: string | null
): Promise<Record<string, string | null>> {
  const t0 = Date.now();
  const auth = loadCodexAuth(codexCliHome);
  const token = auth.apiKey ?? auth.accessToken;
  const t1 = Date.now();

  if (token) {
    return { status: "ready", has_token: "true" };
  }
  return { status: "no_token", has_token: "false" };
}

export async function maybeRefreshCodexAuth(
  codexCliHome: string | null,
  timeoutMs: number
): Promise<CodexAuth> {
  const auth = loadCodexAuth(codexCliHome);
  if (!auth.refreshToken) return auth;

  let tokenResp: Record<string, unknown>;
  try {
    tokenResp = await refreshAccessToken(auth.refreshToken, timeoutMs);
  } catch {
    return auth;
  }

  const access = tokenResp.access_token;
  const refresh = tokenResp.refresh_token ?? auth.refreshToken;
  if (typeof access !== "string" || !access.trim()) return auth;

  const p = _authJsonPath(codexCliHome);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) raw = {};
  } catch {
    raw = {};
  }

  let tokens = (raw.tokens as Record<string, unknown>) ?? {};
  if (typeof tokens !== "object") tokens = {};
  tokens = { ...tokens, access_token: access };
  if (typeof refresh === "string" && refresh.trim()) {
    tokens.refresh_token = refresh;
  }
  raw.tokens = tokens;
  raw.last_refresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  try {
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } catch {
    /* ignore */
  }

  return {
    apiKey: auth.apiKey,
    accessToken: access.trim(),
    refreshToken:
      typeof refresh === "string" && refresh.trim()
        ? refresh.trim()
        : auth.refreshToken!,
    accountId: auth.accountId,
    lastRefresh: (raw.last_refresh as string) ?? auth.lastRefresh,
  };
}

export function buildCodexHeaders(opts: {
  token: string;
  accountId?: string | null;
  sessionId?: string | null;
  version?: string;
  userAgent?: string;
}): Record<string, string> {
  const {
    token,
    accountId,
    sessionId,
    version = _DEFAULT_CODEX_VERSION,
    userAgent = _DEFAULT_CODEX_USER_AGENT,
  } = opts;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: "text/event-stream",
    Connection: "Keep-Alive",
    Version: version,
    "Openai-Beta": "responses=experimental",
    "Session_id": sessionId ?? crypto.randomUUID(),
    "User-Agent": userAgent,
  };
  if (accountId) {
    headers.Originator = "codex_cli_rs";
    headers["Chatgpt-Account-Id"] = accountId;
  }
  return headers;
}

export function extractCodexUsageHeaders(
  headers: Record<string, string> | Headers
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers);
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-codex-") || lower === "x-request-id") {
      out[key] = value;
    }
  }
  return out;
}

export function extractCodexToolCalls(
  response: Record<string, unknown>
): Record<string, unknown>[] {
  const output = response.output;
  if (!Array.isArray(output)) return [];

  const toolCalls: Record<string, unknown>[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const itemType = obj.type;
    const func = obj.function as Record<string, unknown> | undefined;
    let name: string | undefined = func?.name as string | undefined;
    let arguments_ = func?.arguments;

    if (
      itemType === "tool_call" ||
      itemType === "function_call" ||
      (typeof obj.call_id === "string" && typeof obj.name === "string")
    ) {
      if (name == null) name = obj.name as string;
      if (arguments_ == null) arguments_ = obj.arguments;
      let callId = obj.call_id ?? obj.id;
      if (typeof callId !== "string" || !callId) {
        callId = `call_${toolCalls.length + 1}`;
      }
      if (typeof name !== "string" || !name) name = "tool";
      if (typeof arguments_ !== "string") {
        try {
          arguments_ = JSON.stringify(arguments_ ?? {});
        } catch {
          arguments_ = "{}";
        }
      }
      toolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: arguments_ },
      });
    }
  }
  return toolCalls;
}

const _INSTRUCTIONS_CACHE: Record<string, string> = {};

function _promptDir(): string {
  // Try dist/codex_instructions first (copied at build), then src/codex_instructions
  const distDir = path.join(__dirname, "..", "codex_instructions");
  if (fs.existsSync(distDir)) return distDir;
  // Fallback: resolve from project root (2 levels up from dist/providers/)
  return path.join(__dirname, "..", "..", "src", "codex_instructions");
}

function _loadPromptFile(filename: string): string {
  if (_INSTRUCTIONS_CACHE[filename]) return _INSTRUCTIONS_CACHE[filename];
  const content = fs.readFileSync(
    path.join(_promptDir(), filename),
    "utf-8"
  );
  _INSTRUCTIONS_CACHE[filename] = content;
  return content;
}

export function codexInstructionsForModel(modelName: string): string {
  const m = (modelName ?? "").toLowerCase();
  if (m.includes("codex-max")) return _loadPromptFile("gpt-5.1-codex-max_prompt.md");
  if (m.includes("codex")) return _loadPromptFile("gpt_5_codex_prompt.md");
  if (m.includes("5.1")) return _loadPromptFile("gpt_5_1_prompt.md");
  if (m.includes("5.2")) return _loadPromptFile("gpt_5_2_prompt.md");
  return _loadPromptFile("prompt.md");
}

function _contentParts(content: unknown): Record<string, unknown>[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (typeof content === "object" && !Array.isArray(content))
    return [content as Record<string, unknown>];
  if (Array.isArray(content))
    return content.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null);
  return [{ type: "text", text: String(content) }];
}

function _extractOpenaiToolCalls(message: ChatMessage): Record<string, unknown>[] {
  const extra = (message as Record<string, unknown>).model_extra;
  let toolCalls = (extra as Record<string, unknown>)?.tool_calls;
  if (toolCalls == null) {
    const functionCall = (extra as Record<string, unknown>)?.function_call;
    if (functionCall && typeof functionCall === "object") {
      toolCalls = [{ type: "function", function: functionCall }];
    }
  }
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
}

function _appendFunctionCallsFromMessage(
  outInput: Record<string, unknown>[],
  message: ChatMessage
): void {
  const toolCalls = _extractOpenaiToolCalls(message);
  if (!toolCalls.length) return;

  for (let idx = 0; idx < toolCalls.length; idx++) {
    const call = toolCalls[idx];
    const callId =
      call.id ?? call.call_id ?? call.tool_call_id ?? `call_${idx + 1}`;
    const func = call.function as Record<string, unknown> | undefined;
    let name = func?.name ?? call.name;
    let arguments_ = func?.arguments ?? call.arguments;
    if (typeof name !== "string" || !name) continue;
    if (typeof arguments_ !== "string") {
      try {
        arguments_ = JSON.stringify(arguments_ ?? {});
      } catch {
        arguments_ = "{}";
      }
    }
    outInput.push({
      type: "function_call",
      call_id: callId,
      name,
      arguments: arguments_,
    });
  }
}

function _extractToolCallIdFromMessage(message: ChatMessage): string | null {
  let toolCallId: unknown = null;
  if (typeof message.content === "object" && message.content !== null) {
    const c = message.content as Record<string, unknown>;
    toolCallId = c.tool_call_id ?? c.call_id;
  }
  if (toolCallId == null) {
    const extra = (message as Record<string, unknown>).model_extra;
    if (extra && typeof extra === "object") {
      toolCallId = (extra as Record<string, unknown>).tool_call_id ?? (extra as Record<string, unknown>).call_id;
    }
  }
  if (toolCallId == null && "tool_call_id" in message) {
    toolCallId = (message as Record<string, unknown>).tool_call_id;
  }
  if (typeof toolCallId === "string" && toolCallId) return toolCallId;
  return null;
}

function _convertOpenaiToolForCodex(tool: Record<string, unknown>): Record<string, unknown> {
  if (tool.type !== "function") return tool;
  const func = tool.function as Record<string, unknown> | undefined;
  if (!func || typeof func !== "object") return tool;
  const name = func.name ?? tool.name;
  if (typeof name !== "string" || !name) return tool;

  const out: Record<string, unknown> = { type: "function", name };
  const description = func.description;
  if (typeof description === "string" && description) out.description = description;
  const parameters = func.parameters;
  if (parameters && typeof parameters === "object") out.parameters = parameters;
  const strict = func.strict ?? tool.strict;
  if (typeof strict === "boolean") out.strict = strict;
  return out;
}

function _convertOpenaiToolsForCodex(tools: unknown[]): Record<string, unknown>[] {
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .map(_convertOpenaiToolForCodex);
}

function _convertOpenaiToolChoiceForCodex(choice: unknown): unknown {
  if (choice === "auto" || choice === "none") return choice;
  if (choice && typeof choice === "object") {
    const c = choice as Record<string, unknown>;
    if (c.type === "function") {
      const func = c.function as Record<string, unknown> | undefined;
      if (func && typeof func.name === "string") {
        return { type: "function", name: func.name };
      }
    }
  }
  return choice;
}

export function convertChatCompletionsToCodexResponses(
  req: ChatCompletionRequest,
  opts: {
    modelName: string;
    forceStream: boolean;
    reasoningEffortOverride?: string | null;
    allowTools?: boolean;
  }
): Record<string, unknown> {
  const {
    modelName,
    forceStream,
    reasoningEffortOverride,
    allowTools = false,
  } = opts;

  const instructions = codexInstructionsForModel(modelName);

  const out: Record<string, unknown> = {
    model: modelName,
    stream: Boolean(forceStream),
    instructions,
    input: [] as Record<string, unknown>[],
    store: false,
  };

  let effort: string | null = null;
  if (
    reasoningEffortOverride === "low" ||
    reasoningEffortOverride === "medium" ||
    reasoningEffortOverride === "high"
  ) {
    effort = reasoningEffortOverride;
  } else {
    const extra = (req as Record<string, unknown>).model_extra as Record<string, unknown> | undefined;
    if (extra) {
      const re = extra.reasoning_effort;
      if (typeof re === "string" && re.trim()) effort = re.trim() || null;
      if (effort == null) {
        const reasoning = extra.reasoning;
        if (reasoning && typeof reasoning === "object") {
          const r = reasoning as Record<string, unknown>;
          const rEffort = r.effort;
          if (typeof rEffort === "string" && rEffort.trim())
            effort = rEffort.trim() || null;
        }
      }
    }
  }
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    effort = "medium";
  }
  (out as Record<string, unknown>).reasoning = { effort, summary: "auto" };

  const reqExtra = (req as Record<string, unknown>).model_extra as Record<string, unknown> | undefined;
  if (allowTools && reqExtra) {
    const tools = reqExtra.tools;
    if (Array.isArray(tools) && tools.length) {
      (out as Record<string, unknown>).tools = _convertOpenaiToolsForCodex(tools);
    }
    const toolChoice = reqExtra.tool_choice;
    if (toolChoice !== undefined) {
      (out as Record<string, unknown>).tool_choice = _convertOpenaiToolChoiceForCodex(toolChoice);
    }
    const parallelToolCalls = reqExtra.parallel_tool_calls;
    if (parallelToolCalls !== undefined) {
      (out as Record<string, unknown>).parallel_tool_calls = parallelToolCalls;
    }
  }

  if (!allowTools) {
    (out as Record<string, unknown>).tool_choice = "none";
    (out as Record<string, unknown>).parallel_tool_calls = false;
  }
  (out as Record<string, unknown>).include = ["reasoning.encrypted_content"];

  const input = out.input as Record<string, unknown>[];

  for (const message of req.messages) {
    let role = message.role;

    if (role === "tool") {
      const toolCallId = _extractToolCallIdFromMessage(message);
      if (typeof toolCallId !== "string" || !toolCallId) {
        role = "user";
      } else {
        input.push({
          type: "function_call_output",
          call_id: toolCallId,
          output: String(message.content ?? ""),
        });
        continue;
      }
    }

    if (role === "system" || role === "developer") role = "user";

    const msg: Record<string, unknown> = {
      type: "message",
      role,
      content: [] as Record<string, unknown>[],
    };
    const contentArr = msg.content as Record<string, unknown>[];

    const parts = _contentParts(message.content);
    for (const part of parts) {
      const ptype = part.type;
      const text = part.text;
      if (ptype === "text" && typeof text === "string") {
        contentArr.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        });
      }
      if (
        (ptype === "image_url" || ptype === "input_image") &&
        role === "user"
      ) {
        const image = part.image_url;
        let url: string | undefined;
        if (image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") {
          url = (image as Record<string, unknown>).url as string;
        } else if (typeof image === "string") {
          url = image;
        }
        if (typeof url === "string" && url) {
          contentArr.push({ type: "input_image", image_url: url });
        }
      }
    }

    input.push(msg);
    if (role === "assistant") {
      _appendFunctionCallsFromMessage(input, message);
    }
  }

  return out;
}

export interface IterCodexResponsesEventsOpts {
  baseUrl: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  timeoutSeconds: number;
  eventCallback?: (evt: Record<string, unknown>) => void;
  responseHeadersCb?: (headers: Record<string, string>) => void;
}

export async function* iterCodexResponsesEvents(
  opts: IterCodexResponsesEventsOpts
): AsyncGenerator<Record<string, unknown>> {
  const {
    baseUrl,
    headers,
    payload,
    timeoutSeconds,
    eventCallback,
    responseHeadersCb,
  } = opts;

  const url = baseUrl.replace(/\/$/, "") + "/responses";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (resp.status !== 200) {
    const body = await resp.text();
    const msg = body.trim();
    throw new Error(
      msg ? `codex responses failed: ${resp.status}: ${msg}` : `codex responses failed: ${resp.status}`
    );
  }

  if (responseHeadersCb) {
    try {
      const h: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        h[k] = v;
      });
      responseHeadersCb(h);
    } catch {
      /* ignore */
    }
  }

  const body = resp.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:"))
        continue;
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const obj = JSON.parse(data) as Record<string, unknown>;
        if (obj && typeof obj === "object") {
          if (eventCallback) {
            try {
              eventCallback(obj);
            } catch {
              /* ignore */
            }
          }
          yield obj;
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }
}

export async function collectCodexResponsesTextAndUsage(
  events: AsyncIterable<Record<string, unknown>>
): Promise<[string, Record<string, unknown> | null, Record<string, unknown>[] | null]> {
  const chunks: string[] = [];
  let usage: Record<string, unknown> | null = null;
  let toolCalls: Record<string, unknown>[] | null = null;

  for await (const evt of events) {
    const t = evt.type;
    if (t === "response.output_text.delta" && typeof evt.delta === "string") {
      chunks.push(evt.delta);
    }
    if (
      t === "response.output_text.done" &&
      !chunks.length &&
      typeof evt.text === "string"
    ) {
      chunks.push(evt.text);
    }
    if (t === "response.completed") {
      const resp = (evt.response as Record<string, unknown>) ?? {};
      const u = resp.usage;
      if (u && typeof u === "object") {
        const usageObj = u as Record<string, unknown>;
        const promptTokens = Number(usageObj.input_tokens ?? 0) || 0;
        const completionTokens = Number(usageObj.output_tokens ?? 0) || 0;
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details:
            typeof usageObj.input_tokens_details === "object"
              ? usageObj.input_tokens_details
              : {},
          completion_tokens_details:
            typeof usageObj.output_tokens_details === "object"
              ? usageObj.output_tokens_details
              : {},
        };
      }
      if (resp && typeof resp === "object") {
        const parsed = extractCodexToolCalls(resp as Record<string, unknown>);
        if (parsed.length) toolCalls = parsed;
      }
      break;
    }
  }

  return [chunks.join(""), usage, toolCalls];
}
