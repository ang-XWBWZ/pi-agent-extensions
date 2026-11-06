/**
 * types.ts — 模型切换类型 + 常量
 */

// ---- 思考等级 ----

export const VALID_THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
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
    off: "关", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
  };
  return m[level] ?? level;
}

// ---- 强制思考支持 ----

/**
 * 补齐模型的思考等级支持。
 *
 * pi 1.5 起 runtime 会深冻结模型定义（models.json 经 ModelConfig 载入后 Object.freeze），
 * 冻结对象上的赋值会抛 TypeError 并中断 session_start。这类 runtime 托管模型的
 * reasoning / thinkingLevelMap 只能由声明式配置决定（models.json 的 reasoning 与
 * thinkingLevelMap，或 registerProvider 注册时的模型定义），扩展不应也无法在运行时改写。
 *
 * @returns true = 模型可写且已补齐；false = 模型由 runtime 托管，未做任何修改。
 */
export function forceThinkingSupport(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const m = model as {
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  };
  if (Object.isFrozen(m)) return false;
  // 复制一份再整体赋值：原 map 也可能被冻结，且不污染 runtime 正在使用的对象。
  const map: Partial<Record<ThinkingLevel, string | null>> =
    m.thinkingLevelMap && typeof m.thinkingLevelMap === "object"
      ? { ...m.thinkingLevelMap }
      : { off: undefined };
  // 补齐 minimal..max：已有映射（含 provider 自定义值）保持不变，null / undefined 解除阻断
  for (const level of VALID_THINKING_LEVELS) {
    if (level === "off") continue;
    if (!map[level]) map[level] = level;
  }
  try {
    m.reasoning = true;
    m.thinkingLevelMap = map;
  } catch {
    return false; // 属性只读：同样交给 runtime 的声明式配置
  }
  return true;
}

/** @returns 实际被改写的模型数量（runtime 托管的冻结模型会被跳过）。 */
export function forceThinkingSupportAll(models: unknown[]): number {
  if (!Array.isArray(models)) return 0;
  let patched = 0;
  for (const m of models) {
    if (forceThinkingSupport(m)) patched += 1;
  }
  return patched;
}

