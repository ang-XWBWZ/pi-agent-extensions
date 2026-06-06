/**
 * tier-resolver.ts — 模型层级解析 + Skill/Tool 配置加载
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SubTask } from "../../lib/agent-bus.js";

// ---- 常量 ----

export const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

// ---- settings 路径 ----

export function settingsPath(): string {
  return join(
    process.env.USERPROFILE ?? ".",
    ".pi",
    "agent",
    "settings.json",
  );
}

// ---- 强制思考支持 ----

export function forceThinkingSupport(model: unknown): void {
  if (!model || typeof model !== "object") return;
  const m = model as {
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null | undefined>;
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

// ---- Skill 配置 ----

export interface SkillConfig {
  blacklist: string[];
}

export function loadSkillConfig(): SkillConfig {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const section = raw.skills as Record<string, unknown> | undefined;
    if (!section || typeof section !== "object") return { blacklist: [] };
    return {
      blacklist: Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [],
    };
  } catch {
    return { blacklist: [] };
  }
}

// ---- Tool 配置 ----

export function loadToolConfig(): string[] {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const section = raw.tools as Record<string, unknown> | undefined;
    if (!section || typeof section !== "object") return [];
    const bl = section.blacklist;
    if (!Array.isArray(bl)) return [];
    return bl.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

// ---- Task 层级解析 ----

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

  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const tiers = raw.modelTiers as Record<string, unknown> | undefined;
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
  } catch {
    return null;
  }
}
