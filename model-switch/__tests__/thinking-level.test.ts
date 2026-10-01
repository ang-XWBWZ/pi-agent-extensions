import test from "node:test";
import assert from "node:assert/strict";
import { buildModelConfigs } from "../../provider-manager/lib/register.js";
import {
  VALID_THINKING_LEVELS,
  isValidThinkingLevel,
  thinkingLabel,
  forceThinkingSupport,
  forceThinkingSupportAll,
  type ThinkingLevel,
  type TierKey,
  type TierConfig,
} from "../lib/types.js";
import { registerDefaultCmds } from "../commands/default-cmds.js";
import { getSettings, updateSettings } from "../../lib/settings-io.js";

// 模拟原生 pi-ai 中的 getSupportedThinkingLevels 核心函数
function nativeGetSupportedThinkingLevels(model: any): string[] {
  const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

test("buildModelConfigs sets reasoning: true and full 7-level thinkingLevelMap for custom models", () => {
  const customModels = [
    { id: "deepseek-flash", name: "DeepSeek Flash" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "custom-chat", name: "Custom Chat" },
  ];

  const configs = buildModelConfigs(customModels);

  for (const cfg of configs) {
    assert.equal(cfg.reasoning, true, `Model ${cfg.id} should have reasoning: true`);
    assert.ok(cfg.thinkingLevelMap, `Model ${cfg.id} should have thinkingLevelMap`);
    assert.equal(cfg.thinkingLevelMap.off, undefined);
    assert.equal(cfg.thinkingLevelMap.minimal, "minimal");
    assert.equal(cfg.thinkingLevelMap.low, "low");
    assert.equal(cfg.thinkingLevelMap.medium, "medium");
    assert.equal(cfg.thinkingLevelMap.high, "high");
    assert.equal(cfg.thinkingLevelMap.xhigh, "xhigh");
    assert.equal(cfg.thinkingLevelMap.max, "max");

    // 验证原生 getSupportedThinkingLevels 返回全部 7 档
    const supported = nativeGetSupportedThinkingLevels(cfg);
    assert.deepEqual(supported, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  }
});

test("forceThinkingSupport unblocks models missing reasoning or thinkingLevelMap", () => {
  const model: any = {
    id: "gpt-4o",
    provider: "openai",
    reasoning: false,
    thinkingLevelMap: {
      minimal: null,
      xhigh: undefined,
    },
  };

  assert.deepEqual(nativeGetSupportedThinkingLevels(model), ["off"]);

  forceThinkingSupport(model);

  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.minimal, "minimal");
  assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(model.thinkingLevelMap.max, "max");

  const supported = nativeGetSupportedThinkingLevels(model);
  assert.deepEqual(supported, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("forceThinkingSupportAll patches an array of models", () => {
  const models = [
    { id: "m1", reasoning: false },
    { id: "m2", reasoning: false },
  ];

  forceThinkingSupportAll(models);

  assert.equal(models[0].reasoning, true);
  assert.equal(models[1].reasoning, true);
  assert.deepEqual(nativeGetSupportedThinkingLevels(models[0]), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(nativeGetSupportedThinkingLevels(models[1]), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("thinking commands (/thinking-level, /thinklev, /thinklive) register and handle direct parameters with persistence", async () => {
  const registeredCommands = new Map<string, any>();
  const mockPi: any = {
    registerCommand: (name: string, def: any) => {
      registeredCommands.set(name, def);
    },
    getThinkingLevel: () => "medium",
    setThinkingLevel: (lvl: string) => {
      mockPi._currentLevel = lvl;
    },
    _currentLevel: "medium",
  };

  let state = {
    currentTier: null as TierKey | null,
    tierConfig: {} as Record<TierKey, TierConfig>,
    currentThinking: "medium",
    defaultRef: null as { provider: string; model: string } | null,
  };

  const getState = () => state;
  const setState = (s: any) => { state = { ...state, ...s }; };
  const applyThinking = (_tier: TierKey, _model?: unknown) => undefined;
  const statusLine = (_ctx: any) => {};
  const setThinking = (level: string, model?: unknown) => {
    state.currentThinking = level;
    mockPi.setThinkingLevel(level);
  };

  registerDefaultCmds(mockPi, getState, setState, applyThinking, statusLine, setThinking);

  // 验证三个别名均已注册
  assert.ok(registeredCommands.has("thinking-level"));
  assert.ok(registeredCommands.has("thinklev"));
  assert.ok(registeredCommands.has("thinklive"));

  const mockCtx: any = {
    model: { provider: "test-provider", id: "test-model" },
    ui: {
      notifications: [] as string[],
      notify: (msg: string) => { mockCtx.ui.notifications.push(msg); },
    },
  };

  // 通过 /thinklev max 直接带参调用
  const thinklevCmd = registeredCommands.get("thinklev");
  await thinklevCmd.handler("max", mockCtx);

  assert.equal(mockPi._currentLevel, "max");
  assert.equal(state.currentThinking, "max");

  // 验证持久化写入 settings.json
  const settings = getSettings();
  assert.equal(settings.defaultThinkingLevel, "max");
  assert.equal((settings.modelThinkingLevels as any)?.["test-provider/test-model"], "max");
  assert.ok(mockCtx.ui.notifications.some((n: string) => n.includes("思考深度已设为: max")));

  // 通过 /thinklive low 直接带参调用
  const thinkliveCmd = registeredCommands.get("thinklive");
  await thinkliveCmd.handler("low", mockCtx);

  assert.equal(mockPi._currentLevel, "low");
  assert.equal(state.currentThinking, "low");
  const updatedSettings = getSettings();
  assert.equal(updatedSettings.defaultThinkingLevel, "low");
  assert.equal((updatedSettings.modelThinkingLevels as any)?.["test-provider/test-model"], "low");
});

test("interactive secondary menu: Choice 1 (model-specific) saves to modelThinkingLevels", async () => {
  const registeredCommands = new Map<string, any>();
  const mockPi: any = {
    registerCommand: (name: string, def: any) => { registeredCommands.set(name, def); },
    getThinkingLevel: () => "low",
    setThinkingLevel: (lvl: string) => { mockPi._currentLevel = lvl; },
    _currentLevel: "low",
  };

  let state = {
    currentTier: null as TierKey | null,
    tierConfig: {} as Record<TierKey, TierConfig>,
    currentThinking: "low",
    defaultRef: null as { provider: string; model: string } | null,
  };

  const getState = () => state;
  const setState = (s: any) => { state = { ...state, ...s }; };
  const applyThinking = (_tier: TierKey, _model?: unknown) => undefined;
  const statusLine = (_ctx: any) => {};
  const setThinking = (level: string, _model?: unknown) => {
    state.currentThinking = level;
    mockPi.setThinkingLevel(level);
  };

  registerDefaultCmds(mockPi, getState, setState, applyThinking, statusLine, setThinking);
  const thinkCmd = registeredCommands.get("thinklev");

  // 模拟二级菜单选择：
  // 第 1 步：选择 "1. 绑定并保存为当前模型专属配置..."
  // 第 2 步：选择 "xhigh (极高思考 - ...)"
  const selectCalls: { prompt: string; options: string[] }[] = [];
  const mockCtx: any = {
    model: { provider: "gptplus-openai", id: "gpt-6-luna" },
    ui: {
      notifications: [] as string[],
      notify: (msg: string) => { mockCtx.ui.notifications.push(msg); },
      select: async (prompt: string, options: string[]) => {
        selectCalls.push({ prompt, options });
        if (selectCalls.length === 1) {
          // 一级菜单选择
          return options[0]; // 选项 1
        }
        if (selectCalls.length === 2) {
          // 二级菜单选择 xhigh
          return options.find((o) => o.startsWith("xhigh")) ?? options[0];
        }
        return null;
      },
    },
  };

  await thinkCmd.handler("", mockCtx);

  assert.equal(selectCalls.length, 2, "Should trigger a 2-level menu");
  assert.equal(mockPi._currentLevel, "xhigh");
  assert.equal(state.currentThinking, "xhigh");

  const settings = getSettings();
  assert.equal((settings.modelThinkingLevels as any)?.["gptplus-openai/gpt-6-luna"], "xhigh");
  assert.ok(mockCtx.ui.notifications.some((n: string) => n.includes("已永久保存至配置")));
});

test("interactive secondary menu: Choice 2 (global default) saves to defaultThinkingLevel", async () => {
  const registeredCommands = new Map<string, any>();
  const mockPi: any = {
    registerCommand: (name: string, def: any) => { registeredCommands.set(name, def); },
    getThinkingLevel: () => "off",
    setThinkingLevel: (lvl: string) => { mockPi._currentLevel = lvl; },
    _currentLevel: "off",
  };

  let state = {
    currentTier: null as TierKey | null,
    tierConfig: {} as Record<TierKey, TierConfig>,
    currentThinking: "off",
    defaultRef: null as { provider: string; model: string } | null,
  };

  const getState = () => state;
  const setState = (s: any) => { state = { ...state, ...s }; };
  const applyThinking = (_tier: TierKey, _model?: unknown) => undefined;
  const statusLine = (_ctx: any) => {};
  const setThinking = (level: string, _model?: unknown) => {
    state.currentThinking = level;
    mockPi.setThinkingLevel(level);
  };

  registerDefaultCmds(mockPi, getState, setState, applyThinking, statusLine, setThinking);
  const thinkCmd = registeredCommands.get("thinklev");

  const selectCalls: { prompt: string; options: string[] }[] = [];
  const mockCtx: any = {
    model: { provider: "test", id: "m" },
    ui: {
      notifications: [] as string[],
      notify: (msg: string) => { mockCtx.ui.notifications.push(msg); },
      select: async (prompt: string, options: string[]) => {
        selectCalls.push({ prompt, options });
        if (selectCalls.length === 1) {
          // 选择选项 2：保存为全局默认思考深度
          return options[1];
        }
        if (selectCalls.length === 2) {
          // 二级菜单选择 medium
          return options.find((o) => o.startsWith("medium")) ?? options[0];
        }
        return null;
      },
    },
  };

  await thinkCmd.handler("", mockCtx);

  assert.equal(selectCalls.length, 2);
  assert.equal(mockPi._currentLevel, "medium");

  const settings = getSettings();
  assert.equal(settings.defaultThinkingLevel, "medium");
});

test("interactive secondary menu: Choice 4 (session temporary) does not mutate disk settings", async () => {
  const registeredCommands = new Map<string, any>();
  const mockPi: any = {
    registerCommand: (name: string, def: any) => { registeredCommands.set(name, def); },
    getThinkingLevel: () => "off",
    setThinkingLevel: (lvl: string) => { mockPi._currentLevel = lvl; },
    _currentLevel: "off",
  };

  let state = {
    currentTier: null as TierKey | null,
    tierConfig: {} as Record<TierKey, TierConfig>,
    currentThinking: "off",
    defaultRef: null as { provider: string; model: string } | null,
  };

  const getState = () => state;
  const setState = (s: any) => { state = { ...state, ...s }; };
  const applyThinking = (_tier: TierKey, _model?: unknown) => undefined;
  const statusLine = (_ctx: any) => {};
  const setThinking = (level: string, _model?: unknown) => {
    state.currentThinking = level;
    mockPi.setThinkingLevel(level);
  };

  registerDefaultCmds(mockPi, getState, setState, applyThinking, statusLine, setThinking);
  const thinkCmd = registeredCommands.get("thinklev");

  // 先把 settings 中的临时标记清除
  updateSettings((s) => {
    delete (s as any).modelThinkingLevels?.["temp-provider/temp-model"];
    return s;
  });

  const selectCalls: { prompt: string; options: string[] }[] = [];
  const mockCtx: any = {
    model: { provider: "temp-provider", id: "temp-model" },
    ui: {
      notifications: [] as string[],
      notify: (msg: string) => { mockCtx.ui.notifications.push(msg); },
      select: async (prompt: string, options: string[]) => {
        selectCalls.push({ prompt, options });
        if (selectCalls.length === 1) {
          // 选择选项 4：仅调整当前会话思考深度
          return options[3];
        }
        if (selectCalls.length === 2) {
          // 二级菜单选择 minimal
          return options.find((o) => o.startsWith("minimal")) ?? options[0];
        }
        return null;
      },
    },
  };

  await thinkCmd.handler("", mockCtx);

  assert.equal(selectCalls.length, 2);
  assert.equal(mockPi._currentLevel, "minimal");
  assert.equal(state.currentThinking, "minimal");

  // 验证磁盘未写入该模型的配置
  const settings = getSettings();
  assert.equal((settings.modelThinkingLevels as any)?.["temp-provider/temp-model"], undefined);
  assert.ok(mockCtx.ui.notifications.some((n: string) => n.includes("未保存至磁盘")));
});

test("interactive secondary menu: Choice 3 (Tier config) saves tier thinkingLevel", async () => {
  const registeredCommands = new Map<string, any>();
  const mockPi: any = {
    registerCommand: (name: string, def: any) => { registeredCommands.set(name, def); },
    getThinkingLevel: () => "off",
    setThinkingLevel: (lvl: string) => { mockPi._currentLevel = lvl; },
    _currentLevel: "off",
  };

  let state = {
    currentTier: "L1" as TierKey | null,
    tierConfig: {
      L0: { label: "快速", desc: "", models: [] },
      L1: { label: "主要", desc: "", models: [{ provider: "p1", model: "m1" }] },
      L2: { label: "高级", desc: "", models: [] },
    } as Record<TierKey, TierConfig>,
    currentThinking: "off",
    defaultRef: null as { provider: string; model: string } | null,
  };

  const getState = () => state;
  const setState = (s: any) => { state = { ...state, ...s }; };
  let appliedTier: TierKey | null = null;
  const applyThinking = (tier: TierKey, _model?: unknown) => {
    appliedTier = tier;
    state.currentThinking = state.tierConfig[tier]?.thinkingLevel ?? "off";
    return state.currentThinking as ThinkingLevel;
  };
  const statusLine = (_ctx: any) => {};
  const setThinking = (level: string, _model?: unknown) => {
    state.currentThinking = level;
    mockPi.setThinkingLevel(level);
  };

  registerDefaultCmds(mockPi, getState, setState, applyThinking, statusLine, setThinking);
  const thinkCmd = registeredCommands.get("thinklev");

  const selectCalls: { prompt: string; options: string[] }[] = [];
  const mockCtx: any = {
    model: { provider: "p1", id: "m1" },
    ui: {
      notifications: [] as string[],
      notify: (msg: string) => { mockCtx.ui.notifications.push(msg); },
      select: async (prompt: string, options: string[]) => {
        selectCalls.push({ prompt, options });
        if (selectCalls.length === 1) {
          // 选择选项 3：配置分层模型思考深度
          return options[2];
        }
        if (selectCalls.length === 2) {
          // 选择 L1
          return options.find((o) => o.startsWith("L1")) ?? options[0];
        }
        if (selectCalls.length === 3) {
          // 选择 high
          return options.find((o) => o.startsWith("high")) ?? options[0];
        }
        return null;
      },
    },
  };

  await thinkCmd.handler("", mockCtx);

  assert.equal(selectCalls.length, 3);
  assert.equal(state.tierConfig.L1.thinkingLevel, "high");
  assert.equal(appliedTier, "L1");

  const settings = getSettings();
  assert.equal((settings.modelTiers as any)?.L1?.thinkingLevel, "high");
});
