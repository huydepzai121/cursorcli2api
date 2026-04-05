/**
 * Anthropic Messages API compatibility module.
 * Converts between Anthropic Messages API format and internal ChatCompletionRequest.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import type { ChatCompletionRequest, ChatMessage } from "./openai-compat.js";
import { normalizeMessageContent } from "./openai-compat.js";

// ─────────────────────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────────────────────

const AnthropicContentBlockSchema = z.union([
  z.string(),
  z.array(
    z
      .object({
        type: z.string(),
      })
      .passthrough()
  ),
]);

const AnthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: AnthropicContentBlockSchema,
  })
  .passthrough();

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(AnthropicMessageSchema).min(1),
    max_tokens: z.number().int().positive(),
    system: z.unknown().optional(),
    stream: z.boolean().optional().default(false),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Request conversion: Anthropic -> internal ChatCompletionRequest
// ─────────────────────────────────────────────────────────────────────────────

function anthropicSystemToString(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text"
      )
      .map((block) => String(block.text ?? ""))
      .join("\n");
  }
  return String(system);
}

function anthropicContentToChatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      parts.push({ type: "text", text: String(b.text ?? "") });
    } else if (b.type === "image") {
      const source = b.source as Record<string, unknown> | undefined;
      if (source?.type === "base64") {
        const mediaType = String(source.media_type ?? "image/png");
        const data = String(source.data ?? "");
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      }
    }
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text as string;
  }
  return parts.length > 0 ? parts : "";
}

export function anthropicRequestToChatRequest(req: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  const systemText = anthropicSystemToString(req.system);
  if (systemText.trim()) {
    messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    messages.push({
      role: msg.role as ChatMessage["role"],
      content: anthropicContentToChatContent(msg.content),
    });
  }

  return {
    model: req.model,
    messages,
    stream: req.stream ?? false,
    max_tokens: req.max_tokens ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response conversion: internal -> Anthropic Messages format
// ─────────────────────────────────────────────────────────────────────────────

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function chatCompletionToAnthropicResponse(
  chat: Record<string, unknown>,
  requestModel: string
): AnthropicMessagesResponse {
  let text = "";
  const choices = (chat.choices as unknown[]) ?? [];
  if (choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = (first.message as Record<string, unknown>) ?? {};
    text = normalizeMessageContent(message.content);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  const usage = chat.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    inputTokens = Math.floor(Number(usage.prompt_tokens) || 0);
    outputTokens = Math.floor(Number(usage.completion_tokens) || 0);
  }

  const finishReason = (choices[0] as Record<string, unknown>)?.finish_reason;
  let stopReason: "end_turn" | "max_tokens" | "stop_sequence" | null = "end_turn";
  if (finishReason === "length") stopReason = "max_tokens";
  else if (finishReason === "stop") stopReason = "end_turn";

  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming helpers: Anthropic SSE format
// ─────────────────────────────────────────────────────────────────────────────

export function anthropicStreamMessageStart(
  messageId: string,
  model: string,
  inputTokens: number
): string {
  const msg = {
    id: messageId,
    type: "message",
    role: "assistant",
    content: [],
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };
  return `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: msg })}\n\n`;
}

export function anthropicStreamContentBlockStart(index: number): string {
  return `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  })}\n\n`;
}

export function anthropicStreamContentBlockDelta(index: number, text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  })}\n\n`;
}

export function anthropicStreamContentBlockStop(index: number): string {
  return `event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop",
    index,
  })}\n\n`;
}

export function anthropicStreamMessageDelta(
  stopReason: "end_turn" | "max_tokens" | "stop_sequence",
  outputTokens: number
): string {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })}\n\n`;
}

export function anthropicStreamMessageStop(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

export function anthropicStreamPing(): string {
  return `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;
}

export function anthropicErrorResponse(message: string, statusCode: number): Response {
  const typeMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    422: "invalid_request_error",
    429: "rate_limit_error",
    500: "api_error",
    529: "overloaded_error",
  };
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: typeMap[statusCode] ?? "api_error",
        message,
      },
    }),
    { status: statusCode, headers: { "Content-Type": "application/json" } }
  );
}
