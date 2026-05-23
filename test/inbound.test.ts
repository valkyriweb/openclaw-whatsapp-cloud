import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  IdempotencyCache,
  extractItems,
  handleSubscribeVerification,
  normalizeItem,
  parseCloudWebhook,
  verifyWebhookSignature,
} from "../src/inbound.js";

const APP_SECRET = "this-is-an-app-secret";

function sign(body: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function metaInboundEnvelope(over: Partial<{
  wamid: string;
  from: string;
  text: string;
  type: string;
  phoneNumberId: string;
  contactName: string;
}> = {}): unknown {
  const o = {
    wamid: "wamid.HBgM...",
    from: "15551234567",
    text: "hello",
    type: "text",
    phoneNumberId: "123456789012345",
    contactName: "Test User",
    ...over,
  };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15551389219",
                phone_number_id: o.phoneNumberId,
              },
              contacts: [{ wa_id: o.from, profile: { name: o.contactName } }],
              messages: [
                {
                  from: o.from,
                  id: o.wamid,
                  timestamp: "1700000000",
                  type: o.type,
                  ...(o.type === "text" ? { text: { body: o.text } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid sha256= header", () => {
    const body = JSON.stringify({ hello: "world" });
    assert.equal(
      verifyWebhookSignature({ rawBody: body, signatureHeader: sign(body), appSecret: APP_SECRET }),
      true,
    );
  });
  it("rejects a forged signature", () => {
    const body = JSON.stringify({ hello: "world" });
    assert.equal(
      verifyWebhookSignature({
        rawBody: body,
        signatureHeader: "sha256=" + "f".repeat(64),
        appSecret: APP_SECRET,
      }),
      false,
    );
  });
  it("rejects missing header", () => {
    assert.equal(
      verifyWebhookSignature({ rawBody: "x", signatureHeader: undefined, appSecret: APP_SECRET }),
      false,
    );
  });
  it("rejects mismatched secret", () => {
    const body = "{}";
    assert.equal(
      verifyWebhookSignature({ rawBody: body, signatureHeader: sign(body, "other"), appSecret: APP_SECRET }),
      false,
    );
  });
});

describe("extractItems", () => {
  it("walks entry[].changes[].value.messages", () => {
    const { messages, statuses } = extractItems(metaInboundEnvelope());
    assert.equal(messages.length, 1);
    assert.equal(messages[0].phoneNumberId, "123456789012345");
    assert.equal(messages[0].contact?.wa_id, "15551234567");
    assert.equal(statuses.length, 0);
  });
  it("extracts statuses[]", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.OUT", status: "delivered", recipient_id: "15551234567", timestamp: "1700000010" },
                ],
              },
            },
          ],
        },
      ],
    };
    const { messages, statuses } = extractItems(payload);
    assert.equal(messages.length, 0);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "delivered");
    assert.equal(statuses[0].messageId, "wamid.OUT");
  });
  it("rejects non-WABA payloads", () => {
    assert.throws(() => extractItems({ object: "something_else", entry: [] }));
  });
});

describe("normalizeItem", () => {
  it("normalizes a plain text message", () => {
    const { messages } = extractItems(metaInboundEnvelope({ text: "hi there" }));
    const norm = normalizeItem(messages[0], "default");
    assert.ok(norm);
    assert.equal(norm.text, "hi there");
    assert.equal(norm.from, "+15551234567");
    assert.equal(norm.fromName, "Test User");
    assert.equal(norm.type, "text");
    assert.equal(norm.channelId, "whatsapp-cloud");
    assert.equal(norm.accountId, "default");
    assert.equal(norm.messageId, "wamid.HBgM...");
    assert.equal(norm.timestamp, new Date(1700000000 * 1000).toISOString());
  });

  it("extracts image media id + mime + caption", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "X" },
                contacts: [{ wa_id: "15551234567", profile: { name: "L" } }],
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.IMG",
                    timestamp: "1700000000",
                    type: "image",
                    image: { id: "media-123", mime_type: "image/jpeg", caption: "snap" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const { messages } = extractItems(payload);
    const norm = normalizeItem(messages[0], "default");
    assert.ok(norm);
    assert.equal(norm.mediaId, "media-123");
    assert.equal(norm.mediaMimeType, "image/jpeg");
    assert.equal(norm.text, "snap");
    assert.equal(norm.type, "image");
  });

  it("captures context.id as replyToMessageId", () => {
    const payload = metaInboundEnvelope() as { entry: Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }> };
    payload.entry[0].changes[0].value.messages[0].context = { id: "wamid.REPLY" };
    const { messages } = extractItems(payload);
    const norm = normalizeItem(messages[0], "default");
    assert.equal(norm?.replyToMessageId, "wamid.REPLY");
  });

  it("returns null when required fields missing", () => {
    const item = {
      message: { from: "15551234567" /* no id, no timestamp */ },
    };
    assert.equal(normalizeItem(item, "default"), null);
  });
});

describe("IdempotencyCache", () => {
  it("returns false on first seen, true on repeat", () => {
    const cache = new IdempotencyCache(10);
    assert.equal(cache.seen("a"), false);
    assert.equal(cache.seen("a"), true);
  });
  it("evicts oldest beyond capacity", () => {
    const cache = new IdempotencyCache(2);
    cache.seen("a");
    cache.seen("b");
    cache.seen("c"); // evicts a
    assert.equal(cache.has("a"), false);
    assert.equal(cache.has("b"), true);
    assert.equal(cache.has("c"), true);
  });
});

describe("parseCloudWebhook", () => {
  it("returns ok=true with one message for a valid signed payload", () => {
    const body = JSON.stringify(metaInboundEnvelope());
    const result = parseCloudWebhook({
      rawBody: body,
      headers: { "x-hub-signature-256": sign(body) },
      appSecret: APP_SECRET,
      idempotency: new IdempotencyCache(),
      accountId: "default",
    });
    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 1);
  });

  it("returns bad_signature for a forged HMAC", () => {
    const body = JSON.stringify(metaInboundEnvelope());
    const result = parseCloudWebhook({
      rawBody: body,
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      appSecret: APP_SECRET,
      idempotency: new IdempotencyCache(),
      accountId: "default",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_signature");
  });

  it("returns missing_signature when header absent", () => {
    const body = JSON.stringify(metaInboundEnvelope());
    const result = parseCloudWebhook({
      rawBody: body,
      headers: {},
      appSecret: APP_SECRET,
      idempotency: new IdempotencyCache(),
      accountId: "default",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_signature");
  });

  it("dedupes on repeated wamid (replay)", () => {
    const body = JSON.stringify(metaInboundEnvelope());
    const idempotency = new IdempotencyCache();
    const headers = { "x-hub-signature-256": sign(body) };

    const first = parseCloudWebhook({
      rawBody: body, headers, appSecret: APP_SECRET, idempotency, accountId: "default",
    });
    assert.equal(first.messages.length, 1);

    const second = parseCloudWebhook({
      rawBody: body, headers, appSecret: APP_SECRET, idempotency, accountId: "default",
    });
    assert.equal(second.ok, true);
    assert.equal(second.messages.length, 0);
    assert.equal(second.reason, "duplicate");
  });

  it("returns bad_payload on malformed JSON", () => {
    const body = "{not json";
    const result = parseCloudWebhook({
      rawBody: body,
      headers: { "x-hub-signature-256": sign(body) },
      appSecret: APP_SECRET,
      idempotency: new IdempotencyCache(),
      accountId: "default",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_payload");
  });
});

describe("handleSubscribeVerification", () => {
  it("echoes the challenge when token matches", () => {
    const out = handleSubscribeVerification({
      query: { "hub.mode": "subscribe", "hub.verify_token": "T", "hub.challenge": "12345" },
      verifyToken: "T",
    });
    assert.equal(out.status, 200);
    assert.equal(out.body, "12345");
  });
  it("returns 403 when token does not match", () => {
    const out = handleSubscribeVerification({
      query: { "hub.mode": "subscribe", "hub.verify_token": "X", "hub.challenge": "12345" },
      verifyToken: "T",
    });
    assert.equal(out.status, 403);
  });
  it("returns 403 when mode is not subscribe", () => {
    const out = handleSubscribeVerification({
      query: { "hub.mode": "unsubscribe", "hub.verify_token": "T", "hub.challenge": "12345" },
      verifyToken: "T",
    });
    assert.equal(out.status, 403);
  });
});
