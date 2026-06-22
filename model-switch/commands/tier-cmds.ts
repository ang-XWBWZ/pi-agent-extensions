/**
 * tier-cmds.ts — 层级管理命令: /tier, /tier-add, /tier-remove, /tier-set-thinking, /tier-config
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, TierKey, TierConfig } from "../lib/types.js";
import { isValidThinkingLevel, VALID_THINKING_LEVELS, TIER_DEFAULTS, thinkingLabel } from "../lib/types.js";
import { readAllTiers, writeAllTiers, resolveTierModel, getCurrentTier } from "../lib/tier-config.js";
import { KEY_PROVIDER, KEY_MODEL, KEY_TIER } from "../lib/types.js";
import { getSettings, updateSettings } from "../../lib/settings-io.js";

export function registerTierCmds(
  pi: ExtensionAPI,
  getState: () => { currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string },
  setState: (s: Partial<{ currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string }>) => void,
  applyThinking: (tier: TierKey, model?: unknown) => ThinkingLevel | undefined,
  statusLine: (ctx: any) => void,
): void {

  pi.registerCommand("tier", {
    description: "切换层级: /tier [L0|L1|L2]。无参显示当前。",
    handler: async (args, ctx) => {
      const { currentTier, tierConfig, currentThinking } = getState();
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
      if (ok) {
        setState({ currentTier: tier, tierConfig: config });
        applyThinking(tier, t);
        statusLine(ctx);
        // 持久化
        updateSettings((s) => {
          s[KEY_PROVIDER] = r.provider;
          s[KEY_MODEL] = r.model;
          s[KEY_TIER] = tier;
          return s;
        });
      }
      const think = config[tier]?.thinkingLevel;
      ctx.ui.notify(ok ? `\u2705 ${tier} · ${config[tier].label}: ${r.provider}/${r.model}${think ? ` | \u{1F9E0} ${think}(${thinkingLabel(think)})` : ""}` : "切换失败", ok ? "info" : "warning");
    },
  });

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
      if (tc.models.some((m) => m.provider === provider && m.model === model)) {
        ctx.ui.notify(`${provider}/${model} 已在 ${tier} 中`, "warning");
      } else {
        tc.models.push({ provider, model });
      }
      if (thinking) tc.thinkingLevel = thinking as ThinkingLevel;
      config[tier as TierKey] = tc;
      writeAllTiers(config);
      setState({ tierConfig: config });
      ctx.ui.notify(`\u2705 ${tier} + ${provider}/${model}${thinking ? ` | \u{1F9E0} ${thinking}` : ""}`, "info");
    },
  });

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
          (m) => !(m.provider === provider && m.model === model),
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
      setState({ tierConfig: config });
    },
  });

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
      setState({ tierConfig: config });
      ctx.ui.notify(`\u2705 ${tier} 默认思考: ${parts[1]}(${thinkingLabel(parts[1])})`, "info");
    },
  });

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
}
