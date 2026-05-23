/**
 * ESM register-entry consumed by the OpenClaw host.
 *
 * The host calls `register(api)` with a `PluginRuntime`; we stash it in a
 * module-level store and register our channel via `api.registerChannel`.
 *
 * Shipped as compiled ESM .js because Node refuses to strip TypeScript types
 * for files inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 */

import { cloudPlugin } from "./src/channel.js";
import { setCloudRuntime } from "./src/runtime.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

interface PluginApi {
  runtime: Record<string, unknown>;
  registerChannel: (args: { plugin: unknown }) => void;
}

export function register(api: PluginApi): void {
  setCloudRuntime(api.runtime);
  api.registerChannel({ plugin: cloudPlugin });
}

export const id = "whatsapp-cloud";
export const name = "WhatsApp (Cloud API)";
export const description = "Native OpenClaw channel plugin for WhatsApp via Meta Cloud API direct";
export const configSchema = (manifest as { configSchema: Record<string, unknown> }).configSchema;

export default {
  id,
  name,
  description,
  configSchema,
  register,
};
