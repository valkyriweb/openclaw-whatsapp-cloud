import { resolveApiRoot } from "./send.js";
import type { CloudAccountConfig } from "./types.js";

export interface CloudMediaMetadata {
  /** Meta CDN URL — short-lived (~5 min). Requires Bearer auth to download. */
  url: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
}

export interface CloudMediaBytes {
  bytes: Uint8Array;
  mimeType?: string;
  size: number;
}

export interface FetchMediaInput {
  mediaId: string;
  account: CloudAccountConfig;
  fetch?: typeof fetch;
}

/**
 * Resolve a Meta media_id to a fresh download URL + metadata.
 *
 * Webhooks only carry media ids — the binary lives behind a two-step fetch:
 *   1. GET `/v25.0/{media-id}` with Bearer → `{ url, mime_type, file_size, sha256 }`
 *   2. GET `url` with the same Bearer → bytes
 *
 * Both URLs expire in ~5 minutes, so async consumers should hold the
 * `mediaId` and call this helper when they actually need the bytes — not
 * cache `url`.
 */
export async function fetchMediaMetadata(
  input: FetchMediaInput,
): Promise<CloudMediaMetadata> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiRoot = resolveApiRoot(input.account);
  const url = `${apiRoot}/${encodeURIComponent(input.mediaId)}`;

  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.account.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `whatsapp-cloud media: HTTP ${res.status} fetching metadata for ${input.mediaId} — ${text.slice(0, 300)}`,
    );
  }
  const parsed = (await res.json()) as Record<string, unknown>;
  const metaUrl = typeof parsed.url === "string" ? parsed.url : undefined;
  if (!metaUrl) {
    throw new Error(
      `whatsapp-cloud media: response missing url — ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  return {
    url: metaUrl,
    mimeType: typeof parsed.mime_type === "string" ? parsed.mime_type : undefined,
    size: typeof parsed.file_size === "number" ? parsed.file_size : undefined,
    sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : undefined,
  };
}

/**
 * Two-step download: resolve fresh URL via {@link fetchMediaMetadata}, then
 * pull bytes from the Meta CDN with the System User bearer.
 */
export async function downloadMediaBytes(
  input: FetchMediaInput,
): Promise<CloudMediaBytes> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const meta = await fetchMediaMetadata(input);

  const res = await fetchImpl(meta.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.account.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `whatsapp-cloud media: HTTP ${res.status} downloading ${input.mediaId} — ${text.slice(0, 300)}`,
    );
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const contentType = res.headers.get("content-type") ?? undefined;
  return {
    bytes,
    mimeType: meta.mimeType ?? contentType ?? undefined,
    size: bytes.length,
  };
}
