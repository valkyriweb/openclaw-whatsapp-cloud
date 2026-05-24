/**
 * ESM setup-entry consumed by the OpenClaw CLI's `channels add` wizard.
 *
 * If the host's SDK provides `defineSetupPluginEntry`, we use it; otherwise
 * we export the setup plugin directly and the host adapts.
 */

import { cloudPlugin } from "./src/channel.js";
import { cloudSetupPlugin } from "./src/setup-core.js";

export { cloudSetupPlugin };

export const setupChannelPlugin = {
  ...cloudPlugin,
  setupWizard: cloudSetupPlugin.setupWizard,
};

let defineSetupPluginEntry: ((plugin: unknown) => unknown) | undefined;
try {
  // Optional — present when the host ships the plugin SDK.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ defineSetupPluginEntry } = require("openclaw/plugin-sdk/core"));
} catch {
  defineSetupPluginEntry = undefined;
}

export default defineSetupPluginEntry
  ? defineSetupPluginEntry(setupChannelPlugin)
  : { plugin: setupChannelPlugin };
