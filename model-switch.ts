/**
 * model-switch.ts — 模型切换 + 模型分级系统 v4.0
 *
 * 从零配置: 无配置=无分级，通过命令/工具动态搭建 L0/L1/L2。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, TierKey, TierConfig } from "./model-switch/lib/types.js";
import { forceThinkingSupport, thinkingLabel, isValidThinkingLevel } from "./model-switch/lib/types.js";
import { readSettings, readAllTiers, getCurrentTier, resolveTierModel } from "./model-switch/lib/tier-config.js";
import { registerTierCmds } from "./model-switch/commands/tier-cmds.js";
import { registerDefaultCmds } from "./model-switch/commands/default-cmds.js";
import { registerSwitchModel } from "./model-switch/tools/switch-model.js";
import { KEY_PROVIDER, KEY_MODEL, KEY_TIER } from "./model-switch/lib/types.js";

export default function (pi: ExtensionAPI) {
  let defaultRef: { provider: string; model: string } | null = null;
  let currentTier: TierKey | null = null;
  let tierConfig: Record<TierKey, TierConfig> = {};
  let currentThinking: string = "";

  const getState = () => ({ currentTier, tierConfig, currentThinking, defaultRef });
  const setState = (s: Partial<{ currentTier: TierKey | null; tierConfig: Record<TierKey, TierConfig>; currentThinking: string; defaultRef: { provider: string; model: string } | null }>) => {
    if (s.currentTier !== undefined) currentTier = s.currentTier;
    if (s.tierConfig !== undefined) tierConfig = s.tierConfig;
    if (s.currentThinking !== undefined) currentThinking = s.currentThinking;
    if (s.defaultRef !== undefined) defaultRef = s.defaultRef;
  };

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

  function applyThinking(tier: TierKey, model?: unknown): ThinkingLevel | undefined {
    const lvl = tierConfig[tier]?.thinkingLevel;
    if (lvl) {
      forceThinkingSupport(model);
      pi.setThinkingLevel(lvl as any);
      currentThinking = lvl;
      return lvl;
    }
    return undefined;
  }

  function setThinking(level: string, model?: unknown): void {
    if (isValidThinkingLevel(level)) {
      forceThinkingSupport(model);
      pi.setThinkingLevel(level as any);
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
          if (currentTier) applyThinking(currentTier, t);
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
            applyThinking(currentTier, t);
            statusLine(ctx);
            return true;
          }
        }
      }
      return false;
    };

    if (!(await restoreConfiguredModel())) {
      for (const delay of [200, 500, 1000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (await restoreConfiguredModel()) break;
      }
    }
  });

  // ---- 命令 + 工具 ----
  registerTierCmds(pi, getState, setState, applyThinking, statusLine);
  registerDefaultCmds(pi, getState, setState, applyThinking, statusLine, setThinking);
  registerSwitchModel(pi, getState, setState, applyThinking);
}
