import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  chunkText,
  createCloudClient,
  extractMetaErrorCode,
  META_ERROR_OUTSIDE_SERVICE_WINDOW,
  OutsideServiceWindowError,
  parseRetryAfter,
  resolveApiRoot,
  toCloudPhoneNumber,
  WHATSAPP_TEXT_LIMIT,
} from "../src/send.js";
import type { CloudAccountConfig } from "../src/types.js";

const account: CloudAccountConfig = {
  accessToken: "EAAG...",
  phoneNumberId: "123456789012345",
  appSecret: "appSecret123",
  verifyToken: "verifyToken12",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("toCloudPhoneNumber", () => {
  it("strips + prefix", () => {
    assert.equal(toCloudPhoneNumber("+15551234567"), "15551234567");
  });
  it("strips channel-id prefix", () => {
    assert.equal(toCloudPhoneNumber("whatsapp-cloud:+15551234567"), "15551234567");
  });
  it("rejects non-digits", () => {
    assert.throws(() => toCloudPhoneNumber("hello"));
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds", () => {
    assert.equal(parseRetryAfter("30"), 30_000);
  });
  it("parses HTTP-date", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future) ?? 0;
    assert.ok(ms > 50_000 && ms <= 60_000);
  });
  it("returns null for missing", () => {
    assert.equal(parseRetryAfter(undefined), null);
  });
});

describe("resolveApiRoot", () => {
  it("defaults to graph.facebook.com/v25.0", () => {
    assert.equal(resolveApiRoot(account), "https://graph.facebook.com/v25.0");
  });
  it("honors overrides", () => {
    assert.equal(
      resolveApiRoot({ ...account, apiBaseUrl: "https://example.com/", apiVersion: "v26.0" }),
      "https://example.com/v26.0",
    );
  });
});

describe("chunkText", () => {
  it("returns single chunk under limit", () => {
    assert.deepEqual(chunkText("hello"), ["hello"]);
  });
  it("splits at WHATSAPP_TEXT_LIMIT", () => {
    const text = "a".repeat(WHATSAPP_TEXT_LIMIT + 10);
    const chunks = chunkText(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, WHATSAPP_TEXT_LIMIT);
    assert.equal(chunks[1].length, 10);
  });
});

describe("createCloudClient.sendText", () => {
  it("POSTs to /v25.0/{phoneNumberId}/messages with Bearer + Meta text body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ messages: [{ id: "wamid.ABC" }] });
    };
    const client = createCloudClient(account, { fetch: fakeFetch });
    const result = await client.sendText({ to: "+15551234567", text: "hello" });

    assert.equal(result.messageId, "wamid.ABC");
    assert.equal(result.chatId, "15551234567");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://graph.facebook.com/v25.0/123456789012345/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer EAAG...");
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "text",
      text: { body: "hello", preview_url: false },
    });
  });

  it("attaches context.message_id only on the first chunk when chunking", async () => {
    const bodies: unknown[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ messages: [{ id: `wamid.${bodies.length}` }] });
    };
    const client = createCloudClient(account, { fetch: fakeFetch });
    const text = "a".repeat(WHATSAPP_TEXT_LIMIT) + "tail";
    const result = await client.sendText({
      to: "+15551234567",
      text,
      replyToMessageId: "wamid.REPLY",
    });
    assert.equal(bodies.length, 2);
    assert.deepEqual((bodies[0] as { context?: unknown }).context, { message_id: "wamid.REPLY" });
    assert.equal((bodies[1] as { context?: unknown }).context, undefined);
    assert.equal(result.messageId, "wamid.2"); // returns last chunk's id
  });

  it("retries on 503 then succeeds", async () => {
    let n = 0;
    const fakeFetch: typeof fetch = async () => {
      n++;
      if (n === 1) return new Response("oops", { status: 503 });
      return jsonResponse({ messages: [{ id: "wamid.OK" }] });
    };
    const client = createCloudClient(account, {
      fetch: fakeFetch,
      sleep: async () => undefined,
      maxRetries: 2,
    });
    const result = await client.sendText({ to: "+15551234567", text: "hi" });
    assert.equal(n, 2);
    assert.equal(result.messageId, "wamid.OK");
  });

  it("throws on non-retryable HTTP error", async () => {
    const fakeFetch: typeof fetch = async () => new Response("bad token", { status: 401 });
    const client = createCloudClient(account, { fetch: fakeFetch, sleep: async () => undefined });
    await assert.rejects(
      () => client.sendText({ to: "+15551234567", text: "hi" }),
      /HTTP 401/,
    );
  });

  it("throws OutsideServiceWindowError when Meta returns error code 131047", async () => {
    const errorBody = JSON.stringify({
      error: {
        message: "(#131047) Re-engagement message",
        type: "OAuthException",
        code: META_ERROR_OUTSIDE_SERVICE_WINDOW,
        error_subcode: 2018278,
      },
    });
    const fakeFetch: typeof fetch = async () => new Response(errorBody, { status: 400 });
    const client = createCloudClient(account, { fetch: fakeFetch, sleep: async () => undefined });
    await assert.rejects(
      () => client.sendText({ to: "+15551234567", text: "hi" }),
      (err: unknown) => {
        assert.ok(err instanceof OutsideServiceWindowError);
        assert.equal((err as OutsideServiceWindowError).code, 131047);
        assert.match((err as Error).message, /24h customer-service window/);
        return true;
      },
    );
  });

  it("other 400s still throw plain HTTP error, not OutsideServiceWindowError", async () => {
    const errorBody = JSON.stringify({ error: { code: 100, message: "invalid parameter" } });
    const fakeFetch: typeof fetch = async () => new Response(errorBody, { status: 400 });
    const client = createCloudClient(account, { fetch: fakeFetch, sleep: async () => undefined });
    await assert.rejects(
      () => client.sendText({ to: "+15551234567", text: "hi" }),
      (err: unknown) => {
        assert.ok(!(err instanceof OutsideServiceWindowError));
        assert.match((err as Error).message, /HTTP 400/);
        return true;
      },
    );
  });
});

describe("extractMetaErrorCode", () => {
  it("returns numeric code from error envelope", () => {
    assert.equal(
      extractMetaErrorCode(JSON.stringify({ error: { code: 131047, message: "x" } })),
      131047,
    );
  });
  it("returns null on non-Graph body", () => {
    assert.equal(extractMetaErrorCode("plain text"), null);
    assert.equal(extractMetaErrorCode(JSON.stringify({ other: "shape" })), null);
  });
});

describe("createCloudClient.sendTemplate", () => {
  it("POSTs Meta template payload", async () => {
    const calls: unknown[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ messages: [{ id: "wamid.TMPL" }] });
    };
    const client = createCloudClient(account, { fetch: fakeFetch });
    await client.sendTemplate({
      to: "+15551234567",
      name: "hello_world",
      languageCode: "en_US",
      components: [
        { type: "body", parameters: [{ type: "text", text: "Test User" }] },
      ],
    });
    assert.deepEqual(calls[0], {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "template",
      template: {
        name: "hello_world",
        language: { code: "en_US" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Test User" }] }],
      },
    });
  });
});

describe("createCloudClient.sendMedia", () => {
  it("rejects when neither link nor mediaId provided", async () => {
    const client = createCloudClient(account, { fetch: async () => jsonResponse({}) });
    await assert.rejects(
      () => client.sendMedia({ to: "+15551234567", kind: "image" }),
      /pass either link or mediaId/,
    );
  });

  it("posts image with link + caption", async () => {
    const bodies: unknown[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ messages: [{ id: "wamid.MEDIA" }] });
    };
    const client = createCloudClient(account, { fetch: fakeFetch });
    await client.sendMedia({
      to: "+15551234567",
      kind: "image",
      link: "https://example.com/cat.png",
      caption: "look",
    });
    assert.deepEqual(bodies[0], {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15551234567",
      type: "image",
      image: { link: "https://example.com/cat.png", caption: "look" },
    });
  });
});

describe("createCloudClient.markRead", () => {
  it("POSTs status=read", async () => {
    const bodies: unknown[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ success: true });
    };
    const client = createCloudClient(account, { fetch: fakeFetch });
    await client.markRead({ messageId: "wamid.X", typing: true });
    assert.deepEqual(bodies[0], {
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.X",
      typing_indicator: { type: "text" },
    });
  });
});
