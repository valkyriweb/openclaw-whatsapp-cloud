# openclaw-whatsapp-cloud

**Native OpenClaw channel plugin for WhatsApp Business via Meta Cloud API direct.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)
[![OpenClaw](https://img.shields.io/badge/openclaw-plugin-orange.svg)](https://github.com/openclaw)

Connect WhatsApp Business to your [OpenClaw](https://github.com/openclaw) agent **without a BSP and without Baileys**: stateless REST sends, HMAC-signed webhooks, no phone keep-alive. The number lives server-side at Meta — your agent talks to it over the Cloud API directly.

Coexists with the upstream Baileys-based `@openclaw/whatsapp` plugin. Distinct channel id (`whatsapp-cloud`) — pick per-account which transport you want.

## What this is

A first-class, in-process OpenClaw channel plugin. When you install it, OpenClaw treats WhatsApp exactly like Telegram or VK: the agent can proactively message users, reply to inbound messages, schedule crons that deliver over WhatsApp, and honor approval gates — all over the standard channel surface.

Forked from [`TomasWard1/openclaw-whatsapp-kapso`](https://github.com/TomasWard1/openclaw-whatsapp-kapso) (MIT) — the Kapso transport was retargeted at Meta direct; the channel-plugin scaffold (LRU dedup, ESM register entry, channel-runtime dispatch, plugin-sdk webhook ingress) was preserved.

## Why this over Baileys?

| Aspect | **openclaw-whatsapp-cloud** (this repo) | `@openclaw/whatsapp` (Baileys) |
| --- | --- | --- |
| Where the number lives | Meta servers (WABA) | Your phone (linked device) |
| Keep-alive | None — stateless REST | Persistent socket; linked device expires every ~14 days |
| Inbound transport | HTTPS webhook | WebSocket from phone |
| Setup | Verify business + register webhook | Scan QR with phone |
| Cost | Per-conversation Meta pricing | Free (Baileys is unofficial) |
| Templates | Required outside the 24h service window | N/A |
| Best for | Production / unattended | Personal / iterating |

## Features

- [x] Text messages (chunked at Meta's 4096-char limit; reply-quote applied to first chunk only)
- [x] Template messages (`type: template` with `components[]`)
- [x] Media outbound: image, audio, document, video, sticker via URL or pre-uploaded media id
- [x] Reactions outbound (`type: reaction`)
- [x] Read receipts + typing indicator (`PUT /messages` with `status: read`)
- [x] Reply-to / quoted messages (`context.message_id`)
- [x] Inbound webhook parser for Meta v25.0 payloads (`entry[].changes[].value.messages[]`)
- [x] `X-Hub-Signature-256` HMAC-SHA256 verification over raw body (constant-time compare)
- [x] Webhook subscribe handshake (GET `hub.challenge` echo with verify-token match)
- [x] Idempotency dedupe on wamid (bounded LRU)
- [x] Status callbacks (sent/delivered/read) surfaced for downstream tracking
- [x] Media inbound: two-step Meta fetch (id → URL → bytes) saved through host media store
- [x] Multi-account (default + named sub-accounts, each with its own number)
- [x] Cron / announce / approval-aware — matches OpenClaw's capability contract
- [x] Template registry CLI (`openclaw-whatsapp-cloud templates list`)

## Quick start

```bash
# 1. Install the plugin
openclaw plugins install openclaw-whatsapp-cloud

# 2. Add a WhatsApp-Cloud channel (launches the interactive wizard)
openclaw channels add --channel whatsapp-cloud

# 3. In Meta App Dashboard → WhatsApp → Configuration:
#    - Callback URL: the URL printed by the wizard
#    - Verify token: the same string you entered in the wizard
#    - Subscribe to the 'messages' webhook field
```

The wizard collects:

- **System User access token** (`business.facebook.com` → System Users → Generate New Token with `whatsapp_business_messaging` + `whatsapp_business_management`)
- **`phone_number_id`** — digits-only Meta id for the WABA number
- **App Secret** — App Settings → Basic → App Secret (used to HMAC-verify webhooks; **not** the access token)
- **Verify token** — any string you choose (≥8 chars); echoed back to Meta on the subscribe handshake
- **WABA id** (optional but required for the template registry CLI)

## Configuration reference

The plugin reads its configuration from the OpenClaw config file under `channels.whatsapp-cloud`:

```jsonc
{
  "channels": {
    "whatsapp-cloud": {
      "accessToken": "EAAG...",
      "phoneNumberId": "123456789012345",
      "appSecret": "<meta-app-secret>",
      "verifyToken": "<verify-token-you-chose>",
      "wabaId": "987654321098765",
      "apiBaseUrl": "https://graph.facebook.com",
      "apiVersion": "v25.0"
    }
  }
}
```

Multi-account (default + named):

```jsonc
{
  "channels": {
    "whatsapp-cloud": {
      "accessToken": "EAAG-default...",
      "phoneNumberId": "123456789012345",
      "appSecret": "shared-app-secret",
      "verifyToken": "shared-verify-token",
      "accounts": {
        "sandbox": {
          "accessToken": "EAAG-sandbox...",
          "phoneNumberId": "222222222222222",
          "appSecret": "shared-app-secret",
          "verifyToken": "shared-verify-token"
        }
      }
    }
  }
}
```

Each sub-account overlays the top-level config — only specify what changes.

## Public webhook ingress (production)

Meta needs a publicly reachable HTTPS endpoint. OpenClaw lives on a tailnet host inside the cluster, so you need a tunnel. The recommended setup is a `cloudflared` tunnel from `wa.example.com` (or a subdomain you own on Cloudflare) to the gateway pod's webhook port:

```bash
# On the host running cloudflared:
cloudflared tunnel create openclaw-wa
cloudflared tunnel route dns openclaw-wa wa.example.com
cat > ~/.cloudflared/openclaw-wa.yml <<EOF
tunnel: openclaw-wa
credentials-file: ~/.cloudflared/<uuid>.json
ingress:
  - hostname: wa.example.com
    service: http://127.0.0.1:31789   # OpenClaw gateway port
  - service: http_status:404
EOF
cloudflared tunnel run openclaw-wa
```

Then in the Meta App Dashboard the callback URL is `https://wa.example.com/webhooks/whatsapp-cloud/<accountId>`.

The plugin enforces:

- `X-Hub-Signature-256` HMAC verification (returns `401` on missing/forged)
- `hub.challenge` subscribe handshake on GET
- 1 MiB body cap, 30 s read timeout
- Shared rate limiter across all accounts (per IP × path)
- LRU dedup on wamid so Meta retries don't double-dispatch

## Template registry CLI

```bash
WHATSAPP_CLOUD_ACCESS_TOKEN=EAAG... \
WHATSAPP_CLOUD_WABA_ID=987654321098765 \
  npx openclaw-whatsapp-cloud templates list --table
```

Returns approved templates from `/v25.0/{wabaId}/message_templates`. JSON by default; `--table` for human-readable.

## 24h service window

Outside Meta's 24h customer-initiated window, only **approved templates** can be sent. The plugin doesn't currently pre-flight the window — Meta returns an error response on attempt and the send call rejects with `whatsapp-cloud: HTTP 400 — …`. Surfacing a structured "outside-window" error is on the Phase 2 roadmap.

## Requirements

- Node.js `>=20`
- An OpenClaw host (≥ `2026.5.19`) that supports the `@openclaw/plugin-sdk` plugin contract
- A verified Meta WABA, a phone number registered to it, and a System User token with the WhatsApp scopes

## Development

```bash
git clone https://github.com/valkyriweb/openclaw-whatsapp-cloud
cd openclaw-whatsapp-cloud
npm install
npm test           # full unit suite (node --test + tsx)
npm run test:watch # TDD loop
npm run check:pack # validate what would ship to npm
```

TDD is the default workflow: new behavior lands as a failing test first. The `test/` directory mirrors `src/` one-to-one.

## License

MIT © 2026 valkyriweb — see [LICENSE](./LICENSE).

Portions © 2026 Tomas Ward (forked from `openclaw-whatsapp-kapso`, MIT).

## Credits

- Forked from [`TomasWard1/openclaw-whatsapp-kapso`](https://github.com/TomasWard1/openclaw-whatsapp-kapso) — MIT-licensed Kapso-flavored channel plugin whose scaffold (HMAC verify, LRU dedup, plugin-sdk webhook ingress, channel-runtime dispatch) we kept verbatim.
- Structural inspiration: [`pfrankov/openclaw-vk`](https://github.com/pfrankov/openclaw-vk) — the reference third-party OpenClaw channel plugin.
