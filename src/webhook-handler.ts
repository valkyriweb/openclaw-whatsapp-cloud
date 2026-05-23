/**
 * Self-contained HTTP route handler for the Cloud API webhook. Extracted
 * from `channel.ts` so it can be exercised in unit tests with mock req/res
 * and a fake plugin-sdk shim — the live `startAccount` path threads in the
 * real OpenClaw SDK, the test path threads in a stub.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type CloudStatusItem,
  IdempotencyCache,
  handleSubscribeVerification,
  parseCloudWebhook,
} from "./inbound.js";
import type { CloudAccountConfig, NormalizedInboundMessage } from "./types.js";

/**
 * Subset of `openclaw/plugin-sdk/webhook-ingress` we depend on. Kept narrow
 * so tests can supply a minimal stub.
 */
export interface CloudWebhookSdk {
  applyBasicWebhookRequestGuards: (params: {
    req: IncomingMessage;
    res: ServerResponse;
    allowMethods?: readonly string[];
    rateLimiter?: unknown;
    rateLimitKey?: string;
    requireJsonContentType?: boolean;
  }) => boolean;
  readRequestBodyWithLimit: (
    req: IncomingMessage,
    options: { maxBytes: number; timeoutMs?: number; encoding?: BufferEncoding },
  ) => Promise<string>;
  isRequestBodyLimitError: (err: unknown) => boolean;
  requestBodyErrorToText: (err: unknown) => string;
}

export interface CloudWebhookHandlerOptions {
  accountId: string;
  accountConfig: CloudAccountConfig;
  idempotency: IdempotencyCache;
  sdk: CloudWebhookSdk;
  /** Forwarded to applyBasicWebhookRequestGuards. */
  rateLimiter?: unknown;
  /** Stable key under which the IP-scoped rate limiter buckets requests. */
  rateLimitKey?: (req: IncomingMessage) => string;
  /** Max accepted body. Defaults to 1 MiB — Meta webhook bodies stay tiny. */
  maxBodyBytes?: number;
  /** Read timeout for the body. Defaults to 30s. */
  bodyTimeoutMs?: number;
  onMessages?: (messages: NormalizedInboundMessage[]) => void;
  onStatuses?: (statuses: CloudStatusItem[]) => void;
  log?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
  };
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;

/**
 * Build the (req, res) handler the gateway mounts at
 * `/webhooks/whatsapp-cloud/<accountId>`. Returns `true` once the response
 * has been written; the SDK uses the truthy return as "I handled it".
 *
 * Branch matrix:
 *   - GET  → hub.challenge verification (`200 text/plain` on match, `403` otherwise).
 *   - POST + missing/invalid X-Hub-Signature-256 → `401`.
 *   - POST + valid signature + new wamid → `200`, fan out messages/statuses.
 *   - POST + valid signature + duplicate wamid → `200`, no fan out.
 *   - POST + malformed JSON → `400`.
 *   - Method-guard / body-cap failures bubble through the SDK helpers.
 */
export function createCloudWebhookHandler(opts: CloudWebhookHandlerOptions) {
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;

  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (req.method === "GET") {
      const query = parseQuery(req.url ?? "");
      const verdict = handleSubscribeVerification({
        query,
        verifyToken: opts.accountConfig.verifyToken,
      });
      res.statusCode = verdict.status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(verdict.body);
      return true;
    }

    if (!opts.sdk.applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
      rateLimiter: opts.rateLimiter,
      rateLimitKey: opts.rateLimitKey?.(req),
      requireJsonContentType: true,
    })) {
      return true;
    }

    let rawBody: string;
    try {
      rawBody = await opts.sdk.readRequestBodyWithLimit(req, {
        maxBytes,
        timeoutMs,
        encoding: "utf8",
      });
    } catch (err) {
      if (res.headersSent) return true;
      if (opts.sdk.isRequestBodyLimitError(err)) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(opts.sdk.requestBodyErrorToText(err));
        return true;
      }
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("bad request");
      return true;
    }

    const parsed = parseCloudWebhook({
      rawBody,
      headers: req.headers,
      appSecret: opts.accountConfig.appSecret,
      idempotency: opts.idempotency,
      accountId: opts.accountId,
    });

    if (!parsed.ok) {
      const status =
        parsed.reason === "bad_signature" || parsed.reason === "missing_signature"
          ? 401
          : 400;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: parsed.reason }));
      return true;
    }

    // ACK fast — Meta retries any non-2xx and considers the receiver dead
    // if it doesn't respond within ~20s. Fan-out happens after the ACK.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        delivered: parsed.messages.length,
        statuses: parsed.statuses.length,
      }),
    );

    if (parsed.messages.length > 0 && opts.onMessages) {
      try { opts.onMessages(parsed.messages); }
      catch (err) { opts.log?.error?.(`[${opts.accountId}] onMessages: ${String(err)}`); }
    }
    if (parsed.statuses.length > 0 && opts.onStatuses) {
      try { opts.onStatuses(parsed.statuses); }
      catch (err) { opts.log?.error?.(`[${opts.accountId}] onStatuses: ${String(err)}`); }
    }
    return true;
  };
}

export function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf("?");
  if (idx === -1) return q;
  const params = new URLSearchParams(url.slice(idx + 1));
  for (const [k, v] of params) q[k] = v;
  return q;
}
