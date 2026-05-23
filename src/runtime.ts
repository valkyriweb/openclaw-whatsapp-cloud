/**
 * Minimal runtime store, shaped the same way as openclaw-vk's `runtime.ts`.
 *
 * The OpenClaw host provides a `PluginRuntime` object via `api.runtime` in
 * `register(api)`. Other modules in this plugin call `getCloudRuntime()` to
 * read it without threading it through every call.
 */

export type PluginRuntime = Record<string, unknown>;

let current: PluginRuntime | null = null;

export function setCloudRuntime(rt: PluginRuntime): void {
  current = rt;
}

export function getCloudRuntime(): PluginRuntime {
  if (!current) {
    throw new Error("whatsapp-cloud runtime not initialized — plugin not registered");
  }
  return current;
}

/** Test-only: clear the stored runtime between tests. */
export function __resetCloudRuntime(): void {
  current = null;
}
