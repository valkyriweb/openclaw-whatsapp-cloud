/**
 * Template registry — list approved templates for a WABA.
 *
 * Phase 2 helper backing `openclaw whatsapp-cloud templates list`. Reads
 * `/v{api}/{wabaId}/message_templates` and returns the trimmed shape callers
 * usually need: name, language, status, category, and the raw components so
 * a UI can show parameter placeholders.
 */

import { resolveApiRoot } from "./send.js";
import type { CloudAccountConfig } from "./types.js";

export interface CloudTemplate {
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: Array<Record<string, unknown>>;
  id?: string;
}

export interface ListTemplatesInput {
  account: CloudAccountConfig;
  fetch?: typeof fetch;
  /** Max templates to return — defaults to first page (Meta's default 25). */
  limit?: number;
}

export async function listTemplates(input: ListTemplatesInput): Promise<CloudTemplate[]> {
  if (!input.account.wabaId) {
    throw new Error("whatsapp-cloud templates: account is missing wabaId");
  }
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiRoot = resolveApiRoot(input.account);
  const params = new URLSearchParams({
    fields: "name,language,status,category,components,id",
    limit: String(input.limit ?? 25),
  });
  const url = `${apiRoot}/${encodeURIComponent(input.account.wabaId)}/message_templates?${params}`;

  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.account.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `whatsapp-cloud templates: HTTP ${res.status} listing ${input.account.wabaId} — ${text.slice(0, 300)}`,
    );
  }
  const parsed = (await res.json()) as { data?: unknown };
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  return data
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .map((t) => ({
      name: String(t.name ?? ""),
      language: String(t.language ?? ""),
      status: String(t.status ?? ""),
      category: typeof t.category === "string" ? t.category : undefined,
      components: Array.isArray(t.components) ? (t.components as Array<Record<string, unknown>>) : undefined,
      id: typeof t.id === "string" ? t.id : undefined,
    }))
    .filter((t) => t.name);
}
