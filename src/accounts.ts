import { CloudAccountSchema, type CloudConfig } from "./config-schema.js";
import type { CloudAccountConfig, ResolvedCloudAccount } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

function pickTopLevel(cfg: CloudConfig): Partial<CloudAccountConfig> {
  const { accounts: _accounts, ...rest } = cfg;
  return rest as Partial<CloudAccountConfig>;
}

function isFullyConfigured(cfg: Partial<CloudAccountConfig>): boolean {
  return Boolean(cfg.accessToken && cfg.phoneNumberId && cfg.appSecret && cfg.verifyToken);
}

export function listCloudAccountIds(cfg: CloudConfig): string[] {
  const ids = new Set<string>();
  const top = pickTopLevel(cfg);
  if (isFullyConfigured(top)) ids.add(DEFAULT_ACCOUNT_ID);
  if (cfg.accounts) {
    for (const k of Object.keys(cfg.accounts)) ids.add(k);
  }
  return Array.from(ids);
}

export function resolveDefaultCloudAccountId(cfg: CloudConfig): string | undefined {
  const ids = listCloudAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : ids[0];
}

export function resolveCloudAccount(
  cfg: CloudConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): ResolvedCloudAccount | undefined {
  const top = pickTopLevel(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (!isFullyConfigured(top)) return undefined;
    const parsed = CloudAccountSchema.safeParse(top);
    if (!parsed.success) return undefined;
    return { accountId, config: parsed.data };
  }
  const sub = cfg.accounts?.[accountId];
  if (!sub) return undefined;
  // Overlay: sub-accounts inherit top-level fields as fallbacks.
  const merged = { ...top, ...sub };
  const parsed = CloudAccountSchema.safeParse(merged);
  if (!parsed.success) return undefined;
  return { accountId, config: parsed.data };
}
