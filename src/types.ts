/**
 * Internal type declarations for the WhatsApp Cloud API plugin.
 */

export interface CloudAccountConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  wabaId?: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  enabled?: boolean;
  name?: string;
}

export interface ResolvedCloudAccount {
  accountId: string;
  config: CloudAccountConfig;
}

export type InboundMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "interactive"
  | "button"
  | "reaction"
  | "unknown";

export interface NormalizedInboundMessage {
  channelId: "whatsapp-cloud";
  accountId: string;
  /** Meta `wamid.*` message id. Stable, used for dedup + reply context. */
  messageId: string;
  /** E.164 sender phone (with `+`). */
  from: string;
  fromName?: string;
  timestamp: string;
  type: InboundMessageType;
  text?: string;
  /** Meta media id. URL is not in the webhook — call `fetchMediaMetadata` then `downloadMediaBytes`. */
  mediaId?: string;
  mediaMimeType?: string;
  /** Quoted message id (`context.id` in the Meta payload). */
  replyToMessageId?: string;
  raw: unknown;
}

export interface SendResult {
  channel: "whatsapp-cloud";
  messageId: string;
  chatId: string;
}

export type MediaKind = "image" | "audio" | "document" | "video" | "sticker";

/** One element of a Meta template `components[]` array. */
export interface TemplateComponent {
  type: "header" | "body" | "footer" | "button";
  sub_type?: "quick_reply" | "url" | "catalog" | "mpm" | "copy_code" | "flow";
  index?: number | string;
  parameters?: Array<Record<string, unknown>>;
}
