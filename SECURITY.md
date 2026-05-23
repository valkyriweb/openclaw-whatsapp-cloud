# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in this package — especially anything related to webhook signature verification, credential handling, or payload parsing — please report it privately:

**Contact:** `tomas@familiaward.com.ar`

Please include:

- A description of the issue and its impact
- A reproduction (minimal payload / config / code is ideal)
- Your preferred contact and any timeline constraints

## Disclosure window

I will acknowledge receipt within **72 hours** and work toward a fix. Coordinated disclosure window is **90 days** by default — longer if the fix requires broader ecosystem coordination, shorter if the issue is actively being exploited.

Please do **not** open a public GitHub issue or PR for security problems until a fix has been released. After release, the vulnerability will be credited (with your consent) in the changelog and GitHub Security Advisory.

## Scope

In scope:

- HMAC signature verification / bypass
- Idempotency cache poisoning
- Credential leakage (API key, webhook secret) via logs or error messages
- Injection via webhook payload fields
- Dependency vulnerabilities affecting the published package

Out of scope:

- Vulnerabilities in Kapso itself (report to `security@kapso.ai`)
- Vulnerabilities in the OpenClaw host runtime (report upstream)
- Denial-of-service via raw webhook flood (rate-limiting is the host's responsibility)

## Supported versions

The most recent release is supported. Older versions receive fixes only for high-severity issues.
