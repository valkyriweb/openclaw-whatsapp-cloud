#!/usr/bin/env node
/**
 * openclaw-whatsapp-cloud CLI — small ops helpers that don't need the
 * full OpenClaw runtime. Currently:
 *
 *   openclaw-whatsapp-cloud templates list
 *
 * Reads credentials from env so it stays scriptable. Wire it into the
 * OpenClaw CLI proper with `openclaw whatsapp-cloud …` once OpenClaw's
 * channel-CLI surface lands; until then this binary is the CLI.
 */

import { listTemplates } from "../src/templates.js";
import type { CloudAccountConfig } from "../src/types.js";

const USAGE = `
openclaw-whatsapp-cloud <command>

Commands:
  templates list                List approved WABA templates (json, default)
  templates list --table        Print a tabular summary

Env:
  WHATSAPP_CLOUD_ACCESS_TOKEN   Required.
  WHATSAPP_CLOUD_PHONE_NUMBER_ID  Required for send commands; templates list only needs WABA_ID.
  WHATSAPP_CLOUD_WABA_ID        Required for templates list.
  WHATSAPP_CLOUD_APP_SECRET     Optional here (only enforced by the runtime).
  WHATSAPP_CLOUD_VERIFY_TOKEN   Optional here (only enforced by the runtime).
  WHATSAPP_CLOUD_API_BASE_URL   Optional.
  WHATSAPP_CLOUD_API_VERSION    Optional.
`;

async function main(argv: string[]): Promise<number> {
  const [command, subcommand, ...rest] = argv;
  if (command === "templates" && subcommand === "list") {
    return await runTemplatesList(rest);
  }
  process.stderr.write(USAGE.trimStart());
  return command || subcommand ? 2 : 0;
}

async function runTemplatesList(args: string[]): Promise<number> {
  const account = accountFromEnv();
  if (!account.wabaId) {
    process.stderr.write("error: WHATSAPP_CLOUD_WABA_ID required for templates list\n");
    return 2;
  }
  const templates = await listTemplates({ account });
  if (args.includes("--table")) {
    const widths = { name: 30, lang: 8, status: 12, category: 14 };
    const header = `${"NAME".padEnd(widths.name)}  ${"LANG".padEnd(widths.lang)}  ${"STATUS".padEnd(widths.status)}  CATEGORY`;
    process.stdout.write(header + "\n");
    process.stdout.write("".padEnd(header.length, "-") + "\n");
    for (const t of templates) {
      process.stdout.write(
        `${t.name.padEnd(widths.name)}  ${t.language.padEnd(widths.lang)}  ${t.status.padEnd(widths.status)}  ${t.category ?? ""}\n`,
      );
    }
  } else {
    process.stdout.write(JSON.stringify(templates, null, 2) + "\n");
  }
  return 0;
}

function accountFromEnv(): CloudAccountConfig {
  const accessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  if (!accessToken) {
    process.stderr.write("error: WHATSAPP_CLOUD_ACCESS_TOKEN required\n");
    process.exit(2);
  }
  return {
    accessToken,
    phoneNumberId: process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? "0",
    appSecret: process.env.WHATSAPP_CLOUD_APP_SECRET ?? "unused-by-cli-",
    verifyToken: process.env.WHATSAPP_CLOUD_VERIFY_TOKEN ?? "unused-by-cli-",
    wabaId: process.env.WHATSAPP_CLOUD_WABA_ID,
    apiBaseUrl: process.env.WHATSAPP_CLOUD_API_BASE_URL,
    apiVersion: process.env.WHATSAPP_CLOUD_API_VERSION,
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
