/**
 * Native inbound pipeline — constructs the envelope, records the session,
 * and dispatches through OpenClaw's channel runtime so cron "announce to
 * last channel" (and everything else that consults the session store)
 * knows a `whatsapp-cloud:<phone>` conversation exists.
 *
 * Media-bearing messages (image, audio, video, document, sticker) are
 * downloaded via Meta's two-step media fetch — the media URL isn't in the
 * webhook and expires in ~5 minutes — and handed to the host's media store
 * via `channelRuntime.media.saveMediaBuffer`. The resulting local path is
 * passed as MediaPath/MediaUrl in the envelope; vision-capable models read
 * images directly, and OpenClaw's transcription provider picks up audio
 * attachments automatically.
 */

import { createCloudClient, type CloudClient, WHATSAPP_TEXT_LIMIT } from "./send.js";
import { downloadMediaBytes } from "./media.js";
import type { CloudAccountConfig, NormalizedInboundMessage } from "./types.js";

const CHANNEL_ID = "whatsapp-cloud";
const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024; // Matches Meta's inbound cap.

interface SavedMedia {
  id: string;
  path: string;
  size: number;
  contentType?: string;
}

interface ChannelRuntime {
  reply: {
    finalizeInboundContext: (payload: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: Record<string, unknown>;
      cfg: unknown;
      dispatcherOptions: Record<string, unknown>;
      replyOptions?: Record<string, unknown>;
    }) => Promise<void>;
  };
  session: {
    recordInboundSession: (params: {
      storePath: string;
      sessionKey: string;
      ctx: Record<string, unknown>;
      onRecordError?: (err: unknown) => void;
    }) => Promise<void>;
  };
  media?: {
    saveMediaBuffer?: (
      buffer: Buffer,
      contentType?: string,
      subdir?: string,
      maxBytes?: number,
      originalFilename?: string,
    ) => Promise<SavedMedia>;
  };
}

interface DispatchParams {
  cfg: unknown;
  account: { accountId: string; config: CloudAccountConfig };
  channelRuntime: ChannelRuntime;
  log?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
  };
  message: NormalizedInboundMessage;
  /** Test-injectable client factory. Production always builds a fresh client. */
  cloudClientFactory?: (config: CloudAccountConfig) => CloudClient;
}

export async function dispatchInboundMessage(params: DispatchParams): Promise<void> {
  const { cfg, account, channelRuntime, log, message } = params;
  const clientFactory = params.cloudClientFactory ?? createCloudClient;

  const hasText = Boolean(message.text?.trim());
  const hasMedia = Boolean(message.mediaId);

  if (!hasText && !hasMedia) {
    log?.info?.(
      `[${account.accountId}] inbound skipped (type=${message.type}, no text or media)`,
    );
    return;
  }

  const cloud = clientFactory(account.config);

  // Fire mark-as-read + typing indicator immediately so the user sees blue
  // ticks + "typing…" while the agent thinks. Indicator auto-clears at 25s
  // or when our reply is sent. Failure is non-fatal — must not block the
  // inbound pipeline.
  try {
    await cloud.markRead({ messageId: message.messageId, typing: true });
  } catch (err) {
    log?.warn?.(`[${account.accountId}] mark-as-read+typing failed: ${String(err)}`);
  }

  let inboundEnvelopeSdk: {
    resolveInboundRouteEnvelopeBuilderWithRuntime: (p: Record<string, unknown>) => {
      route: { agentId: string; sessionKey: string };
      buildEnvelope: (p: Record<string, unknown>) => { storePath: string; body: string };
    };
  };
  let pipelineSdk: {
    createChannelReplyPipeline: (p: Record<string, unknown>) => Record<string, unknown>;
  };
  try {
    // @ts-expect-error — host-provided at runtime
    inboundEnvelopeSdk = (await import("openclaw/plugin-sdk/inbound-envelope")) as typeof inboundEnvelopeSdk;
    // @ts-expect-error — host-provided at runtime
    pipelineSdk = (await import("openclaw/plugin-sdk/channel-reply-pipeline")) as typeof pipelineSdk;
  } catch (err) {
    log?.error?.(
      `[${account.accountId}] inbound pipeline SDK unavailable (${String(err)}) — dropping message`,
    );
    return;
  }

  const phone = message.from;
  const sessionStore = (cfg as { session?: { store?: string } } | undefined)?.session?.store;

  let savedMedia: SavedMedia | undefined;
  if (hasMedia) {
    savedMedia = await fetchAndStoreMedia({
      message,
      accountConfig: account.config,
      channelRuntime,
      log,
      accountId: account.accountId,
    });
  }

  const bodyForAgent =
    message.text?.trim() ||
    (savedMedia ? `<${message.type} attached>` : "");

  if (!bodyForAgent) {
    log?.warn?.(
      `[${account.accountId}] inbound produced empty body (type=${message.type}, mediaSaved=${Boolean(savedMedia)}) — dropping`,
    );
    return;
  }

  const { route, buildEnvelope } = inboundEnvelopeSdk.resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: phone },
    runtime: channelRuntime,
    sessionStore,
  });

  const fromLabel = message.fromName || phone;
  const { storePath, body } = buildEnvelope({
    channel: "WhatsApp (Cloud API)",
    from: fromLabel,
    timestamp: Date.parse(message.timestamp) || undefined,
    body: bodyForAgent,
  });

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: bodyForAgent,
    CommandBody: bodyForAgent,
    From: `${CHANNEL_ID}:${phone}`,
    To: `${CHANNEL_ID}:${phone}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: message.fromName,
    SenderId: phone,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    MediaPath: savedMedia?.path,
    MediaType: savedMedia?.contentType ?? message.mediaMimeType,
    MediaUrl: savedMedia?.path,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${phone}`,
  });

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: (ctxPayload.SessionKey as string) ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => log?.error?.(`[${account.accountId}] recordInboundSession: ${String(err)}`),
  });

  const replyPipeline = pipelineSdk.createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload: { text?: string }) => {
        const text = payload.text?.trim();
        if (!text) return;
        // sendText handles chunking internally; we keep the same shape for parity.
        try {
          await cloud.sendText({ to: phone, text });
        } catch (err) {
          log?.error?.(`[${account.accountId}] cloud send failed: ${String(err)}`);
        }
      },
      onError: (err: unknown) => log?.error?.(`[${account.accountId}] reply dispatch: ${String(err)}`),
    },
  });
}

async function fetchAndStoreMedia(params: {
  message: NormalizedInboundMessage;
  accountConfig: CloudAccountConfig;
  channelRuntime: ChannelRuntime;
  log?: DispatchParams["log"];
  accountId: string;
}): Promise<SavedMedia | undefined> {
  const { message, accountConfig, channelRuntime, log, accountId } = params;
  const saveMediaBuffer = channelRuntime.media?.saveMediaBuffer;
  if (!saveMediaBuffer) {
    log?.warn?.(
      `[${accountId}] channelRuntime.media.saveMediaBuffer unavailable — skipping media for ${message.messageId}`,
    );
    return undefined;
  }
  if (!message.mediaId) return undefined;

  try {
    const downloaded = await downloadMediaBytes({
      mediaId: message.mediaId,
      account: accountConfig,
    });
    const buffer = Buffer.from(
      downloaded.bytes.buffer,
      downloaded.bytes.byteOffset,
      downloaded.bytes.byteLength,
    );
    const saved = await saveMediaBuffer(
      buffer,
      downloaded.mimeType ?? message.mediaMimeType,
      "inbound",
      DEFAULT_MEDIA_MAX_BYTES,
    );
    log?.info?.(
      `[${accountId}] saved ${message.type} ${message.messageId} → ${saved.path} (${saved.size} bytes, ${saved.contentType ?? "unknown mime"})`,
    );
    return saved;
  } catch (err) {
    log?.error?.(
      `[${accountId}] media fetch/save failed for ${message.messageId}: ${String(err)}`,
    );
    return undefined;
  }
}

// Re-export so consumers can import the limit constant alongside the pipeline.
export { WHATSAPP_TEXT_LIMIT };
