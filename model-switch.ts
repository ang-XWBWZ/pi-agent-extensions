/**
 * model-switch.ts — 模型切换 + 模型分级系统 v4.0
 *
 * 从零配置: 无配置=无分级，通过命令/工具动态搭建 L0/L1/L2。
 *
 * 命令:
 *   /tier-add <L0|L1|L2> <provider> <model> [--thinking <level>]  添加模型到层级
 *   /tier-remove <L0|L1|L2> [<provider> <model>]                  移除模型/清空层级
 *   /tier-set-thinking <L0|L1|L2> <off|...|xhigh>                 设置层级默认思考深度
 *   /tier-config                                                   查看当前层级配置
 *   /tier [L0|L1|L2]                                              切换模型层级（无参显示当前）
 *   /thinking [off|...|xhigh]                                     设置/查看思考深度
 *   /set-default <provider> <model>                                设置默认模型
 *   /set-default tier <L0|L1|L2>                                  设置默认层级
 *   /reset-default                                                 清除默认模型/层级
 *   /model-info                                                    查看当前模型/层级
 *
 * 工具:
 *   switch_model  列出/切换模型，tier 管理，思考深度设置
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 类型 ----

const VALID_THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;
type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

interface TierModel {
  provider: string;
  model: string;
}

interface TierConfig {
  label: string;
  desc: string;
  models: TierModel[];
  thinkingLevel?: ThinkingLevel;
}

type TierKey = "L0" | "L1" | "L2";

const TIER_DEFAULTS: Record<TierKey, { label: string; desc: string }> = {
  L0: { label: "快速", desc: "文件查找、代码地图、格式转换、简单查询" },
  L1: { label: "主要", desc: "编码、重构、调试、复杂分析" },
  L2: { label: "高级", desc: "架构设计、跨模块变更分析、安全审查" },
};

const KEY_PROVIDER = "defaultProvider";
const KEY_MODEL = "defaultModel";
const KEY_TIER = "defaultTier";
const KEY_TIERS = "modelTiers";

// ---- settings 读写 ----

function sp(): string {
  return path.join(process.env.USERPROFILE ?? ".", ".pi", "agent", "settings.json");
}

function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(sp(), "utf-8")); } catch { return {}; }
}

function writeSettingsRaw(data: Record<string, unknown>): void {
  fs.writeFileSync(sp(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---- 层级配置读写 ----

function readAllTiers(): Record<TierKey, TierConfig> {
  const s = readSettings();
  const tiers = s[KEY_TIERS] as Record<string, unknown> | undefined;
  if (!tiers || typeof tiers !== "object") return {} as Record<TierKey, TierConfig>;

  const result: Record<string, TierConfig> = {};
  for (const key of ["L0", "L1", "L2"] as TierKey[]) {
    const t = tiers[key] as Record<string, unknown> | undefined;
    if (t && typeof t === "object" && Array.isArray(t.models)) {
      result[key] = {
        label: (t.label as string) || TIER_DEFAULTS[key].label,
        desc: (t.desc as string) || TIER_DEFAULTS[key].desc,
        models: t.models as TierModel[],
        thinkingLevel: isValidThinkingLevel(t.thinkingLevel)
          ? (t.thinkingLevel as ThinkingLevel)
          : undefined,
      };
    }
  }
  return result as Record<TierKey, TierConfig>;
}

function writeAllTiers(config: Record<TierKey, TierConfig>): void {
  const s = readSettings();
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
  writeSettingsRaw(s);
}

function isValidThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && VALID_THINKING_LEVELS.includes(v as ThinkingLevel);
}

// ---- 默认模型/层级持久化 ----

function writeDefaults(provider: string | null, model: string | null, tier: string | null): void {
  const s = readSettings();
  if (provider && model) { s[KEY_PROVIDER] = provider; s[KEY_MODEL] = model; }
  else { delete s[KEY_PROVIDER]; delete s[KEY_MODEL]; }
  if (tier) { s[KEY_TIER] = tier; }
  else { delete s[KEY_TIER]; }
  writeSettingsRaw(s);
}

// ---- 层级解析 ----

function resolveTierModel(
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

function getCurrentTier(
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

function thinkingLabel(level: string): string {
  const m: Record<string, string> = {
    off: "关", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "最大",
  };
  return m[level] ?? level;
}

// ================================================================
//  扩展入口
// ================================================================

export default function (pi: ExtensionAPI) {
  let defaultRef: { provider: string; model: string } | null = null;
  let currentTier: TierKey | null = null;
  let tierConfig: Record<TierKey, TierConfig> = {};
  let currentThinking: string = "";

  function refreshConfig(): void {
    tierConfig = readAllTiers();
  }

  function statusLine(ctx: {
    model?: { provider: string; id: string };
    ui: { setStatus(k: string, v: unknown): void; theme: { fg(c: string, t: string): string } };
  }): void {
    if (!ctx?.model) return;
    const tier = currentTier ?? getCurrentTier(ctx.model.provider, ctx.model.id, tierConfig);
    const tierPart = tier ? `${tier} · ` : "";
    const think = currentThinking || pi.getThinkingLevel();
    const thinkPart = think && think !== "off" ? ` \u{1F9E0}${thinkingLabel(think)}` : "";
    ctx.ui.setStatus("default-model", ctx.ui.theme.fg("muted", `\u{1F539}${tierPart}${ctx.model.provider}/${ctx.model.id}${thinkPart}`));
  }

  function applyThinking(tier: TierKey): ThinkingLevel | undefined {
    const lvl = tierConfig[tier]?.thinkingLevel;
    if (lvl) { pi.setThinkingLevel(lvl); currentThinking = lvl; return lvl; }
    return undefined;
  }

  function setThinking(level: string): void {
    if (isValidThinkingLevel(level)) {
      pi.setThinkingLevel(level as ThinkingLevel);
      currentThinking = level;
    }
  }

  // ---- session_start ----
  pi.on("session_start", async (_e, ctx) => {
    refreshConfig();

    if (ctx.sessionManager.getBranch().some((e: { type: string }) => e.type === "model_change")) return;

    const s = readSettings();
    const p = s[KEY_PROVIDER] as string | undefined;
    const m = s[KEY_MODEL] as string | undefined;
    const tk = s[KEY_TIER] as string | undefined;

    const restoreConfiguredModel = async (): Promise<boolean> => {
      if (p && m) {
        const t = ctx.modelRegistry.find(p, m);
        if (t) {
          defaultRef = { provider: p, model: m };
          await pi.setModel(t);
          currentTier = getCurrentTier(p, m, tierConfig);
          if (currentTier) applyThinking(currentTier);
          statusLine(ctx);
          return true;
        }
      }
      if (tk && ["L0", "L1", "L2"].includes(tk)) {
        const r = resolveTierModel(tk as TierKey, tierConfig, ctx.modelRegistry);
        if (r) {
          const t = ctx.modelRegistry.find(r.provider, r.model);
          if (t) {
            await pi.setModel(t);
            currentTier = tk as TierKey;
            applyThinking(currentTier);
            statusLine(ctx);
            return true;
          }
        }
      }
      return false;
    };

    if (!(await restoreConfiguredModel())) {
      // Custom provider models may not be registered yet (provider-manager
      // runs session_start in parallel). Retry with backoff.
      for (const delay of [200, 500, 1000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (await restoreConfiguredModel()) break;
      }
    }
  });

  // ======================== /tier ========================
  pi.registerCommand("tier", {
    description: "切换层级: /tier [L0|L1|L2]。无参显示当前。",
    handler: async (args, ctx) => {
      const input = args.trim().toUpperCase();
      if (!input) {
        const tier = currentTier ?? getCurrentTier(ctx.model?.provider, ctx.model?.id, tierConfig);
        if (tier) {
          const c = tierConfig[tier];
          const info = c?.thinkingLevel ? ` | 默认思考: ${c.thinkingLevel}(${thinkingLabel(c.thinkingLevel)})` : "";
          ctx.ui.notify(`当前层级: ${tier} · ${c?.label ?? TIER_DEFAULTS[tier].label} - ${c?.desc ?? TIER_DEFAULTS[tier].desc}${info}\n当前思考: ${currentThinking || pi.getThinkingLevel()}(${thinkingLabel(currentThinking || pi.getThinkingLevel())})`, "info");
        } else {
          ctx.ui.notify(`当前模型: ${ctx.model?.provider}/${ctx.model?.id}\n当前思考: ${currentThinking || pi.getThinkingLevel()}(${thinkingLabel(currentThinking || pi.getThinkingLevel())})\n未配置层级`, "info");
        }
        return;
      }
      if (!["L0", "L1", "L2"].includes(input)) {
        ctx.ui.notify("用法: /tier L0|L1|L2", "error");
        return;
      }
      const tier = input as TierKey;
      const config = readAllTiers();
      if (!config[tier] || config[tier].models.length === 0) {
        ctx.ui.notify(`层级 ${tier} 未配置。使用 /tier-add`, "error");
        return;
      }
      const r = resolveTierModel(tier, config, ctx.modelRegistry, ctx.model?.provider);
      if (!r) { ctx.ui.notify(`层级 ${tier} 模型不可用`, "error"); return; }
      const t = ctx.modelRegistry.find(r.provider, r.model);
      if (!t) { ctx.ui.notify(`${r.provider}/${r.model} 不存在`, "error"); return; }
      const ok = await pi.setModel(t);
      if (ok) { currentTier = tier; tierConfig = config; applyThinking(tier); statusLine(ctx); }
      const think = config[tier]?.thinkingLevel;
      ctx.ui.notify(ok ? `\u2705 ${tier} · ${config[tier].label}: ${r.provider}/${r.model}${think ? ` | \u{1F9E0} ${think}(${thinkingLabel(think)})` : ""}` : "切换失败", ok ? "info" : "warning");
    },
  });

  // ======================== /tier-add ========================
  pi.registerCommand("tier-add", {
    description: "添加模型到层级: /tier-add <L0|L1|L2> <provider> <model> [--thinking <level>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) {
        ctx.ui.notify("用法: /tier-add <L0|L1|L2> <provider> <model> [--thinking off|...|xhigh]", "error");
        return;
      }
      const tier = parts[0].toUpperCase();
      if (!["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("层级必须是 L0/L1/L2", "error"); return; }

      let thinkIdx = parts.indexOf("--thinking");
      if (thinkIdx === -1) thinkIdx = parts.indexOf("-t");
      const modelEnd = thinkIdx > 0 ? thinkIdx : parts.length;

      const provider = parts[1];
      const model = parts.slice(2, modelEnd).join(" ");
      if (!provider || !model) { ctx.ui.notify("需要 provider 和 model", "error"); return; }

      let thinking: string | undefined;
      if (thinkIdx > 0 && thinkIdx + 1 < parts.length) {
        const t = parts[thinkIdx + 1];
        if (isValidThinkingLevel(t)) thinking = t;
        else { ctx.ui.notify(`无效思考等级: ${t}。支持: ${VALID_THINKING_LEVELS.join(" | ")}`, "error"); return; }
      }

      const target = ctx.modelRegistry.find(provider, model);
      if (!target) { ctx.ui.notify(`模型不存在: ${provider}/${model}`, "error"); return; }

      const config = readAllTiers();
      const tc = config[tier as TierKey] ?? { label: TIER_DEFAULTS[tier as TierKey].label, desc: TIER_DEFAULTS[tier as TierKey].desc, models: [] };
      if (tc.models.some((m: TierModel) => m.provider === provider && m.model === model)) {
        ctx.ui.notify(`${provider}/${model} 已在 ${tier} 中`, "warning");
      } else {
        tc.models.push({ provider, model });
      }
      if (thinking) tc.thinkingLevel = thinking as ThinkingLevel;
      config[tier as TierKey] = tc;
      writeAllTiers(config);
      tierConfig = config;
      ctx.ui.notify(`\u2705 ${tier} + ${provider}/${model}${thinking ? ` | \u{1F9E0} ${thinking}` : ""}`, "info");
    },
  });

  // ======================== /tier-remove ========================
  pi.registerCommand("tier-remove", {
    description: "移除层级模型: /tier-remove <L0|L1|L2> [<provider> <model>]（不指定则清空）",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 1) { ctx.ui.notify("用法: /tier-remove <L0|L1|L2> [<provider> <model>]", "error"); return; }
      const tier = parts[0].toUpperCase();
      if (!["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("层级必须是 L0/L1/L2", "error"); return; }

      const config = readAllTiers();
      if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) {
        ctx.ui.notify(`层级 ${tier} 为空`, "info"); return;
      }

      if (parts.length >= 3) {
        const provider = parts[1];
        const model = parts.slice(2).join(" ");
        const before = config[tier as TierKey].models.length;
        config[tier as TierKey].models = config[tier as TierKey].models.filter(
          (m: TierModel) => !(m.provider === provider && m.model === model),
        );
        if (config[tier as TierKey].models.length === before) {
          ctx.ui.notify(`${provider}/${model} 不在 ${tier} 中`, "warning"); return;
        }
        ctx.ui.notify(`\u2705 从 ${tier} 移除 ${provider}/${model}`, "info");
      } else {
        delete config[tier as TierKey];
        ctx.ui.notify(`\u2705 ${tier} 已清空`, "info");
      }

      writeAllTiers(config);
      tierConfig = config;
    },
  });

  // ======================== /tier-set-thinking ========================
  pi.registerCommand("tier-set-thinking", {
    description: "设置层级默认思考: /tier-set-thinking <L0|L1|L2> <off|...|xhigh>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) { ctx.ui.notify("用法: /tier-set-thinking <L0|L1|L2> <off|...|xhigh>", "error"); return; }
      const tier = parts[0].toUpperCase();
      if (!["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("层级必须是 L0/L1/L2", "error"); return; }
      if (!isValidThinkingLevel(parts[1])) { ctx.ui.notify(`无效等级: ${parts[1]}`, "error"); return; }

      const config = readAllTiers();
      if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) {
        ctx.ui.notify(`层级 ${tier} 为空，先 /tier-add`, "error"); return;
      }
      config[tier as TierKey].thinkingLevel = parts[1] as ThinkingLevel;
      writeAllTiers(config);
      tierConfig = config;
      ctx.ui.notify(`\u2705 ${tier} 默认思考: ${parts[1]}(${thinkingLabel(parts[1])})`, "info");
    },
  });

  // ======================== /tier-config ========================
  pi.registerCommand("tier-config", {
    description: "查看当前层级配置",
    handler: async (_a, ctx) => {
      const config = readAllTiers();
      const lines: string[] = [];
      for (const t of ["L0", "L1", "L2"] as TierKey[]) {
        const c = config[t];
        if (c && c.models.length > 0) {
          const think = c.thinkingLevel ? ` [\u{1F9E0}${c.thinkingLevel}]` : "";
          lines.push(`${t} · ${c.label}${think}`);
          for (const m of c.models) lines.push(`  - ${m.provider}/${m.model}`);
        } else {
          lines.push(`${t} · (未配置)`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ======================== /thinking ========================
  pi.registerCommand("thinking", {
    description: "设置/查看思考深度: /thinking [off|...|xhigh]",
    handler: async (args, ctx) => {
      const input = args.trim().toLowerCase();
      if (!input) {
        const cur = currentThinking || pi.getThinkingLevel();
        ctx.ui.notify(`当前思考深度: ${cur}(${thinkingLabel(cur)})`, "info");
        return;
      }
      if (!isValidThinkingLevel(input)) {
        ctx.ui.notify(`无效。支持: ${VALID_THINKING_LEVELS.join(" | ")}`, "error");
        return;
      }
      setThinking(input);
      statusLine(ctx);
      ctx.ui.notify(`\u2705 思考深度: ${input}(${thinkingLabel(input)})`, "info");
    },
  });

  // ======================== /set-default ========================
  pi.registerCommand("set-default", {
    description: "设置默认模型/层级: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0]?.toLowerCase() === "tier") {
        const tier = parts[1]?.toUpperCase();
        if (!tier || !["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("用法: /set-default tier <L0|L1|L2>", "error"); return; }
        writeDefaults(null, null, tier);
        defaultRef = null;
        const config = readAllTiers();
        const r = resolveTierModel(tier as TierKey, config, ctx.modelRegistry, ctx.model?.provider);
        if (r) { const t = ctx.modelRegistry.find(r.provider, r.model); if (t) { await pi.setModel(t); currentTier = tier as TierKey; tierConfig = config; applyThinking(currentTier); } }
        statusLine(ctx);
        ctx.ui.notify(`\u2705 默认层级: ${tier}`, "info");
        return;
      }
      if (parts.length < 2) { ctx.ui.notify("用法: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>", "error"); return; }
      const p = parts[0]; const m = parts.slice(1).join(" ");
      const t = ctx.modelRegistry.find(p, m);
      if (!t) { ctx.ui.notify(`模型不存在: ${p}/${m}`, "error"); return; }
      writeDefaults(p, m, null);
      defaultRef = { provider: p, model: m };
      await pi.setModel(t);
      currentTier = getCurrentTier(p, m, tierConfig);
      statusLine(ctx);
      ctx.ui.notify(`\u2705 默认: ${p}/${m}`, "info");
    },
  });

  // ======================== /reset-default ========================
  pi.registerCommand("reset-default", {
    description: "清除默认模型/层级",
    handler: async (_a, ctx) => {
      writeDefaults(null, null, null);
      defaultRef = null; currentTier = null;
      ctx.ui.setStatus("default-model", undefined);
      ctx.ui.notify("\u2705 已清除", "info");
    },
  });

  // ======================== /model-info ========================
  pi.registerCommand("model-info", {
    description: "查看当前模型/层级/思考",
    handler: async (_a, ctx) => {
      const cur = ctx.model;
      const tier = currentTier ?? getCurrentTier(cur?.provider, cur?.id, tierConfig);
      const think = currentThinking || pi.getThinkingLevel();
      const s = readSettings();
      const def = s[KEY_PROVIDER] ? `${s[KEY_PROVIDER]}/${s[KEY_MODEL]}` : undefined;
      const defTier = s[KEY_TIER] as string | undefined;
      ctx.ui.notify(
        `当前: ${cur?.provider}/${cur?.id}${tier ? ` (${tier})` : ""} | \u{1F9E0} ${think}(${thinkingLabel(think)})` +
        (def ? ` | 默认: ${def}` : "") + (defTier ? ` | 默认层级: ${defTier}` : ""),
        "info",
      );
    },
  });

  // ======================== switch_model 工具 ========================
  pi.registerTool({
    name: "switch_model",
    label: "Switch Model",
    description: "切换模型、查看模型列表、管理模型层级和思考深度。",
    promptSnippet: "List/switch models; manage tier config; set thinking level",
    promptGuidelines: [
      "Without args: list models grouped by configured tiers.",
      "With provider+model: switch to that model.",
      "With tier: switch to tier's model + thinking level.",
      "With action: manage tier config.",
      "  add_to_tier / remove_from_tier / set_tier_thinking / show_tier_config: manage model tiers.",
      "With thinkingLevel alone: set main thinking level.",
      "Tiers must be configured first via action=add_to_tier.",
      "Use manage_providers for custom provider registration/removal/listing.",
    ],
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "模型 provider" })),
      model: Type.Optional(Type.String({ description: "模型 ID" })),
      tier: Type.Optional(Type.String({ description: "L0|L1|L2" })),
      action: Type.Optional(Type.String({ description: "add_to_tier|remove_from_tier|set_tier_thinking|show_tier_config" })),
      thinkingLevel: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      // action
      if (params.action) {
        const config = readAllTiers();
        switch (params.action) {
          case "show_tier_config": {
            const lines: string[] = [];
            for (const t of ["L0", "L1", "L2"] as TierKey[]) {
              const c = config[t];
              if (c && c.models.length > 0) {
                const think = c.thinkingLevel ? ` [\u{1F9E0}${c.thinkingLevel}]` : "";
                lines.push(`${t} · ${c.label}${think}`);
                for (const m of c.models) lines.push(`  - ${m.provider}/${m.model}`);
              } else { lines.push(`${t} · (未配置)`); }
            }
            return { content: [{ type: "text", text: lines.join("\n") || "未配置" }], details: {} };
          }
          case "add_to_tier": {
            const tier = params.tier?.toUpperCase();
            if (!tier || !["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: "需要 tier" }], details: {} };
            if (!params.provider || !params.model) return { content: [{ type: "text", text: "需要 provider+model" }], details: {} };
            if (!ctx.modelRegistry.find(params.provider, params.model)) return { content: [{ type: "text", text: `模型不存在` }], details: {} };
            const tc = config[tier as TierKey] ?? { label: TIER_DEFAULTS[tier as TierKey].label, desc: TIER_DEFAULTS[tier as TierKey].desc, models: [] };
            if (!tc.models.some((m: TierModel) => m.provider === params.provider && m.model === params.model)) {
              tc.models.push({ provider: params.provider!, model: params.model! });
            }
            if (params.thinkingLevel && isValidThinkingLevel(params.thinkingLevel)) tc.thinkingLevel = params.thinkingLevel as ThinkingLevel;
            config[tier as TierKey] = tc;
            writeAllTiers(config); tierConfig = config;
            return { content: [{ type: "text", text: `\u2705 ${tier} + ${params.provider}/${params.model}${params.thinkingLevel ? ` | \u{1F9E0} ${params.thinkingLevel}` : ""}` }], details: {} };
          }
          case "remove_from_tier": {
            const tier = params.tier?.toUpperCase();
            if (!tier || !["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: "需要 tier" }], details: {} };
            if (!config[tier as TierKey]) return { content: [{ type: "text", text: `${tier} 为空` }], details: {} };
            if (params.provider && params.model) {
              config[tier as TierKey].models = config[tier as TierKey].models.filter(
                (m: TierModel) => !(m.provider === params.provider && m.model === params.model),
              );
            } else { delete config[tier as TierKey]; }
            writeAllTiers(config); tierConfig = config;
            return { content: [{ type: "text", text: params.provider ? `\u2705 移除 ${params.provider}/${params.model}` : `\u2705 ${tier} 已清空` }], details: {} };
          }
          case "set_tier_thinking": {
            const tier = params.tier?.toUpperCase();
            if (!tier || !["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: "需要 tier" }], details: {} };
            if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) return { content: [{ type: "text", text: `${tier} 为空` }], details: {} };
            if (!params.thinkingLevel || !isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: "需要 thinkingLevel" }], details: {} };
            config[tier as TierKey].thinkingLevel = params.thinkingLevel as ThinkingLevel;
            writeAllTiers(config); tierConfig = config;
            return { content: [{ type: "text", text: `\u2705 ${tier} \u{1F9E0} ${params.thinkingLevel}` }], details: {} };
          }
          default: return { content: [{ type: "text", text: `未知 action: ${params.action}` }], details: {} };
        }
      }

      // standalone thinking
      if (params.thinkingLevel && !params.tier && !params.provider) {
        if (!isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: `无效` }], details: {} };
        setThinking(params.thinkingLevel);
        return { content: [{ type: "text", text: `\u2705 \u{1F9E0} ${params.thinkingLevel}(${thinkingLabel(params.thinkingLevel)})` }], details: {} };
      }

      // tier switch
      if (params.tier) {
        const tier = params.tier.toUpperCase();
        if (!["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: `无效层级` }], details: {} };
        const config = readAllTiers();
        if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) return { content: [{ type: "text", text: `${tier} 未配置` }], details: {} };
        const r = resolveTierModel(tier as TierKey, config, ctx.modelRegistry, ctx.model?.provider);
        if (!r) return { content: [{ type: "text", text: `模型不可用` }], details: {} };
        const t = ctx.modelRegistry.find(r.provider, r.model);
        if (!t) return { content: [{ type: "text", text: `不存在` }], details: {} };
        const ok = await pi.setModel(t);
        if (ok) { currentTier = tier as TierKey; tierConfig = config; applyThinking(currentTier); }
        const think = config[tier as TierKey]?.thinkingLevel;
        return { content: [{ type: "text", text: ok ? `\u2705 ${tier} · ${config[tier as TierKey].label}: ${r.provider}/${r.model}${think ? ` | \u{1F9E0} ${think}(${thinkingLabel(think)})` : ""}` : "失败" }], details: {} };
      }

      // provider+model
      if (params.provider && params.model) {
        const t = ctx.modelRegistry.find(params.provider, params.model);
        if (!t) return { content: [{ type: "text", text: `Model not found` }], details: {} };
        const ok = await pi.setModel(t);
        if (ok) {
          currentTier = getCurrentTier(params.provider, params.model, tierConfig);
          // 自动应用层级默认思考深度
          if (currentTier) applyThinking(currentTier);
        }
        return { content: [{ type: "text", text: ok ? `Switched to ${params.provider}/${params.model}` : "Failed" }], details: {} };
      }

      // list
      const config = readAllTiers();
      const all = await ctx.modelRegistry.getAvailable();
      const cur = ctx.model;
      const curTier = currentTier ?? getCurrentTier(cur?.provider, cur?.id, config);
      const think = currentThinking || pi.getThinkingLevel();
      const lines: string[] = [];
      lines.push(`\u{1F9E0} 当前思考: ${think}(${thinkingLabel(think)})`);
      lines.push("");

      const hasConfig = Object.values(config).some((c: TierConfig) => c.models.length > 0);

      if (hasConfig) {
        for (const t of ["L0", "L1", "L2"] as TierKey[]) {
          const c = config[t];
          if (!c || c.models.length === 0) { lines.push(`${t} · (未配置)`); continue; }
          const tierModels = all.filter((m: { provider: string; id: string }) =>
            c.models.some((tm: TierModel) => tm.provider === m.provider && tm.model === m.id),
          );
          const isCur = curTier === t;
          const thinkInfo = c.thinkingLevel ? ` [\u{1F9E0}${c.thinkingLevel}]` : "";
          lines.push(`${t} · ${c.label}${thinkInfo}${isCur ? " ◀ 当前层级" : ""}`);
          lines.push(`  ${c.desc}`);
          for (const m of tierModels) {
            const id = `${m.provider}/${m.id}`;
            const isCurM = cur?.provider === m.provider && cur?.id === m.id;
            const isDef = defaultRef?.provider === m.provider && defaultRef?.model === m.id;
            const tags: string[] = [];
            if (isCurM) tags.push("current");
            if (isDef) tags.push("default");
            if ((m as { reasoning?: boolean }).reasoning) tags.push("thinking");
            lines.push(`  ${isCurM ? "\u2192" : " "} ${id}${tags.length ? " [" + tags.join(" ") + "]" : ""}`);
          }
        }
      }

      const used = new Set<string>();
      for (const c of Object.values(config)) { for (const m of (c as TierConfig).models) used.add(`${m.provider}/${m.model}`); }
      const unassigned = all.filter((m: { provider: string; id: string }) => !used.has(`${m.provider}/${m.id}`));
      if (unassigned.length > 0) {
        lines.push("");
        lines.push(hasConfig ? "\u{1F4CB} 未分级" : "\u{1F4CB} 所有模型 (使用 /tier-add 搭建)");
        for (const m of unassigned) {
          const id = `${m.provider}/${m.id}`;
          const isCur = cur?.provider === m.provider && cur?.id === m.id;
          const tags: string[] = [];
          if (isCur) tags.push("current");
          if ((m as { reasoning?: boolean }).reasoning) tags.push("thinking");
          lines.push(`  ${isCur ? "\u2192" : " "} ${id}${tags.length ? " [" + tags.join(" ") + "]" : ""}`);
        }
      }

      return { content: [{ type: "text", text: `可用模型:\n\n${lines.join("\n")}\n\n当前: ${cur?.provider}/${cur?.id}${curTier ? ` (${curTier})` : ""}` }], details: {} };
    },
  });
}
