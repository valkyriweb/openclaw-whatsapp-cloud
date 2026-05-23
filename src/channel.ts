import type { IncomingMessage, ServerResponse } from "node:http";

import { CloudConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  listCloudAccountIds,
  resolveDefaultCloudAccountId,
  resolveCloudAccount,
} from "./accounts.js";
import { createCloudClient } from "./send.js";
import { IdempotencyCache } from "./inbound.js";
import { dispatchInboundMessage } from "./inbound-pipeline.js";
import { createCloudWebhookHandler } from "./webhook-handler.js";
import type { ResolvedCloudAccount, SendResult } from "./types.js";

/**
 * OpenClaw plugin-sdk surface used to mount the webhook on the gateway. We
 * load it lazily via dynamic import so consumers that only use `outbound`
 * (or the plugin metadata) don't pay the cost or hard-require the host.
 * Older hosts that don't expose the SDK fall back to handler-only mode.
 */
interface OpenclawWebhookIngressSdk {
  registerPluginHttpRoute: (params: {
    path?: string | null;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "public" | "bearer" | "plugin";
    match?: "exact" | "prefix";
    pluginId?: string;
    source?: string;
    accountId?: string;
    log?: (m: string) => void;
    replaceExisting?: boolean;
  }) => () => void;
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
  createFixedWindowRateLimiter: (options: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
  }) => unknown;
  WEBHOOK_RATE_LIMIT_DEFAULTS: {
    windowMs: number;
    maxRequests: number;
    maxTrackedKeys: number;
  };
}

let sdkPromise: Promise<OpenclawWebhookIngressSdk | null> | null = null;
export async function loadWebhookIngressSdk(): Promise<OpenclawWebhookIngressSdk | null> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    try {
      const mod = (await import(
        // @ts-expect-error — host-provided, resolved at runtime
        "openclaw/plugin-sdk/webhook-ingress"
      )) as unknown as OpenclawWebhookIngressSdk;
      if (typeof mod?.registerPluginHttpRoute !== "function") return null;
      return mod;
    } catch {
      return null;
    }
  })();
  return sdkPromise;
}

// Shared across all accounts — one bucket of IP-scoped tokens.
let sharedRateLimiter: unknown | null = null;

const WEBHOOK_MAX_BODY_BYTES = 1_048_576; // 1 MiB — Meta webhook bodies stay tiny (no inline media).
const WEBHOOK_BODY_TIMEOUT_MS = 30_000;

function normalizeAccountIdForPath(accountId: string): string {
  return accountId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

export function webhookPathForAccount(accountId: string): string {
  return `/webhooks/whatsapp-cloud/${normalizeAccountIdForPath(accountId)}`;
}

function resolveOutboundAccount(params: {
  cfg?: unknown;
  accountId?: string;
  account?: ResolvedCloudAccount;
}): ResolvedCloudAccount | undefined {
  if (params.account) return params.account;
  if (!params.cfg) return undefined;
  return cloudPlugin.config.resolveAccount(
    params.cfg,
    params.accountId ?? DEFAULT_ACCOUNT_ID,
  );
}

function extractChannelSection(cfg: unknown): unknown {
  if (cfg && typeof cfg === "object") {
    const channels = (cfg as { channels?: Record<string, unknown> }).channels;
    if (channels && typeof channels === "object" && channels[CHANNEL_ID] !== undefined) {
      return channels[CHANNEL_ID];
    }
  }
  return cfg;
}

const CHANNEL_ID = "whatsapp-cloud";

const meta = {
  id: CHANNEL_ID,
  label: "WhatsApp (Cloud API)",
  selectionLabel: "WhatsApp via Meta Cloud API",
  detailLabel: "WhatsApp (Cloud API)",
  docsPath: "/channels/whatsapp-cloud",
  docsLabel: "whatsapp-cloud",
  blurb:
    "WhatsApp Business via Meta Cloud API direct — no phone keep-alive, REST sends, HMAC-signed webhooks.",
  systemImage: "message.fill",
};

const capabilities = {
  chatTypes: ["direct"] as const,
  reactions: true,
  threads: false,
  media: true,
  nativeCommands: false,
  // WhatsApp has no streaming edit API — hosts should buffer the full reply
  // before sending.
  blockStreaming: true,
} as const;

export const cloudPlugin = {
  id: CHANNEL_ID,
  meta,
  capabilities,
  configSchema: CloudConfigSchema,

  config: {
    sectionKey: CHANNEL_ID,
    listAccountIds: (cfg: unknown) => {
      const section = extractChannelSection(cfg);
      const parsed = CloudConfigSchema.safeParse(section);
      return parsed.success ? listCloudAccountIds(parsed.data) : [];
    },
    resolveAccount: (
      cfgOrParams: unknown,
      maybeAccountId?: string,
    ): ResolvedCloudAccount | undefined => {
      let rawCfg: unknown;
      let accountId: string | undefined;
      if (
        cfgOrParams &&
        typeof cfgOrParams === "object" &&
        "cfg" in (cfgOrParams as Record<string, unknown>)
      ) {
        const obj = cfgOrParams as { cfg: unknown; accountId?: string };
        rawCfg = obj.cfg;
        accountId = obj.accountId;
      } else {
        rawCfg = cfgOrParams;
        accountId = maybeAccountId;
      }
      const section = extractChannelSection(rawCfg);
      const parsed = CloudConfigSchema.safeParse(section);
      if (!parsed.success) return undefined;
      return resolveCloudAccount(parsed.data, accountId ?? DEFAULT_ACCOUNT_ID);
    },
    defaultAccountId: (cfg: unknown) => {
      const section = extractChannelSection(cfg);
      const parsed = CloudConfigSchema.safeParse(section);
      return parsed.success ? resolveDefaultCloudAccountId(parsed.data) : undefined;
    },
    isConfigured: (account: ResolvedCloudAccount | undefined) =>
      Boolean(
        account?.config.accessToken &&
          account.config.phoneNumberId &&
          account.config.appSecret &&
          account.config.verifyToken,
      ),
    describeAccount: (account: ResolvedCloudAccount) => ({
      accountId: account.accountId,
      name: account.config.name ?? account.accountId,
      enabled: account.config.enabled !== false,
      configured: true,
      phoneNumberId: account.config.phoneNumberId,
      wabaId: account.config.wabaId,
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,
    sendText: async (params: {
      cfg?: unknown;
      accountId?: string;
      account?: ResolvedCloudAccount;
      to: string;
      text: string;
      replyToId?: string | null;
    }): Promise<SendResult> => {
      const account = resolveOutboundAccount(params);
      if (!account) throw new Error("whatsapp-cloud sendText: no configured account");
      const client = createCloudClient(account.config);
      return client.sendText({
        to: params.to,
        text: params.text,
        replyToMessageId: params.replyToId ?? undefined,
      });
    },
    sendMedia: async (params: {
      cfg?: unknown;
      accountId?: string;
      account?: ResolvedCloudAccount;
      to: string;
      kind: "image" | "audio" | "video" | "document" | "sticker";
      mediaUrl?: string;
      mediaId?: string;
      caption?: string;
      filename?: string;
      replyToId?: string | null;
    }): Promise<SendResult> => {
      const account = resolveOutboundAccount(params);
      if (!account) throw new Error("whatsapp-cloud sendMedia: no configured account");
      const client = createCloudClient(account.config);
      return client.sendMedia({
        to: params.to,
        kind: params.kind,
        link: params.mediaUrl,
        mediaId: params.mediaId,
        caption: params.caption,
        filename: params.filename,
        replyToMessageId: params.replyToId ?? undefined,
      });
    },
  },

  gateway: {
    /**
     * Mount the inbound webhook on the gateway via `registerPluginHttpRoute`.
     *
     * Security posture:
     *   - GET → subscribe verification handshake (`hub.challenge` echo).
     *   - POST → method+content-type guards, shared rate limiter, 1 MiB cap,
     *     `X-Hub-Signature-256` HMAC verify, LRU dedup on wamid.
     *   - Per-account path isolation prevents account A's secret from being
     *     used to forge events for account B.
     *
     * We 200-ACK fast and dispatch to the agent in the background — Meta
     * retries any 5xx and considers the receiver dead if it takes >20s.
     */
    startAccount: async (ctx: {
      cfg?: unknown;
      account: ResolvedCloudAccount;
      abortSignal?: AbortSignal;
      log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
      dispatch?: (message: unknown) => Promise<void> | void;
    }) => {
      const idempotency = new IdempotencyCache(1000);
      const accountId = ctx.account.accountId;
      const path = webhookPathForAccount(accountId);

      const channelRuntime = (ctx as Record<string, unknown>).channelRuntime as
        | Parameters<typeof dispatchInboundMessage>[0]["channelRuntime"]
        | undefined;

      const sdk = await loadWebhookIngressSdk();
      let unregisterHttpRoute: (() => void) | null = null;

      if (sdk) {
        if (!sharedRateLimiter) {
          sharedRateLimiter = sdk.createFixedWindowRateLimiter({
            windowMs: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
            maxRequests: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
            maxTrackedKeys: sdk.WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
          });
        }

        const httpHandler = createCloudWebhookHandler({
          accountId,
          accountConfig: ctx.account.config,
          idempotency,
          sdk,
          rateLimiter: sharedRateLimiter ?? undefined,
          rateLimitKey: (req) => `${path}:${req.socket.remoteAddress ?? "unknown"}`,
          maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
          bodyTimeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
          log: ctx.log,
          onMessages: (messages) => {
            for (const m of messages) {
              if (ctx.dispatch) {
                Promise.resolve()
                  .then(() => ctx.dispatch?.(m))
                  .catch((err) => ctx.log?.error?.(`[${accountId}] dispatch: ${String(err)}`));
              }
              if (channelRuntime) {
                Promise.resolve()
                  .then(() =>
                    dispatchInboundMessage({
                      cfg: ctx.cfg,
                      account: ctx.account,
                      channelRuntime,
                      log: ctx.log,
                      message: m,
                    }),
                  )
                  .catch((err) =>
                    ctx.log?.error?.(`[${accountId}] dispatchInboundMessage: ${String(err)}`),
                  );
              } else if (!ctx.dispatch) {
                ctx.log?.error?.(
                  `[${accountId}] no channelRuntime on ctx — host is too old; dropping inbound`,
                );
              }
            }
          },
          onStatuses: (statuses) => {
            // Status callbacks (sent / delivered / read / failed) are an
            // outbound-side tracking signal. Surface to the host's delivery
            // tracker when present (newer OpenClaw runtimes expose
            // channelRuntime.delivery.recordStatus), otherwise log at info so
            // the gateway log carries the audit trail.
            const recordStatus = (channelRuntime as unknown as {
              delivery?: {
                recordStatus?: (params: {
                  channel: string;
                  accountId: string;
                  messageId: string;
                  status: string;
                  recipientId?: string;
                  timestamp?: string;
                  raw: unknown;
                }) => Promise<void> | void;
              };
            })?.delivery?.recordStatus;
            for (const s of statuses) {
              if (recordStatus) {
                Promise.resolve()
                  .then(() =>
                    recordStatus({
                      channel: CHANNEL_ID,
                      accountId,
                      messageId: s.messageId,
                      status: s.status,
                      recipientId: s.recipientId,
                      timestamp: s.timestamp,
                      raw: s.raw,
                    }),
                  )
                  .catch((err) =>
                    ctx.log?.error?.(`[${accountId}] recordStatus: ${String(err)}`),
                  );
              } else {
                ctx.log?.info?.(
                  `[${accountId}] status ${s.status} for ${s.messageId}` +
                    (s.recipientId ? ` -> ${s.recipientId}` : ""),
                );
              }
            }
          },
        });

        unregisterHttpRoute = sdk.registerPluginHttpRoute({
          path,
          auth: "public",
          pluginId: "whatsapp-cloud",
          source: "whatsapp-cloud-inbound",
          accountId,
          log: (m) => ctx.log?.info?.(m),
          handler: httpHandler,
        });

        ctx.log?.info?.(
          `[${accountId}] whatsapp-cloud channel ready — webhook mounted at ${path}`,
        );
      } else {
        ctx.log?.info?.(
          `[${accountId}] whatsapp-cloud channel ready (legacy mode — host did not expose plugin-sdk/webhook-ingress)`,
        );
      }

      // Keep the channel task alive until the host aborts us; resolving early
      // would cause OpenClaw to restart-loop the channel.
      return await new Promise<void>((resolve) => {
        const finish = () => {
          if (unregisterHttpRoute) {
            try { unregisterHttpRoute(); } catch (err) {
              ctx.log?.warn?.(`[${accountId}] unregister webhook route failed: ${String(err)}`);
            }
            unregisterHttpRoute = null;
          }
          resolve();
        };
        if (!ctx.abortSignal) return;
        if (ctx.abortSignal.aborted) return finish();
        ctx.abortSignal.addEventListener("abort", finish, { once: true });
      });
    },
    logoutAccount: async () => {
      // Stateless — nothing to revoke on our side. Tokens live in Meta's
      // System User dashboard.
    },
  },
};

export type CloudPlugin = typeof cloudPlugin;
