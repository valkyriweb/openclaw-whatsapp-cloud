import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listTemplates } from "../src/templates.js";
import type { CloudAccountConfig } from "../src/types.js";

const account: CloudAccountConfig = {
  accessToken: "EAAG...",
  phoneNumberId: "1",
  appSecret: "appSecret123",
  verifyToken: "verifyToken12",
  wabaId: "987654321098765",
};

describe("listTemplates", () => {
  it("GETs /v25.0/{wabaId}/message_templates with Bearer", async () => {
    let captured = "";
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = String(url);
      assert.equal((init?.headers as Record<string, string>)["Authorization"], "Bearer EAAG...");
      return new Response(
        JSON.stringify({
          data: [
            {
              name: "hello_world",
              language: "en_US",
              status: "APPROVED",
              category: "UTILITY",
              id: "tmpl-1",
              components: [{ type: "BODY", text: "Hello" }],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const out = await listTemplates({ account, fetch: fakeFetch });
    assert.ok(captured.startsWith("https://graph.facebook.com/v25.0/987654321098765/message_templates?"));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "hello_world");
    assert.equal(out[0].status, "APPROVED");
    assert.equal(out[0].category, "UTILITY");
  });

  it("requires wabaId", async () => {
    await assert.rejects(
      () => listTemplates({ account: { ...account, wabaId: undefined }, fetch: async () => new Response("") }),
      /missing wabaId/,
    );
  });
});
