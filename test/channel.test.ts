import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cloudPlugin, webhookPathForAccount } from "../src/channel.js";

const validAccount = {
  accessToken: "EAAG...",
  phoneNumberId: "123456789012345",
  appSecret: "appSecret123",
  verifyToken: "verifyToken12",
};

describe("channel metadata", () => {
  it("declares id=whatsapp-cloud", () => {
    assert.equal(cloudPlugin.id, "whatsapp-cloud");
    assert.equal(cloudPlugin.meta.id, "whatsapp-cloud");
  });
  it("textChunkLimit is 4096", () => {
    assert.equal(cloudPlugin.outbound.textChunkLimit, 4096);
  });
  it("blocks streaming and supports reactions+media", () => {
    assert.equal(cloudPlugin.capabilities.blockStreaming, true);
    assert.equal(cloudPlugin.capabilities.reactions, true);
    assert.equal(cloudPlugin.capabilities.media, true);
  });
});

describe("webhookPathForAccount", () => {
  it("namespaces under /webhooks/whatsapp-cloud/", () => {
    assert.equal(webhookPathForAccount("default"), "/webhooks/whatsapp-cloud/default");
  });
  it("sanitizes weird account ids", () => {
    assert.equal(
      webhookPathForAccount("Account Name!"),
      "/webhooks/whatsapp-cloud/account_name_",
    );
  });
});

describe("channel.config", () => {
  it("listAccountIds reads channels.whatsapp-cloud section", () => {
    const ids = cloudPlugin.config.listAccountIds({
      channels: { "whatsapp-cloud": validAccount },
    });
    assert.deepEqual(ids, ["default"]);
  });

  it("resolveAccount returns the parsed account", () => {
    const resolved = cloudPlugin.config.resolveAccount(
      { channels: { "whatsapp-cloud": validAccount } },
      "default",
    );
    assert.ok(resolved);
    assert.equal(resolved.config.phoneNumberId, validAccount.phoneNumberId);
  });

  it("isConfigured true when all four required fields present", () => {
    const resolved = cloudPlugin.config.resolveAccount(
      { channels: { "whatsapp-cloud": validAccount } },
      "default",
    );
    assert.equal(cloudPlugin.config.isConfigured(resolved), true);
  });

  it("defaultAccountId returns 'default' for top-level config", () => {
    assert.equal(
      cloudPlugin.config.defaultAccountId({
        channels: { "whatsapp-cloud": validAccount },
      }),
      "default",
    );
  });
});
