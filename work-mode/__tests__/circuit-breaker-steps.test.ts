import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAutoCircuitBreaker,
  getAutoAction,
  getAutoStatusSummary,
  getAutoStepCount,
  getMaxAutoSteps,
  hasActiveGoal,
  hasActivePlan,
  hasActivePlanOrGoal,
  isAutoCircuitBroken,
  MAX_AUTO_STEPS_DEFAULT,
  MAX_AUTO_STEPS_WITH_PLAN,
  recordAutoStep,
  registerActivePlanChecker,
  resetAutoCircuitBreaker,
  resetAutoSessionState,
  resetAutoStateForTurn,
  resetAutoSteps,
  updateAutoStatusBar,
} from "../auto-status.js";
import {
  abortWorkGoal,
  createWorkGoal,
  deleteWorkGoal,
  finishWorkGoal,
} from "../../lib/work-goal-store.js";
import { setupPlanFeature } from "../plan-feature.js";
import { setupPermissionGuard } from "../permission-guard.js";
import { getExecutionContext, setExecutionContext } from "../../lib/execution-context.js";

test("circuit breaker step limits: 100 steps without plan/goal, 200 with plan/goal", () => {
  resetAutoSessionState();
  registerActivePlanChecker(undefined);

  // 1. 无计划/无目标状态下，限额为 100 步
  assert.equal(hasActivePlan(), false);
  assert.equal(hasActiveGoal(), false);
  assert.equal(hasActivePlanOrGoal(), false);
  assert.equal(getMaxAutoSteps(), MAX_AUTO_STEPS_DEFAULT);
  assert.equal(getMaxAutoSteps(), 100);

  // 步数递增至 99 步，未熔断
  for (let i = 0; i < 99; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 99);
  let breaker = checkAutoCircuitBreaker();
  assert.equal(breaker.broken, false);

  // 达到 100 步，触发熔断
  recordAutoStep();
  assert.equal(getAutoStepCount(), 100);
  breaker = checkAutoCircuitBreaker();
  assert.equal(breaker.broken, true);
  assert.match(breaker.reason ?? "", /限额100步/);

  // 2. 建立目标后，限额提升为 200 步
  resetAutoSessionState();
  const goal = createWorkGoal({
    title: "单元测试目标",
    goal: "验证目标存在时熔断上限为200步",
  });
  try {
    assert.equal(hasActiveGoal(), true);
    assert.equal(hasActivePlanOrGoal(), true);
    assert.equal(getMaxAutoSteps(), MAX_AUTO_STEPS_WITH_PLAN);
    assert.equal(getMaxAutoSteps(), 200);

    // 在 100 步时不会熔断（因为上限是 200 步）
    for (let i = 0; i < 100; i++) {
      recordAutoStep();
    }
    breaker = checkAutoCircuitBreaker();
    assert.equal(breaker.broken, false);

    // 递增至 199 步，仍未熔断
    for (let i = 0; i < 99; i++) {
      recordAutoStep();
    }
    assert.equal(getAutoStepCount(), 199);
    breaker = checkAutoCircuitBreaker();
    assert.equal(breaker.broken, false);

    // 第 200 步触发熔断
    recordAutoStep();
    assert.equal(getAutoStepCount(), 200);
    breaker = checkAutoCircuitBreaker();
    assert.equal(breaker.broken, true);
    assert.match(breaker.reason ?? "", /限额200步/);
  } finally {
    abortWorkGoal(goal.id, "test clean");
  }

  // 3. 存在活跃计划时，限额同样提升为 200 步
  resetAutoSessionState();
  let fakeSteps = [{ id: 1, text: "步骤1", status: "pending" as const }];
  registerActivePlanChecker(() => fakeSteps.some((s) => s.status === "pending"));
  try {
    assert.equal(hasActivePlan(), true);
    assert.equal(hasActivePlanOrGoal(), true);
    assert.equal(getMaxAutoSteps(), 200);

    for (let i = 0; i < 199; i++) {
      recordAutoStep();
    }
    assert.equal(checkAutoCircuitBreaker().broken, false);
    recordAutoStep();
    assert.equal(checkAutoCircuitBreaker().broken, true);
  } finally {
    registerActivePlanChecker(undefined);
    resetAutoSessionState();
  }
});

test("goal lifecycle triggers step counter resets (create, finish, abort, delete)", () => {
  resetAutoSessionState();

  // 累积若干步数
  for (let i = 0; i < 50; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 50);

  // 1. 目标建立 -> 计数清空
  const goal = createWorkGoal({
    title: "测试目标生命周期",
    goal: "测试目标生命周期各阶段计数重置",
  });
  assert.equal(getAutoStepCount(), 0);

  // 再次累积步数
  for (let i = 0; i < 30; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 30);

  // 2. 目标完成 -> 计数清空
  finishWorkGoal(goal.id, "测试完成总结");
  assert.equal(getAutoStepCount(), 0);

  // 3. 目标终止 -> 计数清空
  const goal2 = createWorkGoal({ goal: "测试终止" });
  for (let i = 0; i < 20; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 20);
  abortWorkGoal(goal2.id, "测试异常终止");
  assert.equal(getAutoStepCount(), 0);

  // 4. 目标删除 -> 计数清空
  const goal3 = createWorkGoal({ goal: "测试删除" });
  for (let i = 0; i < 15; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 15);
  deleteWorkGoal(goal3.id);
  assert.equal(getAutoStepCount(), 0);
});

test("plan lifecycle triggers step counter resets (set_steps, clear, complete, delete_step)", async () => {
  resetAutoSessionState();
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const mockPi = {
    on: (evt: string, fn: any) => handlers.set(evt, fn),
    appendEntry: () => {},
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
  };
  const s = {
    phase: "work" as const,
    isSubAgent: false,
    planSteps: [] as any[],
    planFullText: "",
  };
  const mockCtx = {
    cwd: "/workspace",
    ui: {
      setWidget: () => {},
      notify: () => {},
    },
  };

  const planCb = setupPlanFeature(mockPi as any, s);
  const managePlan = tools.get("manage_plan");
  assert.ok(managePlan);

  // 1. 计划建立 (set_steps) -> 计数清空
  for (let i = 0; i < 40; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 40);

  await managePlan.execute("t1", {
    action: "set_steps",
    steps: ["第一步", "第二步"],
  }, undefined, undefined, mockCtx);

  assert.equal(getAutoStepCount(), 0);
  assert.equal(s.planSteps.length, 2);
  // 计划进行中，熔断上限提升为 200 步
  assert.equal(hasActivePlan(), true);
  assert.equal(getMaxAutoSteps(), 200);

  // 2. 计划删除/清除 (clear) -> 计数清空
  for (let i = 0; i < 35; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 35);

  await managePlan.execute("t2", {
    action: "clear",
    force: true,
  }, undefined, undefined, mockCtx);

  assert.equal(getAutoStepCount(), 0);
  assert.equal(s.planSteps.length, 0);
  // 计划已清除，熔断上限恢复为 100 步
  assert.equal(hasActivePlan(), false);
  assert.equal(getMaxAutoSteps(), 100);

  // 3. 计划完成 (complete) -> 计数清空
  planCb.replacePlanSteps(["单一步骤"], mockCtx as any);
  assert.equal(getAutoStepCount(), 0);
  // 推进至 done
  await managePlan.execute("t3", {
    action: "advance",
    status: "done",
    evidence: "已测试通过",
  }, undefined, undefined, mockCtx);

  for (let i = 0; i < 25; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 25);

  await managePlan.execute("t4", {
    action: "complete",
  }, undefined, undefined, mockCtx);

  assert.equal(getAutoStepCount(), 0);

  // 4. 删除步骤直至删空 -> 计数清空
  planCb.replacePlanSteps(["步骤A"], mockCtx as any);
  assert.equal(getAutoStepCount(), 0);
  const stepId = s.planSteps[0].id;
  for (let i = 0; i < 18; i++) {
    recordAutoStep();
  }
  assert.equal(getAutoStepCount(), 18);

  await managePlan.execute("t5", {
    action: "delete_step",
    stepId,
  }, undefined, undefined, mockCtx);

  assert.equal(s.planSteps.length, 0);
  assert.equal(getAutoStepCount(), 0);

  resetAutoSessionState();
  registerActivePlanChecker(undefined);
});

test("circuit breaker fallback: returns to ordinary authentication without 10s timeout or direct failure", async () => {
  resetAutoSessionState();
  registerActivePlanChecker(undefined);
  const initial = getExecutionContext();
  setExecutionContext({
    ...initial,
    phase: "work",
    autonomy: "auto",
  });

  const handlers = new Map<string, any>();
  const mockPi = {
    on: (evt: string, fn: any) => handlers.set(evt, fn),
    appendEntry: () => {},
  };
  const state = {
    phase: "work" as const,
    isSubAgent: false,
    pathAllowlist: new Set<string>(),
    cmdAllowlist: new Set<string>(),
    actionAllowlist: new Set<string>(),
    planSteps: [],
  };

  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Record<string, unknown> = {};
  let lastPromptTitle = "";
  let lastPromptOptions: string[] = [];
  let userChoice: string | undefined = "仅允许本次";

  const mockCtx = {
    cwd: "/workspace",
    ui: {
      setStatus: (key: string, val: unknown) => { statuses[key] = val; },
      notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
      select: async (title: string, options: string[]) => {
        lastPromptTitle = title;
        lastPromptOptions = options;
        return userChoice;
      },
    },
  };

  setupPermissionGuard(mockPi as any, state, { getCurrentStepIndex: () => 0 });

  try {
    // 累积达到 100 步
    for (let i = 1; i <= 100; i++) {
      recordAutoStep();
    }
    assert.equal(getAutoStepCount(), 100);

    // 第 101 次调用触发熔断
    userChoice = "仅允许本次";
    const res = await handlers.get("tool_call")(
      { toolName: "bash", toolCallId: "tc_shell_101", input: { command: "npm test" } },
      mockCtx,
    );

    // 验证：不是直接失败（没有 terminate: true，也没有直接 block 抛弃）
    assert.equal(res?.terminate, undefined);
    assert.equal(res?.block, undefined);

    // 验证：回退到普通认证模式
    assert.equal(getExecutionContext().autonomy, "guarded");
    assert.equal(getExecutionContext().approval.interactive, true);

    // 验证：普通认证弹窗展示，且选项包含常规人工选择（不是 10s 倒计时模式）
    assert.match(lastPromptTitle, /AUTO 熔断人工确认/);
    assert.ok(lastPromptOptions.includes("仅允许本次"));
    assert.ok(lastPromptOptions.includes("拒绝并说明原因"));

    // 验证：人工确认放行后，步数重置，熔断状态解除
    assert.equal(isAutoCircuitBroken(), false);
    assert.equal(getAutoStepCount(), 0);

    // 测试用户在熔断时选择拒绝的情形
    for (let i = 1; i <= 100; i++) {
      recordAutoStep();
    }
    userChoice = "拒绝并说明原因";
    // mock 输入拒绝理由
    (mockCtx.ui as any).input = async () => "步数超限且测试异常，人工终止该命令";

    const denyRes = await handlers.get("tool_call")(
      { toolName: "bash", toolCallId: "tc_shell_deny", input: { command: "npm run deploy" } },
      mockCtx,
    );

    // 验证：普通认证拒绝时按用户理由正常拦截，非系统底层崩溃
    assert.equal(denyRes?.block, true);
    assert.equal(denyRes?.terminate, undefined);
    assert.match(denyRes?.reason ?? "", /人工终止该命令/);
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});

test("pure text UI: no emoji in status summary, status bar, or breaker notifications", () => {
  resetAutoSessionState();
  const initial = getExecutionContext();
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  try {
    setExecutionContext({ ...initial, phase: "work", autonomy: "auto" });

    // 1. 状态简述无 emoji
    const summary = getAutoStatusSummary();
    assert.ok(summary);
    assert.equal(emojiRegex.test(summary), false);

    // 2. 熔断时原因描述无 emoji
    for (let i = 0; i < 100; i++) {
      recordAutoStep();
    }
    const breaker = checkAutoCircuitBreaker();
    assert.equal(breaker.broken, true);
    assert.ok(breaker.reason);
    assert.equal(emojiRegex.test(breaker.reason), false);

    // 3. 熔断后状态栏无 emoji
    const statuses: Record<string, unknown> = {};
    const mockCtx = {
      ui: {
        setStatus: (key: string, val: unknown) => { statuses[key] = val; },
      },
    };
    updateAutoStatusBar(mockCtx as any);
    const barText = statuses["auto-status"] as string;
    assert.ok(barText);
    assert.equal(emojiRegex.test(barText), false);
    assert.match(barText, /AUTO \[已熔断: 超100步\]/);
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});
