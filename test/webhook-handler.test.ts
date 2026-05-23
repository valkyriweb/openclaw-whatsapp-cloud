import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { IdempotencyCache } from "../src/inbound.js";
import {
  createCloudWebhookHandler,
  type CloudWebhookSdk,
} from "../src/webhook-handler.js";
import type { CloudAccountConfig } from "../src/types.js";

const accountConfig: CloudAccountConfig = {
  accessToken: "EAAG...",
  phoneNumberId: "123456789012345",
  appSecret: "test-app-secret-1234",
  verifyToken: "verify-token-here",
};

function sign(body: string, secret = accountConfig.appSecret): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function metaPayload(wamid = "wamid.HBgM-1") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456789012345" },
              contacts: [{ wa_id: "15551234567", profile: { name: "Test User" } }],
              messages: [
                {
                  from: "15551234567",
                  id: wamid,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function makeReq(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: "", ended: false };
  const res = {
    headersSent: false,
    set statusCode(n: number) { captured.statusCode = n; },
    get statusCode() { return captured.statusCode; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    end(body?: string) { if (body !== undefined) captured.body = body; captured.ended = true; },
  } as unknown as ServerResponse;
  return { res, captured };
}

function makeSdk(rawBody: string): CloudWebhookSdk {
  return {
    applyBasicWebhookRequestGuards: () => true,
    readRequestBodyWithLimit: async () => rawBody,
    isRequestBodyLimitError: () => false,
    requestBodyErrorToText: (e) => String(e),
  };
}

describe("createCloudWebhookHandler GET", () => {
  it("echoes hub.challenge when verify token matches", async () => {
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(""),
    });
    const req = makeReq({
      method: "GET",
      url: "/webhooks/whatsapp-cloud/default?hub.mode=subscribe&hub.verify_token=verify-token-here&hub.challenge=42",
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.body, "42");
    assert.equal(captured.headers["Content-Type"], "text/plain; charset=utf-8");
  });

  it("403 when verify token does not match", async () => {
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(""),
    });
    const req = makeReq({
      method: "GET",
      url: "/webhooks/whatsapp-cloud/default?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=42",
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 403);
  });
});

describe("createCloudWebhookHandler POST", () => {
  it("401 when X-Hub-Signature-256 is missing", async () => {
    const body = JSON.stringify(metaPayload());
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(body),
    });
    const req = makeReq({ method: "POST", url: "/", headers: { "content-type": "application/json" } });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 401);
    assert.match(captured.body, /missing_signature/);
  });

  it("401 when X-Hub-Signature-256 is forged", async () => {
    const body = JSON.stringify(metaPayload());
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(body),
    });
    const req = makeReq({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 401);
    assert.match(captured.body, /bad_signature/);
  });

  it("200 + dispatches messages when signature is valid", async () => {
    const body = JSON.stringify(metaPayload());
    const seen: Array<string | undefined> = [];
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(body),
      onMessages: (ms) => { for (const m of ms) seen.push(m.text); },
    });
    const req = makeReq({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(JSON.parse(captured.body), { ok: true, delivered: 1, statuses: 0 });
    assert.deepEqual(seen, ["hello"]);
  });

  it("dedups: replaying the same wamid does not re-dispatch", async () => {
    const body = JSON.stringify(metaPayload("wamid.SAME"));
    const idempotency = new IdempotencyCache();
    const seen: string[] = [];
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency,
      sdk: makeSdk(body),
      onMessages: (ms) => { for (const m of ms) seen.push(m.messageId); },
    });
    const headers = { "content-type": "application/json", "x-hub-signature-256": sign(body) };

    const first = makeRes();
    await handler(makeReq({ method: "POST", url: "/", headers }), first.res);
    assert.equal(first.captured.statusCode, 200);
    assert.deepEqual(seen, ["wamid.SAME"]);

    const second = makeRes();
    await handler(makeReq({ method: "POST", url: "/", headers }), second.res);
    assert.equal(second.captured.statusCode, 200);
    // Still only one dispatch — the second delivery was deduped.
    assert.deepEqual(seen, ["wamid.SAME"]);
    // ACK body reports zero delivered on the replay.
    assert.deepEqual(JSON.parse(second.captured.body), { ok: true, delivered: 0, statuses: 0 });
  });

  it("400 when body is not valid JSON", async () => {
    const body = "{not json";
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk: makeSdk(body),
    });
    const req = makeReq({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 400);
    assert.match(captured.body, /bad_payload/);
  });

  it("guards short-circuit when applyBasicWebhookRequestGuards returns false", async () => {
    const body = JSON.stringify(metaPayload());
    const sdk: CloudWebhookSdk = {
      applyBasicWebhookRequestGuards: ({ res }) => {
        res.statusCode = 405;
        res.setHeader("Content-Type", "text/plain");
        res.end("method not allowed");
        return false;
      },
      readRequestBodyWithLimit: async () => body,
      isRequestBodyLimitError: () => false,
      requestBodyErrorToText: (e) => String(e),
    };
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk,
    });
    const req = makeReq({
      method: "POST",
      url: "/",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 405);
  });

  it("413 when the SDK reports a body-size limit error", async () => {
    const sdk: CloudWebhookSdk = {
      applyBasicWebhookRequestGuards: () => true,
      readRequestBodyWithLimit: async () => { throw new Error("body too big"); },
      isRequestBodyLimitError: () => true,
      requestBodyErrorToText: () => "payload too large",
    };
    const handler = createCloudWebhookHandler({
      accountId: "default",
      accountConfig,
      idempotency: new IdempotencyCache(),
      sdk,
    });
    const req = makeReq({ method: "POST", url: "/", headers: { "content-type": "application/json" } });
    const { res, captured } = makeRes();
    await handler(req, res);
    assert.equal(captured.statusCode, 413);
    assert.equal(captured.body, "payload too large");
  });
});
