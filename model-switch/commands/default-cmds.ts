/**
 * default-cmds.ts — /set-default, /reset-default, /model-info, /thinking
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TierKey, TierConfig, ThinkingLevel } from "../lib/types.js";
import { KEY_PROVIDER, KEY_MODEL, KEY_TIER, isValidThinkingLevel, VALID_THINKING_LEVELS, thinkingLabel, forceThinkingSupport, TIER_DEFAULTS } from "../lib/types.js";
import { readAllTiers, writeAllTiers, resolveTierModel, getCurrentTier } from "../lib/tier-config.js";
import { getSettings, updateSettings, readSettings, writeSettingsRaw } from "../../lib/settings-io.js";

function writeDefaults(provider: string | null, model: string | null, tier: string | null): void {
  updateSettings((s) => {
    if (provider && model) { s[KEY_PROVIDER] = provider; s[KEY_MODEL] = model; }
    else { delete s[KEY_PROVIDER]; delete s[KEY_MODEL]; }
    if (tier) { s[KEY_TIER] = tier; }
    else { delete s[KEY_TIER]; }
    return s;
  });
}

export function registerDefaultCmds(
  pi: ExtensionAPI,
  getState: () => { currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string; defaultRef: { provider: string; model: string } | null },
  setState: (s: Partial<{ currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string; defaultRef: { provider: string; model: string } | null }>) => void,
  applyThinking: (tier: TierKey, model?: unknown) => ThinkingLevel | undefined,
  statusLine: (ctx: any) => void,
  setThinking: (level: string, model?: unknown) => void,
): void {

  const thinkingHandler = async (args: string, ctx: any) => {
    const { currentThinking, tierConfig, currentTier } = getState();
    const input = args.trim().toLowerCase();

    // 快捷方式：如果用户在命令行提供了参数（如 /thinklev max 或 /thinklive high）
    if (input) {
      if (!isValidThinkingLevel(input)) {
        ctx.ui.notify(`无效思考等级: ${input}。支持等级: ${VALID_THINKING_LEVELS.join(" | ")}`, "error");
        return;
      }
      if (ctx.model) {
        forceThinkingSupport(ctx.model);
      }
      setThinking(input, ctx.model);

      // 持久化保存至 settings.json（同时更新当前模型专属配置与全局默认）
      updateSettings((s) => {
        s.defaultThinkingLevel = input;
        if (ctx.model) {
          if (!s.modelThinkingLevels || typeof s.modelThinkingLevels !== "object") {
            s.modelThinkingLevels = {};
          }
          (s.modelThinkingLevels as Record<string, string>)[`${ctx.model.provider}/${ctx.model.id}`] = input;
        }
        return s;
      });

      statusLine(ctx);
      const modelTag = ctx.model ? ` [${ctx.model.provider}/${ctx.model.id}]` : "";
      ctx.ui.notify(`思考深度已设为: ${input} (${thinkingLabel(input)})${modelTag}，并已永久保存至配置`, "info");
      return;
    }

    const cur = pi.getThinkingLevel?.() || currentThinking || "off";
    const curModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择模型";
    const s = getSettings();
    const def = (s.defaultThinkingLevel as string) || "未设置";
    const modelSpecific = ctx.model ? (s.modelThinkingLevels as Record<string, string>)?.[curModel] : undefined;

    // 无参数模式：如果不在交互式 UI 环境，直接展示当前状态
    if (!ctx.ui?.select) {
      ctx.ui.notify(`当前思考深度: ${cur} (${thinkingLabel(cur)})。用法: /thinklev [${VALID_THINKING_LEVELS.join("|")}]`, "info");
      return;
    }

    // 一级菜单：操作目标与生效范围
    const optModel = `1. 绑定并保存为当前模型专属配置 (${curModel}${modelSpecific ? `，已存: ${modelSpecific}` : ""})`;
    const optDefault = `2. 保存为全局默认思考深度 (当前: ${def})`;
    const optTier = `3. 配置分层模型思考深度 (L0 / L1 / L2)`;
    const optTemp = `4. 仅调整当前会话思考深度 (临时生效，不保存至磁盘)`;
    const optCancel = `5. 取消`;

    const menuTitle = `思考深度配置 [当前模型: ${curModel} | 当前深度: ${cur}(${thinkingLabel(cur)}) | 全局默认: ${def}]`;
    const choice = await ctx.ui.select(menuTitle, [optModel, optDefault, optTier, optTemp, optCancel]);

    if (!choice || choice === optCancel) return;

    // 二级菜单辅助函数：选择 7 档原生思考深度
    const selectLevel = async (promptTitle: string, preselect?: string): Promise<ThinkingLevel | null> => {
      const levelDescriptions: Record<ThinkingLevel, string> = {
        off: "关闭思考 / 仅基础文本输出",
        minimal: "极简思考 / ~1k tokens",
        low: "低思考 / ~2k tokens",
        medium: "中等思考 / ~8k tokens",
        high: "高思考 / ~16k tokens",
        xhigh: "极高思考 / ~32k tokens",
        max: "最大思考 / 完整深度推理",
      };

      const levelOptions = VALID_THINKING_LEVELS.map((lvl) => {
        const isCur = lvl === preselect ? " [当前]" : "";
        return `${lvl} (${thinkingLabel(lvl)} - ${levelDescriptions[lvl]})${isCur}`;
      });

      const sel = await ctx.ui.select(promptTitle, levelOptions);
      if (!sel) return null;
      const token = sel.split(" ")[0] as ThinkingLevel;
      return isValidThinkingLevel(token) ? token : null;
    };

    // 选项 1: 当前模型专属配置
    if (choice === optModel) {
      if (!ctx.model) {
        ctx.ui.notify("当前未加载模型，无法绑定模型专属配置", "error");
        return;
      }
      const lvl = await selectLevel(`请为当前模型 [${curModel}] 选择专属思考深度 (当前: ${cur})`, cur);
      if (!lvl) return;

      forceThinkingSupport(ctx.model);
      setThinking(lvl, ctx.model);
      updateSettings((settings) => {
        if (!settings.modelThinkingLevels || typeof settings.modelThinkingLevels !== "object") {
          settings.modelThinkingLevels = {};
        }
        (settings.modelThinkingLevels as Record<string, string>)[curModel] = lvl;
        return settings;
      });
      statusLine(ctx);
      ctx.ui.notify(`模型 [${curModel}] 思考深度已设为: ${lvl} (${thinkingLabel(lvl)})，已永久保存至配置`, "info");
      return;
    }

    // 选项 2: 全局默认思考深度
    if (choice === optDefault) {
      const lvl = await selectLevel(`请选择全局默认思考深度 (当前默认: ${def})`, def);
      if (!lvl) return;

      if (ctx.model) forceThinkingSupport(ctx.model);
      setThinking(lvl, ctx.model);
      updateSettings((settings) => {
        settings.defaultThinkingLevel = lvl;
        return settings;
      });
      statusLine(ctx);
      ctx.ui.notify(`全局默认思考深度已设为: ${lvl} (${thinkingLabel(lvl)})，已永久保存至配置`, "info");
      return;
    }

    // 选项 3: 分层模型配置
    if (choice === optTier) {
      const config = readAllTiers();
      const t0Desc = `L0 (${TIER_DEFAULTS.L0.label}: ${config.L0?.models?.length ?? 0}个模型) - 当前思考: ${config.L0?.thinkingLevel ?? "未设"}`;
      const t1Desc = `L1 (${TIER_DEFAULTS.L1.label}: ${config.L1?.models?.length ?? 0}个模型) - 当前思考: ${config.L1?.thinkingLevel ?? "未设"}`;
      const t2Desc = `L2 (${TIER_DEFAULTS.L2.label}: ${config.L2?.models?.length ?? 0}个模型) - 当前思考: ${config.L2?.thinkingLevel ?? "未设"}`;

      const tierChoice = await ctx.ui.select("请选择需要配置思考深度的分层 (Tier)", [t0Desc, t1Desc, t2Desc, "取消"]);
      if (!tierChoice || tierChoice === "取消") return;

      const targetTier = tierChoice.startsWith("L0") ? "L0" : tierChoice.startsWith("L1") ? "L1" : "L2";
      const currentTierLevel = config[targetTier as TierKey]?.thinkingLevel;

      const lvl = await selectLevel(`请为分层 [${targetTier}] 选择默认思考深度 (当前: ${currentTierLevel ?? "未设"})`, currentTierLevel);
      if (!lvl) return;

      const tc = config[targetTier as TierKey] ?? {
        label: TIER_DEFAULTS[targetTier as TierKey].label,
        desc: TIER_DEFAULTS[targetTier as TierKey].desc,
        models: [],
      };
      tc.thinkingLevel = lvl;
      config[targetTier as TierKey] = tc;
      writeAllTiers(config);
      setState({ tierConfig: config });

      // 如果当前模型正好属于该分层，立即生效
      const activeTier = currentTier ?? (ctx.model ? getCurrentTier(ctx.model.provider, ctx.model.id, config) : null);
      if (activeTier === targetTier && ctx.model) {
        applyThinking(targetTier as TierKey, ctx.model);
      }
      statusLine(ctx);
      ctx.ui.notify(`分层 [${targetTier}] 默认思考深度已设为: ${lvl} (${thinkingLabel(lvl)})，已永久保存至配置`, "info");
      return;
    }

    // 选项 4: 临时调整当前会话
    if (choice === optTemp) {
      const lvl = await selectLevel(`请选择思考深度 (仅当前会话临时生效，重启或切模型后失效)`, cur);
      if (!lvl) return;

      if (ctx.model) forceThinkingSupport(ctx.model);
      setThinking(lvl, ctx.model);
      statusLine(ctx);
      ctx.ui.notify(`思考深度已临时调整为: ${lvl} (${thinkingLabel(lvl)}) (未保存至磁盘)`, "info");
      return;
    }
  };

  pi.registerCommand("thinking-level", {
    description: "设置/查看思考深度: /thinking-level [off|...|xhigh|max] (无参弹出二级选项菜单)",
    handler: thinkingHandler,
  });

  pi.registerCommand("thinklev", {
    description: "设置/查看思考深度: /thinklev [off|...|xhigh|max] (无参弹出二级选项菜单)",
    handler: thinkingHandler,
  });

  pi.registerCommand("thinklive", {
    description: "设置/查看思考深度: /thinklive [off|...|xhigh|max] (无参弹出二级选项菜单)",
    handler: thinkingHandler,
  });

  pi.registerCommand("set-default", {
    description: "设置默认模型/层级: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0]?.toLowerCase() === "tier") {
        const tier = parts[1]?.toUpperCase();
        if (!tier || !["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("用法: /set-default tier <L0|L1|L2>", "error"); return; }
        const config = readAllTiers();
        const r = resolveTierModel(tier as TierKey, config, ctx.modelRegistry, ctx.model?.provider);
        if (r) {
          writeDefaults(r.provider, r.model, tier);
          setState({ defaultRef: { provider: r.provider, model: r.model }, currentTier: tier as TierKey, tierConfig: config });
          const t = ctx.modelRegistry.find(r.provider, r.model);
          if (t) {
            await pi.setModel(t);
            applyThinking(tier as TierKey, t);
          }
        } else {
          writeDefaults(null, null, tier);
          setState({ defaultRef: null, currentTier: tier as TierKey, tierConfig: config });
        }
        statusLine(ctx);
        ctx.ui.notify(`\u2705 默认层级: ${tier}${r ? ` (${r.provider}/${r.model})` : ""}`, "info");
        return;
      }
      if (parts.length < 2) { ctx.ui.notify("用法: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>", "error"); return; }
      const p = parts[0]; const m = parts.slice(1).join(" ");
      const t = ctx.modelRegistry.find(p, m);
      if (!t) { ctx.ui.notify(`模型不存在: ${p}/${m}`, "error"); return; }
      const { tierConfig } = getState();
      const curTier = getCurrentTier(p, m, tierConfig);
      writeDefaults(p, m, curTier);
      setState({ defaultRef: { provider: p, model: m }, currentTier: curTier });
      await pi.setModel(t);
      if (curTier) applyThinking(curTier, t);
      statusLine(ctx);
      ctx.ui.notify(`默认: ${p}/${m}${curTier ? ` (${curTier})` : ""}`, "info");
    },
  });

  pi.registerCommand("reset-default", {
    description: "清除默认模型/层级",
    handler: async (_a, ctx) => {
      writeDefaults(null, null, null);
      setState({ defaultRef: null, currentTier: null });
      ctx.ui.setStatus("default-model", undefined);
      ctx.ui.notify("已清除默认配置", "info");
    },
  });

  pi.registerCommand("model-info", {
    description: "查看当前模型/层级/思考",
    handler: async (_a, ctx) => {
      const { currentTier, tierConfig, currentThinking } = getState();
      const cur = ctx.model;
      const tier = currentTier ?? getCurrentTier(cur?.provider, cur?.id, tierConfig);
      const think = pi.getThinkingLevel?.() || currentThinking;
      const s = readSettings();
      const def = s[KEY_PROVIDER] ? `${s[KEY_PROVIDER]}/${s[KEY_MODEL]}` : undefined;
      const defTier = s[KEY_TIER] as string | undefined;
      ctx.ui.notify(
        `当前: ${cur?.provider}/${cur?.id}${tier ? ` (${tier})` : ""} | 思考: ${think}(${thinkingLabel(think)})` +
        (def ? ` | 默认: ${def}` : "") + (defTier ? ` | 默认层级: ${defTier}` : ""),
        "info",
      );
    },
  });
}
