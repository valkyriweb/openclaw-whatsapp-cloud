import { z } from "zod";

/**
 * Zod schema for a single Meta WhatsApp Cloud API account.
 *
 * `.strict()` makes typos in config files fail loudly rather than being
 * silently ignored — the common failure mode for hand-edited configs.
 */
export const CloudAccountSchema = z
  .object({
    /** System User access token (`Authorization: Bearer …` on every Graph call). */
    accessToken: z.string().min(1, "accessToken is required"),
    /** Digits-only Meta `phone_number_id` for the WABA-registered number. */
    phoneNumberId: z
      .string()
      .min(1, "phoneNumberId is required")
      .regex(/^[0-9]+$/, "phoneNumberId must be a digits-only Meta phone_number_id"),
    /**
     * Meta App Secret — used to verify `X-Hub-Signature-256` on inbound
     * webhooks. App Secret, not Page/System User token.
     */
    appSecret: z.string().min(8, "appSecret must be the Meta App Secret (>=8 chars)"),
    /**
     * Token echoed back to Meta on the webhook subscribe handshake
     * (`hub.verify_token`). Free-form; you choose it when registering.
     */
    verifyToken: z.string().min(8, "verifyToken must be >=8 chars"),
    /** WABA id — required for the template registry (`/v25.0/{wabaId}/message_templates`). */
    wabaId: z.string().regex(/^[0-9]+$/, "wabaId must be digits-only").optional(),
    /** Override the Graph base URL. Defaults to `https://graph.facebook.com`. */
    apiBaseUrl: z.string().url().optional(),
    /** Override the Graph API version segment. Defaults to `v25.0`. */
    apiVersion: z.string().regex(/^v\d+\.\d+$/, "apiVersion must look like v25.0").optional(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
  })
  .strict();

export const CloudConfigSchema = CloudAccountSchema.extend({
  accounts: z.record(z.string(), CloudAccountSchema).optional(),
})
  .partial({
    accessToken: true,
    phoneNumberId: true,
    appSecret: true,
    verifyToken: true,
  })
  .strict();

export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type CloudAccount = z.infer<typeof CloudAccountSchema>;

export const DEFAULT_CLOUD_BASE_URL = "https://graph.facebook.com";
export const DEFAULT_CLOUD_API_VERSION = "v25.0";
