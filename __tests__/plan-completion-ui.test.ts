import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPlanPanel } from "../work-mode/plan-parser.js";
import type { PlanStep } from "../work-mode/types.js";

test("renderPlanPanel collapses to single concise completion line when all steps are complete", () => {
  const mockTheme = {
    fg: (_color: string, text: string) => `[fg]${text}[/fg]`,
    bold: (text: string) => `[bold]${text}[/bold]`,
  };

  const completedSteps: PlanStep[] = [
    { id: 1, text: "Step 1", status: "done" },
    { id: 2, text: "Step 2", status: "done" },
    { id: 3, text: "Step 3", status: "skipped" },
  ];

  // 1. 未展开状态：折叠为单行完成提示
  const collapsedLines = renderPlanPanel(completedSteps, mockTheme, false);
  assert.equal(collapsedLines.length, 1);
  assert.match(collapsedLines[0], /✓ 执行计划已全部完成/);
  assert.match(collapsedLines[0], /2 完成, 1 跳过/);

  // 2. 展开状态：依然能完整列出步骤
  const expandedLines = renderPlanPanel(completedSteps, mockTheme, true);
  assert.ok(expandedLines.length >= 4);
  assert.match(expandedLines[0], /执行计划/);

  // 3. 正在执行状态（有 pending/current）：展示步骤窗口而非完成提示
  const inProgressSteps: PlanStep[] = [
    { id: 1, text: "Step 1", status: "done" },
    { id: 2, text: "Step 2", status: "current" },
    { id: 3, text: "Step 3", status: "pending" },
  ];
  const inProgressLines = renderPlanPanel(inProgressSteps, mockTheme, false);
  assert.match(inProgressLines[0], /执行计划/);
  assert.doesNotMatch(inProgressLines[0], /✓ 执行计划已全部完成/);
});

test("plan completion uses UI widgets and notifications without injecting messages", () => {
  const planFeatureSource = readFileSync(
    join(process.cwd(), "work-mode", "plan-feature.ts"),
    "utf8",
  );

  // 1. 绝不发送消息到对话流
  assert.doesNotMatch(planFeatureSource, /sendMessage\s*\(/);
  assert.doesNotMatch(planFeatureSource, /sendUserMessage\s*\(/);

  // 2. 采用 ctx.ui.notify 轻量提醒
  assert.match(planFeatureSource, /ctx\.ui\.notify\([\s\S]*执行计划已全部完成/);

  // 3. 具备延时自动清理定时器以释放顶部空间
  assert.match(planFeatureSource, /planDismissTimer\s*=\s*setTimeout\(\(\)\s*=>/);
  assert.match(planFeatureSource, /ctx\.ui\.setWidget\("plan-panel",\s*undefined\)/);
});

test("manual plan clearing uses concise pure-text UI notification without emoji or injected messages", async () => {
  const planFeatureSource = readFileSync(
    join(process.cwd(), "work-mode", "plan-feature.ts"),
    "utf8",
  );

  // 1. 源码断言：清空时使用 ctx.ui.notify 纯文本通知
  assert.match(planFeatureSource, /clearPlanPanel[\s\S]*?ctx\.ui\.notify\(\s*"执行计划已清除",\s*"info"\s*\)/);

  // 2. 严禁包含 emoji 表情符号
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  const notifyMatches = planFeatureSource.match(/ctx\.ui\.notify\([^)]+\)/g) || [];
  for (const match of notifyMatches) {
    assert.doesNotMatch(match, emojiRegex, `Notification should not contain emoji: ${match}`);
  }

  // 3. 运行时行为断言：/plan-cancel 与 manage_plan clear 触发纯文本提示
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notifications: Array<{ message: string; level?: string }> = [];
  const widgets = new Map<string, any>();

  const mockPi = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: (def: any) => tools.set(def.name, def),
    appendEntry: () => {},
    on: () => {},
  };

  const mockCtx = {
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setWidget: (id: string, factory: any) => {
        widgets.set(id, factory);
      },
    },
    sessionManager: {
      getEntries: () => [],
    },
  };

  const { setupPlanFeature } = await import("../work-mode/plan-feature.js");
  const state: any = {
    phase: "work",
    isSubAgent: false,
    planSteps: [
      { id: 1, text: "Step 1", status: "current" },
      { id: 2, text: "Step 2", status: "pending" },
    ],
    planFullText: "1. Step 1\n2. Step 2",
  };

  setupPlanFeature(mockPi as any, state);

  // 3.1 测试 /plan-cancel 命令
  const cancelCmd = commands.get("plan-cancel");
  assert.ok(cancelCmd, "plan-cancel command should be registered");

  notifications.length = 0;
  await cancelCmd.handler({}, mockCtx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "执行计划已清除");
  assert.equal(notifications[0].level, "info");
  assert.equal(widgets.get("plan-panel"), undefined);
  assert.equal(state.planSteps.length, 0);
  assert.ok(!emojiRegex.test(notifications[0].message), "Message must not contain emoji");
  assert.ok(notifications[0].message.length <= 10, "Message should be concise");

  // 3.2 测试 manage_plan 的 clear 操作
  state.planSteps = [
    { id: 1, text: "Step 1", status: "done" },
    { id: 2, text: "Step 2", status: "current" },
  ];
  const managePlan = tools.get("manage_plan");
  assert.ok(managePlan, "manage_plan tool should be registered");

  notifications.length = 0;
  const result = await managePlan.execute(
    "call_1",
    { action: "clear", force: true },
    new AbortController().signal,
    () => {},
    mockCtx,
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "执行计划已清除");
  assert.equal(notifications[0].level, "info");
  assert.equal(widgets.get("plan-panel"), undefined);
  assert.equal(state.planSteps.length, 0);
  assert.ok(!emojiRegex.test(notifications[0].message), "Message must not contain emoji");
  assert.ok(notifications[0].message.length <= 10, "Message should be concise");
  assert.equal(result.details.action, "clear");
});
