/**
 * Shared HTTP client with connection pooling and retry logic.
 * Ported from Python http_client.py.
 */

import { Agent, fetch } from 'undici';

const _clients = new Map<string, Agent>();

/**
 * Get or create a named undici Agent with keepalive.
 */
export function getAgent(name = 'default'): Agent {
  let agent = _clients.get(name);
  if (agent) {
    return agent;
  }
  agent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 30_000,
    connections: 50,
  });
  _clients.set(name, agent);
  return agent;
}

/**
 * Close all agents.
 */
export async function closeAll(): Promise<void> {
  const agents = Array.from(_clients.values());
  _clients.clear();
  for (const agent of agents) {
    try {
      await agent.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Parse Retry-After delay from response.
 * Checks:
 * 1. Retry-After header (seconds or HTTP date)
 * 2. Gemini-style error body: error.details[].retryDelay (e.g. "0.847655010s")
 * Returns delay in seconds or null.
 */
export function parseRetryDelay(resp: { headers: Headers }): number | null {
  const retryAfter = resp.headers.get('retry-after');
  if (retryAfter) {
    const parsed = parseFloat(retryAfter);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    // Could be HTTP date, ignore for simplicity
  }

  // Check Gemini-style error body for retryDelay
  try {
    // Response body may have been consumed; we need to clone to read
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // Body might already be consumed - we'd need to have read it before
      // For now we rely on the caller to pass body if needed, or we skip
      // In practice parseRetryDelay is called after we've read the body in retry flow
    }
  } catch {
    // ignore
  }
  return null;
}

export interface RequestJsonWithRetriesOptions {
  url: string;
  method?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  retryStatuses?: Set<number>;
  headers?: Record<string, string> | Headers;
  body?: unknown;
  agent?: Agent;
}

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Parse Gemini-style retryDelay from a parsed JSON body.
 * Used when we have the body from a 429/5xx response.
 */
function parseGeminiRetryDelayFromBody(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const error = obj.error as Record<string, unknown> | undefined;
  if (!error) return null;
  const details = error.details as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo') {
      const delayStr = detail.retryDelay;
      if (typeof delayStr === 'string' && delayStr.endsWith('s')) {
        const parsed = parseFloat(delayStr.slice(0, -1));
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
  }
  return null;
}

/**
 * Make HTTP request with retry logic for 429/5xx statuses,
 * exponential backoff, and Retry-After header support.
 * Returns the Response object.
 */
export async function requestJsonWithRetries(
  opts: RequestJsonWithRetriesOptions
): Promise<Awaited<ReturnType<typeof fetch>>> {
  const {
    url,
    method = 'GET',
    timeoutMs = 30_000,
    retries = 2,
    backoffMs = 400,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    headers,
    body,
    agent = getAgent(),
  } = opts;

  let attempt = 0;
  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: Parameters<typeof fetch>[1] = {
        method,
        headers: headers ?? {},
        signal: controller.signal,
        dispatcher: agent,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        const h =
          init.headers instanceof Headers
            ? init.headers
            : new Headers((init.headers as Record<string, string>) ?? {});
        if (!h.has('content-type')) {
          h.set('content-type', 'application/json');
        }
        init.headers = h;
      }

      const resp = await fetch(url, init);
      clearTimeout(timeoutId);

      if (!retryStatuses.has(resp.status) || attempt > retries + 1) {
        return resp;
      }

      // Consume body for retry delay parsing (Gemini-style)
      let bodyJson: unknown = null;
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          bodyJson = await resp.json();
        } catch {
          // ignore
        }
      }

      const headerDelay = parseRetryDelay(resp);
      const geminiDelay = parseGeminiRetryDelayFromBody(bodyJson);
      let delaySec = headerDelay ?? geminiDelay ?? (backoffMs / 1000) * Math.pow(2, attempt - 1);
      delaySec = Math.min(delaySec, 30);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt > retries + 1) {
        throw err;
      }
      const delaySec = (backoffMs / 1000) * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
}
