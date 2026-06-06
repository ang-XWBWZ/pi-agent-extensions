/**
 * types.ts — 模型切换类型 + 常量
 */

// ---- 思考等级 ----

export const VALID_THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;
export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export function isValidThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && VALID_THINKING_LEVELS.includes(v as ThinkingLevel);
}

// ---- 层级类型 ----

export interface TierModel {
  provider: string;
  model: string;
}

export interface TierConfig {
  label: string;
  desc: string;
  models: TierModel[];
  thinkingLevel?: ThinkingLevel;
}

export type TierKey = "L0" | "L1" | "L2";

export const TIER_DEFAULTS: Record<TierKey, { label: string; desc: string }> = {
  L0: { label: "快速", desc: "文件查找、代码地图、格式转换、简单查询" },
  L1: { label: "主要", desc: "编码、重构、调试、复杂分析" },
  L2: { label: "高级", desc: "架构设计、跨模块变更分析、安全审查" },
};

// ---- settings key 常量 ----

export const KEY_PROVIDER = "defaultProvider";
export const KEY_MODEL = "defaultModel";
export const KEY_TIER = "defaultTier";
export const KEY_TIERS = "modelTiers";

// ---- 思考标签 ----

export function thinkingLabel(level: string): string {
  const m: Record<string, string> = {
    off: "关", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "最大",
  };
  return m[level] ?? level;
}

// ---- 强制思考支持 ----

export function forceThinkingSupport(model: unknown): void {
  if (!model || typeof model !== "object") return;
  const m = model as {
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  };
  m.reasoning = true;
  m.thinkingLevelMap = {
    ...m.thinkingLevelMap,
    off: m.thinkingLevelMap?.off ?? undefined,
    minimal: m.thinkingLevelMap?.minimal ?? "minimal",
    low: m.thinkingLevelMap?.low ?? "low",
    medium: m.thinkingLevelMap?.medium ?? "medium",
    high: m.thinkingLevelMap?.high ?? "high",
    xhigh: m.thinkingLevelMap?.xhigh ?? "xhigh",
  };
}
