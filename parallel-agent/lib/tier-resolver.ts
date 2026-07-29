/**
 * tier-resolver.ts — 模型层级解析 + Skill/Tool 配置加载
 *
 * 自 v2 使用共享 settings-io 单例读配置，不再直接读磁盘。
 */

import type { SubTask } from "../../lib/agent-bus.js";
import {
  getSettings,
  getSettingsSection,
} from "../../lib/settings-io.js";

// ---- 常量 ----

export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

// ---- 强制思考支持（与 model-switch/lib/types.ts 保持一致） ----

export function forceThinkingSupport(model: unknown): void {
  if (!model || typeof model !== "object") return;
  const m = model as {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null | undefined>;
  };
  const hasReasoning = m.reasoning === true;
  m.thinkingLevelMap = {
    off: undefined,
    minimal: hasReasoning ? (m.thinkingLevelMap?.minimal ?? "minimal") : undefined,
    low: hasReasoning ? (m.thinkingLevelMap?.low ?? "low") : undefined,
    medium: hasReasoning ? (m.thinkingLevelMap?.medium ?? "medium") : undefined,
    high: hasReasoning ? (m.thinkingLevelMap?.high ?? "high") : undefined,
    xhigh: hasReasoning ? (m.thinkingLevelMap?.xhigh ?? "xhigh") : undefined,
  };
}

// ---- Skill 配置（通过共享缓存，不读磁盘） ----

export interface SkillConfig {
  blacklist: string[];
}

export function loadSkillConfig(): SkillConfig {
  const section = getSettingsSection<Record<string, unknown> | undefined>("skills", undefined);
  if (!section || typeof section !== "object") return { blacklist: [] };
  return {
    blacklist: Array.isArray(section.blacklist)
      ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
      : [],
  };
}

// ---- Tool 配置（通过共享缓存） ----

export function loadToolConfig(): string[] {
  const section = getSettingsSection<Record<string, unknown> | undefined>("tools", undefined);
  if (!section || typeof section !== "object") return [];
  const bl = section.blacklist;
  if (!Array.isArray(bl)) return [];
  return bl.filter((s): s is string => typeof s === "string");
}

// ---- Task 层级解析（通过共享缓存） ----

export interface TaskResolvedConfig {
  model: string;
  thinkingLevel?: string;
}

/** 从 task.tier 解析模型+思考深度（优先级：task.model > tier > 默认） */
export function resolveTaskConfig(
  task: SubTask & { tier?: string; thinkingLevel?: string },
): TaskResolvedConfig | null {
  const tier = task.tier?.toUpperCase();
  if (!tier || !["L0", "L1", "L2"].includes(tier)) return null;

  const s = getSettings();
  const tiers = s.modelTiers as Record<string, unknown> | undefined;
  if (!tiers || typeof tiers !== "object") return null;

  const cfg = tiers[tier] as Record<string, unknown> | undefined;
  if (!cfg || !Array.isArray(cfg.models) || cfg.models.length === 0)
    return null;

  const firstModel = cfg.models[0] as {
    provider: string;
    model: string;
  };
  const model = `${firstModel.provider}/${firstModel.model}`;

  const rawThink =
    (task.thinkingLevel as string) ?? (cfg.thinkingLevel as string);
  if (
    rawThink &&
    VALID_THINKING_LEVELS.includes(
      rawThink as (typeof VALID_THINKING_LEVELS)[number],
    )
  ) {
    return { model, thinkingLevel: rawThink };
  }
  return { model };
}
