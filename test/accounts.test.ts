import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ACCOUNT_ID,
  listCloudAccountIds,
  resolveCloudAccount,
  resolveDefaultCloudAccountId,
} from "../src/accounts.js";
import type { CloudConfig } from "../src/config-schema.js";

const top = {
  accessToken: "TOP",
  phoneNumberId: "111",
  appSecret: "appSecret123",
  verifyToken: "verifyToken12",
} as const;

describe("accounts", () => {
  it("lists default when top-level is fully configured", () => {
    const cfg: CloudConfig = { ...top };
    assert.deepEqual(listCloudAccountIds(cfg), [DEFAULT_ACCOUNT_ID]);
  });

  it("lists named accounts in addition to default", () => {
    const cfg: CloudConfig = {
      ...top,
      accounts: { sandbox: { ...top, accessToken: "SAND", phoneNumberId: "222" } },
    };
    assert.deepEqual(listCloudAccountIds(cfg).sort(), ["default", "sandbox"]);
  });

  it("returns undefined when default is missing required fields", () => {
    const cfg: CloudConfig = { accessToken: "x" };
    assert.equal(resolveCloudAccount(cfg, DEFAULT_ACCOUNT_ID), undefined);
  });

  it("sub-account inherits top-level fields", () => {
    const cfg: CloudConfig = {
      ...top,
      accounts: { sandbox: { phoneNumberId: "999" } as unknown as CloudConfig["accounts"][string] },
    };
    const resolved = resolveCloudAccount(cfg, "sandbox");
    assert.ok(resolved);
    assert.equal(resolved.config.phoneNumberId, "999");
    assert.equal(resolved.config.accessToken, "TOP");
    assert.equal(resolved.config.appSecret, "appSecret123");
  });

  it("resolveDefaultCloudAccountId prefers 'default' when present", () => {
    const cfg: CloudConfig = {
      ...top,
      accounts: { other: { ...top, phoneNumberId: "555" } },
    };
    assert.equal(resolveDefaultCloudAccountId(cfg), "default");
  });

  it("resolveDefaultCloudAccountId falls back to first named account when no default", () => {
    const cfg: CloudConfig = {
      accounts: { only: { ...top } },
    };
    assert.equal(resolveDefaultCloudAccountId(cfg), "only");
  });
});
