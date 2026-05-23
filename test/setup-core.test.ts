import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cloudSetupPlugin, cloudWebhookUrl, validateAnswers } from "../src/setup-core.js";

describe("cloudWebhookUrl", () => {
  it("composes public-base + path with accountId", () => {
    assert.equal(
      cloudWebhookUrl("https://wa.example.com/", "default"),
      "https://wa.example.com/webhooks/whatsapp-cloud/default",
    );
  });
});

describe("validateAnswers", () => {
  it("accepts a complete answer set", () => {
    const out = validateAnswers({
      accessToken: "x",
      phoneNumberId: "1",
      appSecret: "appSecret123",
      verifyToken: "verifyToken12",
    });
    assert.equal(out.ok, true);
  });
  it("collects per-field issues on bad input", () => {
    const out = validateAnswers({
      accessToken: "",
      phoneNumberId: "+x",
      appSecret: "",
      verifyToken: "",
    });
    assert.equal(out.ok, false);
    assert.ok(out.ok === false && out.issues.length >= 3);
  });
});

describe("cloudSetupPlugin shape", () => {
  it("has the four required wizard questions", () => {
    const keys = cloudSetupPlugin.setupWizard.questions.map((q) => q.key);
    for (const k of ["accessToken", "phoneNumberId", "appSecret", "verifyToken"]) {
      assert.ok(keys.includes(k), `missing question: ${k}`);
    }
  });
});
