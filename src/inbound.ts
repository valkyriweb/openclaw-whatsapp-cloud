import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedInboundMessage, InboundMessageType } from "./types.js";

/**
 * LRU-ish idempotency cache. Backed by a Map (insertion-ordered in V8) so we
 * can evict the oldest entry when we exceed capacity without extra bookkeeping.
 * A Set would grow unbounded and leak memory under load.
 */
export class IdempotencyCache {
  private readonly store = new Map<string, number>();
  constructor(private readonly max: number = 1000) {}

  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Mark `key` as seen. Returns true if it was already known (caller should
   * skip processing) and false if this is the first time.
   */
  seen(key: string): boolean {
    if (this.store.has(key)) {
      this.store.delete(key);
      this.store.set(key, Date.now());
      return true;
    }
    this.store.set(key, Date.now());
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Verify Meta's `X-Hub-Signature-256: sha256=<hex>` header.
 *
 * The signature is `HMAC-SHA256(appSecret, rawBody)` hex-encoded. We use
 * `timingSafeEqual` to avoid leaking the secret via timing side-channels.
 * Returns false rather than throwing on malformed input so the caller can
 * handle all "rejected" cases uniformly.
 */
export function verifyWebhookSignature(params: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined | null;
  appSecret: string;
}): boolean {
  if (!params.signatureHeader) return false;
  const provided = params.signatureHeader.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const bodyBuffer =
    typeof params.rawBody === "string"
      ? Buffer.from(params.rawBody, "utf8")
      : params.rawBody;
  const expected = createHmac("sha256", params.appSecret).update(bodyBuffer).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided.toLowerCase(), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const KNOWN_TYPES: InboundMessageType[] = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "interactive",
  "button",
  "reaction",
];

function normalizeType(type: unknown): InboundMessageType {
  if (typeof type === "string" && (KNOWN_TYPES as string[]).includes(type)) {
    return type as InboundMessageType;
  }
  return "unknown";
}

function normalizeTimestamp(ts: unknown): string | undefined {
  if (typeof ts !== "string" && typeof ts !== "number") return undefined;
  const asNumber = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(asNumber) || asNumber <= 0) return undefined;
  const d = new Date(asNumber * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function toE164(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d+$/.test(trimmed)) return "+" + trimmed;
  return trimmed;
}

/**
 * One `messages[]` entry from a Meta webhook, plus the `contacts[]` lookup
 * and the parent `phone_number_id` carried alongside it so account selection
 * and contact-name enrichment can happen in one pass.
 */
export interface CloudWebhookItem {
  message: Record<string, unknown>;
  contact?: Record<string, unknown>;
  phoneNumberId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * One `statuses[]` entry — sent/delivered/read callbacks. Surfaced so
 * downstream consumers can wire delivery tracking; not converted to a
 * NormalizedInboundMessage.
 */
export interface CloudStatusItem {
  status: string;
  messageId: string;
  recipientId?: string;
  timestamp?: string;
  raw: Record<string, unknown>;
}

/**
 * Walk Meta's `entry[].changes[].value` envelope and yield one item per
 * inbound message, joined with its `contacts[]` profile when present.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export function extractItems(payload: unknown): {
  messages: CloudWebhookItem[];
  statuses: CloudStatusItem[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("whatsapp-cloud webhook: payload must be a JSON object");
  }
  const p = payload as Record<string, unknown>;
  if (p.object !== "whatsapp_business_account") {
    throw new Error(
      `whatsapp-cloud webhook: unexpected object=${JSON.stringify(p.object)}`,
    );
  }
  const entries = Array.isArray(p.entry) ? (p.entry as Array<Record<string, unknown>>) : [];
  const messages: CloudWebhookItem[] = [];
  const statuses: CloudStatusItem[] = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes)
      ? (entry.changes as Array<Record<string, unknown>>)
      : [];
    for (const change of changes) {
      if (change.field !== "messages") continue;
      const value = (change.value && typeof change.value === "object"
        ? change.value
        : {}) as Record<string, unknown>;
      const metadata = (value.metadata && typeof value.metadata === "object"
        ? value.metadata
        : undefined) as Record<string, unknown> | undefined;
      const phoneNumberId =
        metadata && typeof metadata.phone_number_id === "string"
          ? metadata.phone_number_id
          : undefined;
      const contacts = Array.isArray(value.contacts)
        ? (value.contacts as Array<Record<string, unknown>>)
        : [];
      const contactByWaId = new Map<string, Record<string, unknown>>();
      for (const c of contacts) {
        const waId = typeof c.wa_id === "string" ? c.wa_id : undefined;
        if (waId) contactByWaId.set(waId, c);
      }
      const inbound = Array.isArray(value.messages)
        ? (value.messages as Array<Record<string, unknown>>)
        : [];
      for (const m of inbound) {
        const from = typeof m.from === "string" ? m.from : undefined;
        messages.push({
          message: m,
          contact: from ? contactByWaId.get(from) : undefined,
          phoneNumberId,
          metadata,
        });
      }
      const statusEntries = Array.isArray(value.statuses)
        ? (value.statuses as Array<Record<string, unknown>>)
        : [];
      for (const s of statusEntries) {
        const id = typeof s.id === "string" ? s.id : undefined;
        const status = typeof s.status === "string" ? s.status : undefined;
        if (!id || !status) continue;
        statuses.push({
          status,
          messageId: id,
          recipientId: typeof s.recipient_id === "string" ? s.recipient_id : undefined,
          timestamp: normalizeTimestamp(s.timestamp),
          raw: s,
        });
      }
    }
  }
  return { messages, statuses };
}

/**
 * Translate one Meta `messages[]` entry into an OpenClaw-native inbound
 * message. Returns null for entries that should be silently dropped (missing
 * required fields, unknown shape). Echoes of our own sends are not emitted
 * by Meta into the inbound `messages[]` array — they appear in `statuses[]`
 * — so no echo-filter is needed here.
 */
export function normalizeItem(
  item: CloudWebhookItem,
  accountId: string,
): NormalizedInboundMessage | null {
  const m = item.message;
  const from = toE164(m.from);
  const messageId = typeof m.id === "string" ? m.id : undefined;
  const timestamp = normalizeTimestamp(m.timestamp);
  if (!from || !messageId || !timestamp) return null;

  const type = normalizeType(m.type);

  let text: string | undefined;
  if (type === "text") {
    const textField = m.text;
    if (textField && typeof textField === "object") {
      const body = (textField as { body?: unknown }).body;
      if (typeof body === "string") text = body;
    }
  }
  // Interactive replies (button_reply / list_reply) carry their selected
  // title under message.interactive.{button_reply,list_reply}.title — surface
  // that as text so the agent sees something meaningful.
  if (text === undefined && type === "interactive") {
    const interactive = m.interactive as Record<string, unknown> | undefined;
    if (interactive && typeof interactive === "object") {
      for (const key of ["button_reply", "list_reply"] as const) {
        const r = interactive[key];
        if (r && typeof r === "object") {
          const title = (r as { title?: unknown }).title;
          if (typeof title === "string") {
            text = title;
            break;
          }
        }
      }
    }
  }
  // Button (template quick-reply) carries message.button.{payload,text}.
  if (text === undefined && type === "button") {
    const button = m.button as Record<string, unknown> | undefined;
    if (button && typeof button === "object") {
      const t = (button as { text?: unknown }).text;
      const payload = (button as { payload?: unknown }).payload;
      if (typeof t === "string") text = t;
      else if (typeof payload === "string") text = payload;
    }
  }
  // Caption on media counts as the inbound text body.
  if (text === undefined && (type === "image" || type === "video" || type === "document")) {
    const typed = m[String(type)];
    if (typed && typeof typed === "object") {
      const caption = (typed as { caption?: unknown }).caption;
      if (typeof caption === "string" && caption.length > 0) text = caption;
    }
  }

  // Media id + mime live under message.<type>.{id,mime_type} for image/audio/video/document/sticker.
  let mediaId: string | undefined;
  let mediaMimeType: string | undefined;
  if (type === "image" || type === "audio" || type === "video" || type === "document" || type === "sticker") {
    const typed = m[type];
    if (typed && typeof typed === "object") {
      const id = (typed as { id?: unknown }).id;
      const mime = (typed as { mime_type?: unknown }).mime_type;
      if (typeof id === "string") mediaId = id;
      if (typeof mime === "string") mediaMimeType = mime;
    }
  }

  // Reply context — Meta uses `context.id` (a wamid).
  let replyToMessageId: string | undefined;
  const context = m.context as { id?: unknown } | undefined;
  if (context && typeof context === "object" && typeof context.id === "string") {
    replyToMessageId = context.id;
  }

  // Sender display name from the contacts[] entry.
  let fromName: string | undefined;
  const contact = item.contact;
  if (contact && typeof contact === "object") {
    const profile = (contact as { profile?: unknown }).profile;
    if (profile && typeof profile === "object") {
      const name = (profile as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) fromName = name;
    }
  }

  const out: NormalizedInboundMessage = {
    channelId: "whatsapp-cloud",
    accountId,
    messageId,
    from,
    timestamp,
    type,
    raw: item,
  };
  if (text !== undefined) out.text = text;
  if (fromName !== undefined) out.fromName = fromName;
  if (mediaId !== undefined) out.mediaId = mediaId;
  if (mediaMimeType !== undefined) out.mediaMimeType = mediaMimeType;
  if (replyToMessageId !== undefined) out.replyToMessageId = replyToMessageId;
  return out;
}

export interface ParseWebhookInput {
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  appSecret: string;
  idempotency: IdempotencyCache;
  accountId: string;
}

export interface ParseWebhookResult {
  ok: boolean;
  reason?: "missing_signature" | "bad_signature" | "duplicate" | "bad_payload";
  messages: NormalizedInboundMessage[];
  statuses: CloudStatusItem[];
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

/**
 * End-to-end Meta webhook parse: verify `X-Hub-Signature-256`, dedupe by
 * wamid, parse + normalize messages. Returns a structured result so the
 * caller can respond with the right HTTP status (401 on bad sig, 200 on
 * duplicate, 200 on ok, 400 on bad payload).
 */
export function parseCloudWebhook(input: ParseWebhookInput): ParseWebhookResult {
  const signature = headerValue(input.headers, "x-hub-signature-256");
  if (!signature) {
    return { ok: false, reason: "missing_signature", messages: [], statuses: [] };
  }
  if (!verifyWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: signature,
    appSecret: input.appSecret,
  })) {
    return { ok: false, reason: "bad_signature", messages: [], statuses: [] };
  }

  let parsed: unknown;
  try {
    const bodyString =
      typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8");
    parsed = JSON.parse(bodyString);
  } catch {
    return { ok: false, reason: "bad_payload", messages: [], statuses: [] };
  }

  let extracted: ReturnType<typeof extractItems>;
  try {
    extracted = extractItems(parsed);
  } catch {
    return { ok: false, reason: "bad_payload", messages: [], statuses: [] };
  }

  // Dedup on wamid. Meta re-delivers when the receiver doesn't 2xx within
  // ~20s, so the same message id can arrive multiple times.
  const messages: NormalizedInboundMessage[] = [];
  let anyNew = false;
  for (const item of extracted.messages) {
    const id = typeof item.message.id === "string" ? item.message.id : undefined;
    if (id && input.idempotency.seen(id)) continue;
    if (id) anyNew = true;
    const normalized = normalizeItem(item, input.accountId);
    if (normalized) messages.push(normalized);
  }

  if (messages.length === 0 && extracted.statuses.length === 0 && extracted.messages.length > 0 && !anyNew) {
    return { ok: true, reason: "duplicate", messages: [], statuses: [] };
  }
  return { ok: true, messages, statuses: extracted.statuses };
}

/**
 * Handle Meta's webhook subscribe verification.
 *
 * Meta sends a `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
 * when you register/refresh the callback URL. We must echo the challenge
 * verbatim with `200 text/plain` if the verify_token matches our config,
 * else reply `403`.
 */
export function handleSubscribeVerification(params: {
  query: Record<string, string | string[] | undefined>;
  verifyToken: string;
}): { status: 200; body: string } | { status: 403; body: string } {
  const mode = readQuery(params.query, "hub.mode");
  const token = readQuery(params.query, "hub.verify_token");
  const challenge = readQuery(params.query, "hub.challenge");
  if (mode === "subscribe" && token === params.verifyToken && typeof challenge === "string") {
    return { status: 200, body: challenge };
  }
  return { status: 403, body: "forbidden" };
}

function readQuery(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = query[key];
  if (Array.isArray(v)) return v[0];
  return v;
}
