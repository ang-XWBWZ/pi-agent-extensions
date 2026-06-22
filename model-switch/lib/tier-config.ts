/**
 * tier-config.ts — 层级配置读写 + 解析
 *
 * 自 v4.2 使用共享 settings-io 单例，不再直接读写磁盘。
 * 避免与 provider-manager 的 settings 写入冲突。
 */

import { isValidThinkingLevel, type ThinkingLevel, type TierConfig, type TierKey, TIER_DEFAULTS } from "./types.js";
import { KEY_TIERS } from "./types.js";
import {
  getSettings,
  updateSettings,
  readSettings as compatRead,
  writeSettingsRaw as compatWrite,
} from "../../lib/settings-io.js";

export function readAllTiers(): Record<TierKey, TierConfig> {
  const s = getSettings();
  const tiers = s[KEY_TIERS] as Record<string, unknown> | undefined;
  if (!tiers || typeof tiers !== "object") return {} as Record<TierKey, TierConfig>;

  const result: Record<string, TierConfig> = {};
  for (const key of ["L0", "L1", "L2"] as TierKey[]) {
    const t = tiers[key] as Record<string, unknown> | undefined;
    if (t && typeof t === "object" && Array.isArray(t.models)) {
      result[key] = {
        label: (t.label as string) || TIER_DEFAULTS[key].label,
        desc: (t.desc as string) || TIER_DEFAULTS[key].desc,
        models: t.models as TierConfig["models"],
        thinkingLevel: isValidThinkingLevel(t.thinkingLevel)
          ? (t.thinkingLevel as ThinkingLevel)
          : undefined,
      };
    }
  }
  return result as Record<TierKey, TierConfig>;
}

export function writeAllTiers(config: Record<TierKey, TierConfig>): void {
  updateSettings((s) => {
    const tierObj: Record<string, unknown> = {};
    for (const key of ["L0", "L1", "L2"] as TierKey[]) {
      const c = config[key];
      if (c && c.models.length > 0) {
        tierObj[key] = {
          label: c.label,
          desc: c.desc,
          models: c.models,
          ...(c.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}),
        };
      }
    }
    if (Object.keys(tierObj).length > 0) {
      s[KEY_TIERS] = tierObj;
    } else {
      delete s[KEY_TIERS];
    }
    return s;
  });
}

export function resolveTierModel(
  tier: TierKey,
  config: Record<TierKey, TierConfig>,
  registry: { find(p: string, m: string): unknown },
  currentProvider?: string,
): { provider: string; model: string } | null {
  const tc = config[tier];
  if (!tc || tc.models.length === 0) return null;

  if (currentProvider) {
    for (const m of tc.models) {
      if (m.provider === currentProvider && registry.find(m.provider, m.model)) return m;
    }
  }
  for (const m of tc.models) {
    if (registry.find(m.provider, m.model)) return m;
  }
  return null;
}

export function getCurrentTier(
  provider: string | undefined,
  modelId: string | undefined,
  config: Record<TierKey, TierConfig>,
): TierKey | null {
  if (!provider || !modelId) return null;
  for (const key of ["L0", "L1", "L2"] as TierKey[]) {
    if (config[key]?.models.some((m) => m.provider === provider && m.model === modelId)) return key;
  }
  return null;
}
