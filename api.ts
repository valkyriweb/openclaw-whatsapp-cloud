/**
 * Public API surface for consumers embedding / extending the plugin.
 */
export {
  listCloudAccountIds,
  resolveDefaultCloudAccountId,
  resolveCloudAccount,
  DEFAULT_ACCOUNT_ID,
} from "./src/accounts.js";

export { cloudPlugin } from "./src/channel.js";
export { cloudSetupPlugin, cloudWebhookUrl } from "./src/setup-core.js";
export {
  CloudAccountSchema,
  CloudConfigSchema,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_API_VERSION,
} from "./src/config-schema.js";
export type { CloudConfig, CloudAccount } from "./src/config-schema.js";
export {
  createCloudClient,
  toCloudPhoneNumber,
  parseRetryAfter,
  resolveApiRoot,
  chunkText,
  extractMetaErrorCode,
  OutsideServiceWindowError,
  WHATSAPP_TEXT_LIMIT,
  META_ERROR_OUTSIDE_SERVICE_WINDOW,
} from "./src/send.js";
export { fetchMediaMetadata, downloadMediaBytes } from "./src/media.js";
export type {
  CloudMediaMetadata,
  CloudMediaBytes,
  FetchMediaInput,
} from "./src/media.js";
export {
  parseCloudWebhook,
  verifyWebhookSignature,
  handleSubscribeVerification,
  IdempotencyCache,
  extractItems,
  normalizeItem,
} from "./src/inbound.js";
export type {
  CloudWebhookItem,
  CloudStatusItem,
  ParseWebhookInput,
  ParseWebhookResult,
} from "./src/inbound.js";
export { listTemplates } from "./src/templates.js";
export type { CloudTemplate, ListTemplatesInput } from "./src/templates.js";
export type {
  CloudAccountConfig,
  ResolvedCloudAccount,
  NormalizedInboundMessage,
  SendResult,
  InboundMessageType,
  MediaKind,
  TemplateComponent,
} from "./src/types.js";
