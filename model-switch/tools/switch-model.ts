/**
 * switch-model.ts — switch_model 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThinkingLevel, TierKey, TierConfig } from "../lib/types.js";
import { isValidThinkingLevel, TIER_DEFAULTS, thinkingLabel, forceThinkingSupport, KEY_PROVIDER, KEY_MODEL, KEY_TIER } from "../lib/types.js";
import { readAllTiers, writeAllTiers, resolveTierModel, getCurrentTier, readSettings, writeSettingsRaw } from "../lib/tier-config.js";

export function registerSwitchModel(
  pi: ExtensionAPI,
  getState: () => { currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string; defaultRef: { provider: string; model: string } | null },
  setState: (s: Partial<{ currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string; defaultRef: { provider: string; model: string } | null }>) => void,
  applyThinking: (tier: TierKey, model?: unknown) => ThinkingLevel | undefined,
): void {

  function setThinking(level: string, model?: unknown): void {
    if (isValidThinkingLevel(level)) {
      forceThinkingSupport(model);
      pi.setThinkingLevel(level as any);
      setState({ currentThinking: level });
    }
  }

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
            if (!tc.models.some((m) => m.provider === params.provider && m.model === params.model)) {
              tc.models.push({ provider: params.provider!, model: params.model! });
            }
            if (params.thinkingLevel && isValidThinkingLevel(params.thinkingLevel)) tc.thinkingLevel = params.thinkingLevel as ThinkingLevel;
            config[tier as TierKey] = tc;
            writeAllTiers(config); setState({ tierConfig: config });
            return { content: [{ type: "text", text: `\u2705 ${tier} + ${params.provider}/${params.model}${params.thinkingLevel ? ` | \u{1F9E0} ${params.thinkingLevel}` : ""}` }], details: {} };
          }
          case "remove_from_tier": {
            const tier = params.tier?.toUpperCase();
            if (!tier || !["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: "需要 tier" }], details: {} };
            if (!config[tier as TierKey]) return { content: [{ type: "text", text: `${tier} 为空` }], details: {} };
            if (params.provider && params.model) {
              config[tier as TierKey].models = config[tier as TierKey].models.filter(
                (m) => !(m.provider === params.provider && m.model === params.model),
              );
            } else { delete config[tier as TierKey]; }
            writeAllTiers(config); setState({ tierConfig: config });
            return { content: [{ type: "text", text: params.provider ? `\u2705 移除 ${params.provider}/${params.model}` : `\u2705 ${tier} 已清空` }], details: {} };
          }
          case "set_tier_thinking": {
            const tier = params.tier?.toUpperCase();
            if (!tier || !["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: "需要 tier" }], details: {} };
            if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) return { content: [{ type: "text", text: `${tier} 为空` }], details: {} };
            if (!params.thinkingLevel || !isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: "需要 thinkingLevel" }], details: {} };
            config[tier as TierKey].thinkingLevel = params.thinkingLevel as ThinkingLevel;
            writeAllTiers(config); setState({ tierConfig: config });
            return { content: [{ type: "text", text: `\u2705 ${tier} \u{1F9E0} ${params.thinkingLevel}` }], details: {} };
          }
          default: return { content: [{ type: "text", text: `未知 action: ${params.action}` }], details: {} };
        }
      }

      // standalone thinking
      if (params.thinkingLevel && !params.tier && !params.provider) {
        if (!isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: `无效` }], details: {} };
        setThinking(params.thinkingLevel, ctx.model);
        return { content: [{ type: "text", text: `\u2705 \u{1F9E0} ${params.thinkingLevel}(${thinkingLabel(params.thinkingLevel)})` }], details: {} };
      }

      // tier switch
      if (params.tier) {
        const tier = params.tier.toUpperCase();
        if (!["L0", "L1", "L2"].includes(tier)) return { content: [{ type: "text", text: `无效层级` }], details: {} };
        if (params.thinkingLevel && !isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: `无效` }], details: {} };
        const config = readAllTiers();
        if (!config[tier as TierKey] || config[tier as TierKey].models.length === 0) return { content: [{ type: "text", text: `${tier} 未配置` }], details: {} };
        const r = resolveTierModel(tier as TierKey, config, ctx.modelRegistry, ctx.model?.provider);
        if (!r) return { content: [{ type: "text", text: `模型不可用` }], details: {} };
        const t = ctx.modelRegistry.find(r.provider, r.model);
        if (!t) return { content: [{ type: "text", text: `不存在` }], details: {} };
        const ok = await pi.setModel(t);
        if (ok) {
          setState({ currentTier: tier as TierKey, tierConfig: config });
          if (params.thinkingLevel) setThinking(params.thinkingLevel, t);
          else applyThinking(tier as TierKey, t);
          // 持久化：写回 defaultProvider/defaultModel/defaultTier
          const s = readSettings();
          s[KEY_PROVIDER] = r.provider;
          s[KEY_MODEL] = r.model;
          s[KEY_TIER] = tier;
          writeSettingsRaw(s);
        }
        const think = params.thinkingLevel ?? config[tier as TierKey]?.thinkingLevel;
        return { content: [{ type: "text", text: ok ? `\u2705 ${tier} · ${config[tier as TierKey].label}: ${r.provider}/${r.model}${think ? ` | \u{1F9E0} ${think}(${thinkingLabel(think)})` : ""}` : "失败" }], details: {} };
      }

      // provider+model
      if (params.provider && params.model) {
        if (params.thinkingLevel && !isValidThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: `无效` }], details: {} };
        const t = ctx.modelRegistry.find(params.provider, params.model);
        if (!t) return { content: [{ type: "text", text: `Model not found` }], details: {} };
        const ok = await pi.setModel(t);
        const { tierConfig } = getState();
        if (ok) {
          setState({ currentTier: getCurrentTier(params.provider, params.model, tierConfig) });
          if (params.thinkingLevel) setThinking(params.thinkingLevel, t);
          else { const ct = getState().currentTier; if (ct) applyThinking(ct, t); }
          // 持久化：写回 defaultProvider/defaultModel，清除 defaultTier
          const s = readSettings();
          s[KEY_PROVIDER] = params.provider;
          s[KEY_MODEL] = params.model;
          delete s[KEY_TIER];
          writeSettingsRaw(s);
        }
        return { content: [{ type: "text", text: ok ? `Switched to ${params.provider}/${params.model}${params.thinkingLevel ? ` | \u{1F9E0} ${params.thinkingLevel}(${thinkingLabel(params.thinkingLevel)})` : ""}` : "Failed" }], details: {} };
      }

      // list
      const config = readAllTiers();
      const all = await ctx.modelRegistry.getAvailable();
      const { currentTier, currentThinking, defaultRef } = getState();
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
            c.models.some((tm) => tm.provider === m.provider && tm.model === m.id),
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
