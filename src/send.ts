import {
  DEFAULT_CLOUD_API_VERSION,
  DEFAULT_CLOUD_BASE_URL,
} from "./config-schema.js";
import type {
  CloudAccountConfig,
  MediaKind,
  SendResult,
  TemplateComponent,
} from "./types.js";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/** WhatsApp text body limit per Meta docs. */
export const WHATSAPP_TEXT_LIMIT = 4096;

/**
 * Meta error code emitted when a non-template message is sent outside the
 * 24h customer-service window. Docs:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const META_ERROR_OUTSIDE_SERVICE_WINDOW = 131047;

/**
 * Error thrown when Meta rejects a non-template send because the recipient
 * is outside the 24h customer-service window. The caller should retry with
 * `sendTemplate(...)` using an approved template.
 */
export class OutsideServiceWindowError extends Error {
  readonly code = META_ERROR_OUTSIDE_SERVICE_WINDOW;
  readonly recipient?: string;
  constructor(message: string, opts: { recipient?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "OutsideServiceWindowError";
    if (opts.recipient !== undefined) this.recipient = opts.recipient;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/**
 * Extract the structured Meta error code from a Graph API error response body.
 * Meta puts it at either `error.code` (numeric) or, for tool-level errors,
 * `error.error_data.details`. Returns null if the body is not a recognizable
 * Graph error envelope.
 */
export function extractMetaErrorCode(rawText: string): number | null {
  try {
    const parsed = JSON.parse(rawText) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === "number" && Number.isFinite(code)) return code;
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 * Supports both delta-seconds (`"30"`) and HTTP-date formats.
 * Returns null if the header is missing or malformed.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs;
    return Math.max(0, Math.min(delta, MAX_RETRY_AFTER_MS));
  }
  return null;
}

export interface SendTextOptions {
  to: string;
  text: string;
  replyToMessageId?: string;
}

export interface SendMediaOptions {
  to: string;
  kind: MediaKind;
  /** Public URL Meta will fetch the media from. Mutually exclusive with `mediaId`. */
  link?: string;
  /** Pre-uploaded media id from `POST /{phone}/media`. */
  mediaId?: string;
  caption?: string;
  filename?: string;
  replyToMessageId?: string;
}

export interface SendTemplateOptions {
  to: string;
  /** Approved template name registered against the WABA. */
  name: string;
  /** BCP-47 / Meta language code (e.g. `en_US`). */
  languageCode: string;
  components?: TemplateComponent[];
  replyToMessageId?: string;
}

export interface SendReactionOptions {
  to: string;
  messageId: string;
  /** Emoji, or empty string to clear. */
  emoji: string;
}

export interface MarkReadOptions {
  messageId: string;
  typing?: boolean;
}

export interface CloudClientDeps {
  /** Injected for testing — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for testing — defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * Normalize a phone number to the bare-digits form Meta expects on the send
 * endpoint. Accepts `+`, spaces, and the `<channel-id>:<phone>` prefix
 * OpenClaw uses for outbound delivery.
 */
export function toCloudPhoneNumber(raw: string): string {
  const withoutChannelPrefix = raw.replace(/^whatsapp-cloud:/i, "");
  const trimmed = withoutChannelPrefix.trim();
  const digits = trimmed.replace(/^\+/, "").replace(/\s+/g, "");
  if (!/^\d+$/.test(digits)) {
    throw new Error(`invalid phone number: ${raw}`);
  }
  return digits;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve `https://graph.facebook.com/v25.0` (or overrides) for an account. */
export function resolveApiRoot(account: CloudAccountConfig): string {
  const base = (account.apiBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, "");
  const version = account.apiVersion ?? DEFAULT_CLOUD_API_VERSION;
  return `${base}/${version}`;
}

/**
 * Create a Cloud API client bound to a specific account configuration.
 * Stateless beyond its config + retry policy; safe to share.
 */
export function createCloudClient(
  account: CloudAccountConfig,
  deps: CloudClientDeps = {},
) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const apiRoot = resolveApiRoot(account);
  const sendUrl = `${apiRoot}/${encodeURIComponent(account.phoneNumberId)}/messages`;

  async function postJson(body: unknown): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(sendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${account.accessToken}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxRetries) break;
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      const rawText = await res.text();
      if (res.ok) {
        if (!rawText) return {};
        try {
          return JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          throw new Error(`whatsapp-cloud: non-JSON response body: ${rawText.slice(0, 200)}`);
        }
      }
      if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        const backoffMs = retryAfterMs ?? BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoffMs);
        continue;
      }
      const metaCode = extractMetaErrorCode(rawText);
      if (metaCode === META_ERROR_OUTSIDE_SERVICE_WINDOW) {
        throw new OutsideServiceWindowError(
          "whatsapp-cloud: recipient is outside the 24h customer-service window; " +
            "only approved templates can be sent. Use sendTemplate(...) instead.",
          { cause: rawText.slice(0, 500) },
        );
      }
      throw new Error(`whatsapp-cloud: HTTP ${res.status} — ${rawText.slice(0, 500)}`);
    }
    throw lastError ?? new Error("whatsapp-cloud: exhausted retries");
  }

  function extractMessageId(parsed: Record<string, unknown>): string {
    const messages = parsed["messages"];
    if (Array.isArray(messages) && messages.length > 0) {
      const first = messages[0];
      if (first && typeof first === "object" && typeof (first as { id?: unknown }).id === "string") {
        return (first as { id: string }).id;
      }
    }
    throw new Error(
      `whatsapp-cloud: response missing messages[0].id — ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }

  /**
   * Send a text message. Chunks at WHATSAPP_TEXT_LIMIT (4096) — Meta hard-rejects
   * longer bodies. Returns the SendResult for the *last* chunk so the caller has
   * a wamid for reply-quoting / status callbacks.
   */
  async function sendText(opts: SendTextOptions): Promise<SendResult> {
    const to = toCloudPhoneNumber(opts.to);
    const chunks = chunkText(opts.text);
    let last: SendResult | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: chunks[i], preview_url: false },
      };
      // Only quote on the first chunk — quoting every chunk would spam the thread.
      if (opts.replyToMessageId && i === 0) {
        body.context = { message_id: opts.replyToMessageId };
      }
      const parsed = await postJson(body);
      last = {
        channel: "whatsapp-cloud",
        messageId: extractMessageId(parsed),
        chatId: to,
      };
    }
    if (!last) throw new Error("whatsapp-cloud: sendText produced no chunks");
    return last;
  }

  async function sendMedia(opts: SendMediaOptions): Promise<SendResult> {
    if (!opts.link && !opts.mediaId) {
      throw new Error("whatsapp-cloud sendMedia: pass either link or mediaId");
    }
    const to = toCloudPhoneNumber(opts.to);
    const mediaField: Record<string, unknown> = {};
    if (opts.link) mediaField.link = opts.link;
    if (opts.mediaId) mediaField.id = opts.mediaId;
    if (opts.caption && (opts.kind === "image" || opts.kind === "video" || opts.kind === "document")) {
      mediaField.caption = opts.caption;
    }
    if (opts.filename && opts.kind === "document") {
      mediaField.filename = opts.filename;
    }
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: opts.kind,
      [opts.kind]: mediaField,
    };
    if (opts.replyToMessageId) {
      body.context = { message_id: opts.replyToMessageId };
    }
    const parsed = await postJson(body);
    return { channel: "whatsapp-cloud", messageId: extractMessageId(parsed), chatId: to };
  }

  async function sendTemplate(opts: SendTemplateOptions): Promise<SendResult> {
    const to = toCloudPhoneNumber(opts.to);
    const template: Record<string, unknown> = {
      name: opts.name,
      language: { code: opts.languageCode },
    };
    if (opts.components && opts.components.length > 0) {
      template.components = opts.components;
    }
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template,
    };
    if (opts.replyToMessageId) {
      body.context = { message_id: opts.replyToMessageId };
    }
    const parsed = await postJson(body);
    return { channel: "whatsapp-cloud", messageId: extractMessageId(parsed), chatId: to };
  }

  async function sendReaction(opts: SendReactionOptions): Promise<SendResult> {
    const to = toCloudPhoneNumber(opts.to);
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "reaction",
      reaction: { message_id: opts.messageId, emoji: opts.emoji },
    };
    const parsed = await postJson(body);
    return { channel: "whatsapp-cloud", messageId: extractMessageId(parsed), chatId: to };
  }

  /**
   * Mark an inbound message as read (blue ticks), optionally surfacing a
   * typing indicator while the agent thinks. The indicator auto-clears after
   * ~25s or when we send a reply.
   */
  async function markRead(opts: MarkReadOptions): Promise<void> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: opts.messageId,
    };
    if (opts.typing) {
      body.typing_indicator = { type: "text" };
    }
    await postJson(body);
  }

  return {
    sendText,
    sendMedia,
    sendTemplate,
    sendReaction,
    markRead,
    sendUrl,
  };
}

export type CloudClient = ReturnType<typeof createCloudClient>;

/** Split `text` into <=WHATSAPP_TEXT_LIMIT chunks, preserving byte order. */
export function chunkText(text: string): string[] {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += WHATSAPP_TEXT_LIMIT) {
    chunks.push(text.slice(i, i + WHATSAPP_TEXT_LIMIT));
  }
  return chunks;
}
