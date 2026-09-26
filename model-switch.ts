/**
 * model-switch.ts — 模型切换 + 模型分级系统 v4.0
 *
 * 从零配置: 无配置=无分级，通过命令/工具动态搭建 L0/L1/L2。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, TierKey, TierConfig } from "./model-switch/lib/types.js";
import { forceThinkingSupport, thinkingLabel, isValidThinkingLevel } from "./model-switch/lib/types.js";
import { readAllTiers, getCurrentTier, resolveTierModel } from "./model-switch/lib/tier-config.js";
import { getSettings, updateSettings } from "./lib/settings-io.js";
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
    // 移除 default-model 独立状态项，彻底消除【🧠最大】与冗余模型展示，保持底栏两行精简
    ctx?.ui?.setStatus?.("default-model", undefined);
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
    const initThinking = pi.getThinkingLevel?.();
    if (initThinking) currentThinking = initThinking;

    // 检查历史分支中是否已有用户对话消息
    // 仅当恢复已有会话且分支中已经包含用户消息时，才保留旧会话上下文中的模型
    // 在全新启动 (startup)、新建会话 (new)、或没有任何用户消息时，必须执行默认模型恢复
    const branch = ctx.sessionManager.getBranch();
    const hasMessages = branch.some((e: { type: string }) => e.type === "message");
    if (hasMessages && _e.reason === "resume") return;

    const restoreConfiguredModel = async (): Promise<boolean> => {
      refreshConfig();
      const s = getSettings();
      const tk = s[KEY_TIER] as string | undefined;
      const p = s[KEY_PROVIDER] as string | undefined;
      const m = s[KEY_MODEL] as string | undefined;

      // 1. 优先从 defaultTier 恢复
      if (tk && ["L0", "L1", "L2"].includes(tk)) {
        const r = resolveTierModel(tk as TierKey, tierConfig, ctx.modelRegistry);
        if (r) {
          const t = ctx.modelRegistry.find(r.provider, r.model);
          if (t) {
            defaultRef = { provider: r.provider, model: r.model };
            currentTier = tk as TierKey;
            await pi.setModel(t);
            applyThinking(currentTier, t);
            statusLine(ctx);
            return true;
          }
        }
      }

      // 2. 其次从 defaultProvider + defaultModel 恢复
      if (p && m) {
        const t = ctx.modelRegistry.find(p, m);
        if (t) {
          defaultRef = { provider: p, model: m };
          currentTier = getCurrentTier(p, m, tierConfig);
          await pi.setModel(t);
          if (currentTier) applyThinking(currentTier, t);
          statusLine(ctx);
          return true;
        }
      }

      // 3. 如果未配置持久化模型，但当前已有模型，更新状态栏
      if (ctx.model) {
        currentTier = getCurrentTier(ctx.model.provider, ctx.model.id, tierConfig);
        statusLine(ctx);
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

  // ---- 事件监听：保持与官方 thinking 和 model 选择双向同步 ----
  pi.on("thinking_level_select", (event, ctx) => {
    if (event?.level) {
      currentThinking = event.level;
    }
    statusLine(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    refreshConfig();
    if (event?.model) {
      currentTier = getCurrentTier(event.model.provider, event.model.id, tierConfig);
      // 当用户主动选择模型 (source 为 "set" 或 "cycle") 时持久化保存
      if (event.source === "set" || event.source === "cycle") {
        defaultRef = { provider: event.model.provider, model: event.model.id };
        updateSettings((s) => {
          s[KEY_PROVIDER] = event.model.provider;
          s[KEY_MODEL] = event.model.id;
          if (currentTier) {
            s[KEY_TIER] = currentTier;
          } else {
            delete s[KEY_TIER];
          }
          return s;
        });
      }
    }
    const think = pi.getThinkingLevel?.();
    if (think) currentThinking = think;
    statusLine(ctx);
  });

  // ---- 命令 + 工具 ----
  registerTierCmds(pi, getState, setState, applyThinking, statusLine);
  registerDefaultCmds(pi, getState, setState, applyThinking, statusLine, setThinking);
  registerSwitchModel(pi, getState, setState, applyThinking, statusLine);
}
