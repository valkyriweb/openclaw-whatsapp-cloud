#!/usr/bin/env node
/**
 * Standalone live round-trip harness for openclaw-whatsapp-cloud.
 *
 * Wires the plugin's own webhook handler + Cloud client to a local HTTP server.
 * Inbound messages are echoed back to the sender via sendText.
 *
 * Usage:
 *   1. Build first: npm run build
 *   2. Set env vars:
 *        WA_ACCESS_TOKEN     - Meta System User token (from 1Password)
 *        WA_PHONE_NUMBER_ID  - digits-only phone_number_id
 *        WA_APP_SECRET       - Meta App Secret (Meta App Dashboard -> Settings -> Basic -> App Secret)
 *        WA_VERIFY_TOKEN     - any string you choose; same string goes into Meta dashboard
 *        WA_PORT             - optional, default 8787
 *   3. node scripts/live-test.mjs
 *   4. In another terminal: ngrok http 8787
 *   5. Paste the ngrok https URL + /webhooks/whatsapp-cloud/default into
 *      Meta App Dashboard -> WhatsApp -> Configuration -> Callback URL.
 *      Use the same WA_VERIFY_TOKEN as the "Verify token". Click
 *      "Verify and save", then subscribe to the `messages` webhook field.
 *   6. Reply from your phone to the WABA number. The harness echoes back
 *      "echo: <your text>" within a few hundred ms.
 *   7. Ctrl-C to stop. Replies do NOT modify any persistent state.
 */
import { createServer } from "node:http";
import {
  createCloudClient,
  createCloudWebhookHandler,
  IdempotencyCache,
} from "../dist/api.js";

/**
 * Inline shim of openclaw/plugin-sdk/webhook-ingress — covers exactly what
 * createCloudWebhookHandler needs so the harness runs without a host openclaw
 * install. The real gateway threads in the live SDK; tests use a stub; the
 * harness uses this. Same surface.
 */
class BodyTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

const sdk = {
  applyBasicWebhookRequestGuards: ({ req, res, allowMethods, requireJsonContentType }) => {
    if (allowMethods && !allowMethods.includes(req.method ?? "")) {
      res.statusCode = 405;
      res.end("method not allowed");
      return false;
    }

    if (requireJsonContentType) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        res.statusCode = 415;
        res.end("unsupported media type");
        return false;
      }
    }

    return true;
  },
  readRequestBodyWithLimit: (req, { maxBytes, timeoutMs = 30_000, encoding = "utf8" }) =>
    new Promise((resolve, reject) => {
      let total = 0;
      const chunks = [];
      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error("body read timeout"));
      }, timeoutMs);

      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          clearTimeout(timeout);
          req.destroy();
          reject(new BodyTooLargeError(`body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString(encoding));
      });
      req.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    }),
  isRequestBodyLimitError: (err) => err instanceof BodyTooLargeError,
  requestBodyErrorToText: (err) => (err instanceof Error ? err.message : String(err)),
};

const required = ["WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID", "WA_APP_SECRET", "WA_VERIFY_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing env: ${missing.join(", ")}`);
  process.exit(2);
}

const accountConfig = {
  accessToken: process.env.WA_ACCESS_TOKEN,
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  appSecret: process.env.WA_APP_SECRET,
  verifyToken: process.env.WA_VERIFY_TOKEN,
};
const port = Number(process.env.WA_PORT ?? 8787);

const client = createCloudClient(accountConfig);
const idempotency = new IdempotencyCache(1000);

let inboundCount = 0;
let lastInboundAt = null;

const httpHandler = createCloudWebhookHandler({
  accountId: "default",
  accountConfig,
  idempotency,
  sdk,
  log: {
    info: (...a) => console.log("[info]", ...a),
    warn: (...a) => console.warn("[warn]", ...a),
    error: (...a) => console.error("[error]", ...a),
  },
  onMessages: async (messages) => {
    for (const m of messages) {
      inboundCount += 1;
      lastInboundAt = Date.now();
      const text = m.text ?? "(no text)";
      const from = m.from ?? "(no from)";
      console.log(`\n[inbound #${inboundCount}] ${from} -> ${JSON.stringify(text)}`);
      const t0 = Date.now();
      try {
        const result = await client.sendText({ to: from, text: `echo: ${text}` });
        const ms = Date.now() - t0;
        console.log(`[outbound] -> ${from} in ${ms}ms, wamid=${result.messageId ?? "n/a"}`);
      } catch (err) {
        console.error(`[outbound failed]`, err);
      }
    }
  },
  onStatuses: (statuses) => {
    for (const s of statuses) {
      console.log(`[status] ${s.status} ${s.messageId}${s.recipientId ? " -> " + s.recipientId : ""}`);
    }
  },
});

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, inboundCount, lastInboundAt }));
    return;
  }
  httpHandler(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  openclaw-whatsapp-cloud live harness`);
  console.log(`  listening on http://127.0.0.1:${port}`);
  console.log(`  webhook path: /webhooks/whatsapp-cloud/default`);
  console.log(`  verify token: ${accountConfig.verifyToken}`);
  console.log(`\n  next steps:`);
  console.log(`    1. ngrok http ${port}`);
  console.log(`    2. paste https://<ngrok>/webhooks/whatsapp-cloud/default into Meta dashboard`);
  console.log(`    3. reply from phone\n`);
});

const shutdown = () => {
  console.log("\nshutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
