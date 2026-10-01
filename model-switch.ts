/**
 * model-switch.ts — 模型切换 + 模型分级系统 v4.0
 *
 * 从零配置: 无配置=无分级，通过命令/工具动态搭建 L0/L1/L2。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, TierKey, TierConfig } from "./model-switch/lib/types.js";
import { forceThinkingSupport, forceThinkingSupportAll, thinkingLabel, isValidThinkingLevel } from "./model-switch/lib/types.js";
import { readAllTiers, getCurrentTier, resolveTierModel } from "./model-switch/lib/tier-config.js";
import { getSettings, updateSettings } from "./lib/settings-io.js";
import { registerTierCmds } from "./model-switch/commands/tier-cmds.js";
import { registerDefaultCmds } from "./model-switch/commands/default-cmds.js";
import { registerSwitchModel } from "./model-switch/tools/switch-model.js";
import { KEY_PROVIDER, KEY_MODEL, KEY_TIER } from "./model-switch/lib/types.js";
import { registerCapability } from "./lib/capability-router.js";

export default function (pi: ExtensionAPI) {
  registerCapability({
    id: "model_switch",
    name: "Model Switch & Thinking Tier",
    summary: "Switch active model, manage reasoning/thinking depth, and configure model tiers.",
    keywords: ["model", "switch_model", "thinking", "tier", "reasoning", "model_select"],
    phases: ["work", "plan"],
    tools: ["switch_model"],
    toolDescriptions: {
      switch_model: "切换当前会话模型、查询可用模型列表、设置思考深度(thinkingLevel)及配置 L0/L1/L2 模型分级",
    },
    usageDoc: `# Model Switch & Thinking Tier Subsystem (model_switch)

### Available Tool:
- \`switch_model\`: Switch models, query model list, manage model tier configuration and thinking/reasoning depth.

### Usage Guidelines:
1. Use switch_model only when task complexity, context, cost, or requested reasoning depth materially benefits from a change.
2. Use switch_model tiers (L0/L1/L2) for normal routing and manage_providers only for provider registration.
3. If switch_model cannot resolve a requested tier or model, continue with the current model and report the missing configuration.

### Common Actions:
- \`switch_model({})\`: List available models and current active model/tier/thinking depth.
- \`switch_model({ provider: "...", model: "..." })\`: Switch to a specific provider and model.
- \`switch_model({ tier: "L0" | "L1" | "L2" })\`: Switch to a preconfigured model tier.
- \`switch_model({ thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" })\`: Set thinking/reasoning depth and persist it.
- \`switch_model({ action: "show_tier_config" })\`: Inspect current L0/L1/L2 configuration.
- \`switch_model({ action: "add_to_tier", tier: "...", provider: "...", model: "...", thinkingLevel?: "..." })\`: Add a model to a tier.
- \`switch_model({ action: "remove_from_tier", tier: "...", provider?: "...", model?: "..." })\`: Remove model from a tier.
- \`switch_model({ action: "set_tier_thinking", tier: "...", thinkingLevel: "..." })\`: Set tier-specific thinking depth.`,
  });

  let defaultRef: { provider: string; model: string } | null = null;
  let currentTier: TierKey | null = null;
  // 空对象起步：各 TierKey 在首次配置/加载前并未填充，用断言表达这个惰性初始状态。
  let tierConfig: Record<TierKey, TierConfig> = {} as Record<TierKey, TierConfig>;
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

  function restoreModelThinking(model: unknown, tier?: TierKey | null): ThinkingLevel | undefined {
    if (!model) return undefined;
    forceThinkingSupport(model);
    const m = model as { provider?: string; id?: string };
    const s = getSettings();
    const modelKey = m.provider && m.id ? `${m.provider}/${m.id}` : null;
    const modelSpecific = modelKey ? (s.modelThinkingLevels as Record<string, string>)?.[modelKey] : undefined;
    if (modelSpecific && isValidThinkingLevel(modelSpecific)) {
      setThinking(modelSpecific, model);
      return modelSpecific as ThinkingLevel;
    }
    if (tier && tierConfig[tier]?.thinkingLevel) {
      return applyThinking(tier, model);
    }
    if (s.defaultThinkingLevel && isValidThinkingLevel(s.defaultThinkingLevel)) {
      setThinking(s.defaultThinkingLevel as string, model);
      return s.defaultThinkingLevel as ThinkingLevel;
    }
    return undefined;
  }

  // ---- session_start ----
  pi.on("session_start", async (_e, ctx) => {
    refreshConfig();
    if (ctx.model) forceThinkingSupport(ctx.model);
    try {
      const all = ctx.modelRegistry?.getAll?.() || [];
      forceThinkingSupportAll(all);
    } catch {}

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
            restoreModelThinking(t, currentTier);
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
          restoreModelThinking(t, currentTier);
          statusLine(ctx);
          return true;
        }
      }

      // 3. 如果未配置持久化模型，但当前已有模型，更新状态与思考深度
      if (ctx.model) {
        currentTier = getCurrentTier(ctx.model.provider, ctx.model.id, tierConfig);
        restoreModelThinking(ctx.model, currentTier);
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
    if (event?.level && isValidThinkingLevel(event.level)) {
      currentThinking = event.level;
      if (ctx.model) {
        forceThinkingSupport(ctx.model);
        // 捕获为局部常量：闭包体内的属性收窄不成立，直接引用 ctx.model 会被判定为可能为空。
        const selectedModel = ctx.model;
        // 用户通过原生快捷键/原生选择器切换思考深度时，自动持久化至当前模型专属配置与全局默认
        updateSettings((s) => {
          if (!s.modelThinkingLevels || typeof s.modelThinkingLevels !== "object") {
            s.modelThinkingLevels = {};
          }
          (s.modelThinkingLevels as Record<string, string>)[`${selectedModel.provider}/${selectedModel.id}`] = event.level;
          s.defaultThinkingLevel = event.level;
          return s;
        });
      }
    }
    statusLine(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    refreshConfig();
    if (event?.model) {
      forceThinkingSupport(event.model);
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
      // 切换模型时自动恢复该模型的思考深度
      restoreModelThinking(event.model, currentTier);
    }
    if (ctx.model) {
      forceThinkingSupport(ctx.model);
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
