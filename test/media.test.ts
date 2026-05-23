import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { downloadMediaBytes, fetchMediaMetadata } from "../src/media.js";
import type { CloudAccountConfig } from "../src/types.js";

const account: CloudAccountConfig = {
  accessToken: "EAAG...",
  phoneNumberId: "123456789012345",
  appSecret: "appSecret123",
  verifyToken: "verifyToken12",
};

describe("fetchMediaMetadata", () => {
  it("GETs /v25.0/{mediaId} with Bearer and returns url+meta", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal((init?.headers as Record<string, string>)["Authorization"], "Bearer EAAG...");
      return new Response(
        JSON.stringify({
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=ABC",
          mime_type: "image/jpeg",
          file_size: 1234,
          sha256: "deadbeef",
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const meta = await fetchMediaMetadata({
      mediaId: "media-123",
      account,
      fetch: fakeFetch,
    });
    assert.equal(meta.url, "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=ABC");
    assert.equal(meta.mimeType, "image/jpeg");
    assert.equal(meta.size, 1234);
    assert.equal(calls[0], "https://graph.facebook.com/v25.0/media-123");
  });

  it("throws on non-2xx", async () => {
    const fakeFetch: typeof fetch = async () => new Response("nope", { status: 404 });
    await assert.rejects(
      () => fetchMediaMetadata({ mediaId: "x", account, fetch: fakeFetch }),
      /HTTP 404/,
    );
  });
});

describe("downloadMediaBytes", () => {
  it("performs the two-step fetch with Bearer on both calls", async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      urls.push(String(url));
      assert.equal((init?.headers as Record<string, string>)["Authorization"], "Bearer EAAG...");
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=ABC",
            mime_type: "image/jpeg",
            file_size: 4,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/jpeg" },
      });
    };
    const out = await downloadMediaBytes({ mediaId: "m", account, fetch: fakeFetch });
    assert.equal(out.size, 4);
    assert.equal(out.mimeType, "image/jpeg");
    assert.equal(urls[0], "https://graph.facebook.com/v25.0/m");
    assert.equal(urls[1], "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=ABC");
  });
});
