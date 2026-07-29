/**
 * default-cmds.ts — /set-default, /reset-default, /model-info, /thinking
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TierKey, TierConfig } from "../lib/types.js";
import { KEY_PROVIDER, KEY_MODEL, KEY_TIER, isValidThinkingLevel, VALID_THINKING_LEVELS, thinkingLabel } from "../lib/types.js";
import { readAllTiers, resolveTierModel, getCurrentTier } from "../lib/tier-config.js";
import { getSettings, updateSettings } from "../../lib/settings-io.js";

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

  pi.registerCommand("thinking", {
    description: "设置/查看思考深度: /thinking [off|...|xhigh]",
    handler: async (args, ctx) => {
      const { currentThinking } = getState();
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
      setThinking(input, ctx.model);
      statusLine(ctx);
      ctx.ui.notify(`\u2705 思考深度: ${input}(${thinkingLabel(input)})`, "info");
    },
  });

  pi.registerCommand("set-default", {
    description: "设置默认模型/层级: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0]?.toLowerCase() === "tier") {
        const tier = parts[1]?.toUpperCase();
        if (!tier || !["L0", "L1", "L2"].includes(tier)) { ctx.ui.notify("用法: /set-default tier <L0|L1|L2>", "error"); return; }
        writeDefaults(null, null, tier);
        setState({ defaultRef: null });
        const config = readAllTiers();
        const r = resolveTierModel(tier as TierKey, config, ctx.modelRegistry, ctx.model?.provider);
        if (r) { const t = ctx.modelRegistry.find(r.provider, r.model); if (t) { await pi.setModel(t); setState({ currentTier: tier as TierKey, tierConfig: config }); applyThinking(tier as TierKey, t); } }
        statusLine(ctx);
        ctx.ui.notify(`\u2705 默认层级: ${tier}`, "info");
        return;
      }
      if (parts.length < 2) { ctx.ui.notify("用法: /set-default <provider> <model> 或 /set-default tier <L0|L1|L2>", "error"); return; }
      const p = parts[0]; const m = parts.slice(1).join(" ");
      const t = ctx.modelRegistry.find(p, m);
      if (!t) { ctx.ui.notify(`模型不存在: ${p}/${m}`, "error"); return; }
      writeDefaults(p, m, null);
      const { tierConfig } = getState();
      setState({ defaultRef: { provider: p, model: m } });
      await pi.setModel(t);
      setState({ currentTier: getCurrentTier(p, m, tierConfig) });
      statusLine(ctx);
      ctx.ui.notify(`\u2705 默认: ${p}/${m}`, "info");
    },
  });

  pi.registerCommand("reset-default", {
    description: "清除默认模型/层级",
    handler: async (_a, ctx) => {
      writeDefaults(null, null, null);
      setState({ defaultRef: null, currentTier: null });
      ctx.ui.setStatus("default-model", undefined);
      ctx.ui.notify("\u2705 已清除", "info");
    },
  });

  pi.registerCommand("model-info", {
    description: "查看当前模型/层级/思考",
    handler: async (_a, ctx) => {
      const { currentTier, tierConfig, currentThinking } = getState();
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
}
