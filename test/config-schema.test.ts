import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CloudAccountSchema, CloudConfigSchema } from "../src/config-schema.js";

describe("CloudAccountSchema", () => {
  it("accepts a minimal valid account", () => {
    const parsed = CloudAccountSchema.parse({
      accessToken: "EAAGm0PX...",
      phoneNumberId: "123456789012345",
      appSecret: "thisIsTheAppSecret",
      verifyToken: "verify-token-here",
    });
    assert.equal(parsed.accessToken, "EAAGm0PX...");
  });

  it("rejects non-digits phoneNumberId", () => {
    const result = CloudAccountSchema.safeParse({
      accessToken: "x",
      phoneNumberId: "+123456789012345",
      appSecret: "appSecret123",
      verifyToken: "verifyToken12",
    });
    assert.equal(result.success, false);
  });

  it("rejects appSecret shorter than 8 chars", () => {
    const result = CloudAccountSchema.safeParse({
      accessToken: "x",
      phoneNumberId: "123456789012345",
      appSecret: "short",
      verifyToken: "verifyToken12",
    });
    assert.equal(result.success, false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = CloudAccountSchema.safeParse({
      accessToken: "x",
      phoneNumberId: "123456789012345",
      appSecret: "appSecret123",
      verifyToken: "verifyToken12",
      typo: "oops",
    });
    assert.equal(result.success, false);
  });

  it("accepts apiVersion override matching vNN.N", () => {
    const parsed = CloudAccountSchema.parse({
      accessToken: "x",
      phoneNumberId: "1",
      appSecret: "appSecret123",
      verifyToken: "verifyToken12",
      apiVersion: "v25.0",
    });
    assert.equal(parsed.apiVersion, "v25.0");
  });
});

describe("CloudConfigSchema", () => {
  it("allows multi-account config", () => {
    const parsed = CloudConfigSchema.parse({
      accessToken: "default-token",
      phoneNumberId: "111",
      appSecret: "appSecret123",
      verifyToken: "verifyToken12",
      accounts: {
        sandbox: {
          accessToken: "sandbox-token",
          phoneNumberId: "222",
          appSecret: "appSecret456",
          verifyToken: "verifyToken34",
        },
      },
    });
    assert.equal(parsed.accounts?.sandbox.phoneNumberId, "222");
  });

  it("allows accounts-only (no top-level defaults)", () => {
    const parsed = CloudConfigSchema.parse({
      accounts: {
        a: {
          accessToken: "a-token",
          phoneNumberId: "1",
          appSecret: "appSecret123",
          verifyToken: "verifyToken12",
        },
      },
    });
    assert.equal(parsed.accessToken, undefined);
  });
});
