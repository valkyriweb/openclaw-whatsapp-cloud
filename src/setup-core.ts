/**
 * Setup wizard helpers. The OpenClaw CLI drives the wizard via a structural
 * `ChannelSetupAdapter` interface; we expose the minimum pieces needed to
 * collect Meta credentials and tell the user the webhook URL.
 */

import { CloudAccountSchema } from "./config-schema.js";

export interface CloudSetupAnswers {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  wabaId?: string;
  apiBaseUrl?: string;
  apiVersion?: string;
}

export function validateAnswers(answers: unknown): {
  ok: true; value: CloudSetupAnswers;
} | {
  ok: false; issues: string[];
} {
  const parsed = CloudAccountSchema.safeParse(answers);
  if (parsed.success) return { ok: true, value: parsed.data as CloudSetupAnswers };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  };
}

/**
 * Compose the webhook URL the user must paste into Meta's app dashboard when
 * registering the WhatsApp webhook for this WABA. The same URL serves both
 * the GET subscribe verification handshake and POST deliveries.
 */
export function cloudWebhookUrl(publicBaseUrl: string, accountId: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/webhooks/whatsapp-cloud/${encodeURIComponent(accountId)}`;
}

export const cloudSetupPlugin = {
  id: "whatsapp-cloud",
  meta: {
    id: "whatsapp-cloud",
    label: "WhatsApp (Cloud API)",
    blurb:
      "Connect WhatsApp Business via Meta Cloud API directly. Needs: System User access token, phone_number_id, App Secret, and a verify token you choose.",
  },
  setupWizard: {
    questions: [
      {
        key: "accessToken",
        label: "Meta System User access token",
        help:
          "Generate at business.facebook.com → System Users → Generate New Token. Scopes: whatsapp_business_messaging, whatsapp_business_management. Prefer a never-expiring token.",
        type: "string" as const,
        secret: true,
      },
      {
        key: "phoneNumberId",
        label: "WhatsApp phone_number_id",
        help: "Digits-only Meta id for the WABA-registered number (e.g. 123456789012345).",
        type: "string" as const,
      },
      {
        key: "appSecret",
        label: "Meta App Secret",
        help:
          "App Settings → Basic → App Secret. Used to HMAC-verify inbound webhooks. NOT the access token.",
        type: "string" as const,
        secret: true,
      },
      {
        key: "verifyToken",
        label: "Webhook verify token",
        help:
          "Free-form string you choose. Paste the same value into Meta's webhook 'Verify token' field. Min 8 chars.",
        type: "string" as const,
        secret: true,
      },
      {
        key: "wabaId",
        label: "WABA id (optional, needed for template registry)",
        help: "Digits-only WhatsApp Business Account id (e.g. 987654321098765).",
        type: "string" as const,
        optional: true,
      },
      {
        key: "apiBaseUrl",
        label: "Graph API base URL (optional)",
        help: "Defaults to https://graph.facebook.com. Override only for testing.",
        type: "string" as const,
        optional: true,
      },
      {
        key: "apiVersion",
        label: "Graph API version (optional)",
        help: "Defaults to v25.0.",
        type: "string" as const,
        optional: true,
      },
    ],
    validate: validateAnswers,
    nextSteps: (ctx: { publicBaseUrl: string; accountId: string }) => [
      `In Meta App Dashboard → WhatsApp → Configuration, set the webhook callback URL to: ${cloudWebhookUrl(
        ctx.publicBaseUrl,
        ctx.accountId,
      )}`,
      "Paste the same verify token into Meta's 'Verify token' field.",
      "Subscribe to the 'messages' webhook field on the WABA.",
      "Test with: GET that URL with ?hub.mode=subscribe&hub.verify_token=<your-token>&hub.challenge=foo — must echo `foo`.",
    ],
  },
};
