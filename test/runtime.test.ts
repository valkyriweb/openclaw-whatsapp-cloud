import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __resetCloudRuntime, getCloudRuntime, setCloudRuntime } from "../src/runtime.js";

describe("runtime store", () => {
  it("throws before set", () => {
    __resetCloudRuntime();
    assert.throws(() => getCloudRuntime());
  });
  it("returns set runtime", () => {
    __resetCloudRuntime();
    setCloudRuntime({ hello: 1 });
    assert.deepEqual(getCloudRuntime(), { hello: 1 });
  });
});
