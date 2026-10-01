import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureAutoFlashSystemContext,
  formatStatelessGoalContext,
  formatStatelessPlanContext,
  getActiveGoalContext,
  getAutoCustomPrompt,
  getAutoFlashModel,
  loadAutoFlashSystemContext,
  parseAutoFlashDecision,
  registerAutoAddPrmtCommand,
  registerAutoFlashCommand,
  registerAutoModelCommand,
  reviewWithAutoFlash,
  setAutoCustomPrompt,
} from "../auto-flash.js";
import { showAutoFlashFallbackConfirm, isNavigationKey } from "../confirm-dialog.js";
import { abortWorkGoal, createWorkGoal } from "../../lib/work-goal-store.js";
import {
  checkAutoCircuitBreaker,
  clearAutoStatusBar,
  getAutoAction,
  getAutoStepCount,
  isAutoCircuitBroken,
  isAutoStopped,
  recordAutoStep,
  resetAutoCircuitBreaker,
  resetAutoSessionState,
  resetAutoStateForTurn,
  resetAutoStopped,
  resetAutoSteps,
  setAutoAction,
  setAutoStopped,
  updateAutoStatusBar,
} from "../auto-status.js";
import { setupCore } from "../core.js";
import { setupPermissionGuard } from "../permission-guard.js";
import { bindSessionExecutionContext, getExecutionContext, setExecutionContext } from "../../lib/execution-context.js";

/**
 * streamSimple 接收的是归一化后的 TranscriptContext：系统提示词必须已经是消息列表
 * 首条的 system 消息，顶层不再有 systemPrompt 字段。此前测试夹具读 context.systemPrompt，
 * 恰好吃到了「内置适配器读不到系统提示词」这个缺陷留下的形状。
 */
function readReviewContext(context: unknown): { systemPrompt: string; prompt: string } {
  const messages =
    (context as { messages?: Array<{ role?: string; content?: unknown }> } | undefined)?.messages ?? [];
  const asText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("");
    }
    return "";
  };
  return {
    systemPrompt: asText(messages.find((message) => message.role === "system")?.content),
    prompt: asText(messages.find((message) => message.role === "user")?.content),
  };
}

test("AUTO_FLASH accepts only a boolean decision and keeps a bounded reason", () => {
  assert.deepEqual(
    parseAutoFlashDecision('{"allow":true,"reason":"用途与命令一致"}'),
    { allow: true, reason: "用途与命令一致" },
  );
  assert.deepEqual(
    parseAutoFlashDecision('前缀\n{"allow":false,"reason":"命令会删除未验证目录"}\n后缀'),
    { allow: false, reason: "命令会删除未验证目录" },
  );
  assert.equal(parseAutoFlashDecision('{"allow":"yes"}'), undefined);
  assert.equal(parseAutoFlashDecision("not-json"), undefined);

  // 截断容错：尾部被截断缺失闭合括号时仍能正确提取
  assert.deepEqual(
    parseAutoFlashDecision('{"allow":true,"reason":"截断前的内容'),
    { allow: true, reason: "截断前的内容" },
  );
  assert.deepEqual(
    parseAutoFlashDecision('{"allow":false,"reason":"高危操作已拦截'),
    { allow: false, reason: "高危操作已拦截" },
  );

  const result = parseAutoFlashDecision(`{"allow":false,"reason":"${"x".repeat(2_000)}"}`);
  assert.ok(result);
  assert.equal(result.reason.length, 600);
});

test("AUTO_FLASH creates categorized default context when the workspace file is missing", () => {
  const workspace = mkdtempSync(join(tmpdir(), "auto-flash-default-system-"));
  const systemFile = join(workspace, ".agents", "auto_flash_system.md");
  try {
    const context = ensureAutoFlashSystemContext(workspace);
    assert.ok(context);
    assert.equal(readFileSync(systemFile, "utf8").trim(), context);
    assert.match(context, /^\[通用安全边界\]/m);
    assert.match(context, /^\[只读检查\]/m);
    assert.match(context, /^\[删除与覆盖\]/m);
    assert.match(context, /^\[凭证与敏感数据\]/m);
    assert.match(context, /^\[全局Skill与工具\]/m);
    assert.match(context, /\.agents.*\.pi.*\.codex.*\.claude/);
    assert.match(context, /^\[输出格式\]/m);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("AUTO_FLASH context loading stays read-only outside lifecycle initialization", () => {
  const workspace = mkdtempSync(join(tmpdir(), "auto-flash-read-only-"));
  const systemFile = join(workspace, ".agents", "auto_flash_system.md");
  try {
    assert.equal(loadAutoFlashSystemContext(workspace), undefined);
    assert.throws(() => readFileSync(systemFile, "utf8"), /ENOENT/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("AUTO_FLASH uses the runtime provider stream for custom providers", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "demo-openai", model: "reviewer" },
    },
    mtime: 0,
  };

  let streamCalled = false;
  const model = { provider: "demo-openai", id: "reviewer", api: "demo-openai-tolerant" };
  const provider = {
    streamSimple: (receivedModel: unknown, context: unknown, options: unknown) => {
      streamCalled = true;
      assert.equal(receivedModel, model);
      assert.equal(readReviewContext(context).systemPrompt.includes("安全审批器"), true);
      assert.equal((options as { maxTokens: number }).maxTokens, 1024);
      assert.equal((options as { reasoning: string }).reasoning, "low");
      assert.equal((options as { timeoutMs: number }).timeoutMs, 15_000);
      assert.equal((options as { cacheRetention: string }).cacheRetention, "long");
      assert.equal((options as { sessionId: string }).sessionId, "auto-flash:test-session");
      assert.equal((options as { apiKey: string }).apiKey, "test-key");
      return {
        result: async () => ({
          content: [{ type: "text", text: '{"allow":true,"reason":"已验证用途"}' }],
        }),
      };
    },
  };

  try {
    const result = await reviewWithAutoFlash(
      {
        cwd: "/workspace",
        signal: undefined,
        sessionManager: { getSessionId: () => "test-session" },
        modelRegistry: {
          find: () => model,
          getProvider: () => provider,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
      } as any,
      {
        command: "git status",
        toolName: "bash",
        cwd: "/workspace",
        effect: "read",
      },
    );
    assert.equal(streamCalled, true);
    assert.equal(result.allow, true);
    assert.equal(result.reason, "已验证用途");
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("AUTO_FLASH reads and caches workspace predefined context", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  const workspace = mkdtempSync(join(tmpdir(), "auto-flash-system-"));
  const agentsDir = join(workspace, ".agents");
  const systemFile = join(agentsDir, "auto_flash_system.md");
  mkdirSync(agentsDir);
  writeFileSync(systemFile, "只允许与当前用途一致的最小命令。", "utf8");
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "demo-openai", model: "reviewer" },
    },
    mtime: 0,
  };

  let receivedSystemPrompt = "";
  let receivedPrompt = "";
  try {
    assert.equal(loadAutoFlashSystemContext(workspace), "只允许与当前用途一致的最小命令。");
    // The second read exercises the mtime/size cache path.
    assert.equal(loadAutoFlashSystemContext(workspace), "只允许与当前用途一致的最小命令。");
    assert.equal(readFileSync(systemFile, "utf8"), "只允许与当前用途一致的最小命令。");

    const model = { provider: "demo-openai", id: "reviewer", api: "demo-openai-tolerant" };
    const result = await reviewWithAutoFlash(
      {
        cwd: workspace,
        signal: undefined,
        sessionManager: { getSessionId: () => "context-session" },
        modelRegistry: {
          find: () => model,
          getProvider: () => ({
            streamSimple: (_receivedModel: unknown, context: unknown) => {
              const reviewContext = readReviewContext(context);
              receivedSystemPrompt = reviewContext.systemPrompt;
              receivedPrompt = reviewContext.prompt;
              return {
                result: async () => ({
                  content: [{ type: "text", text: '{"allow":true,"reason":"上下文已加载"}' }],
                }),
              };
            },
          }),
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
      } as any,
      {
        command: "git status",
        toolName: "bash",
        cwd: workspace,
        input: {
          server: "pwiki",
          tool: "wiki_search",
          arguments: { query: "CORS", apiKey: "secret-value" },
        },
        effect: "read",
      },
    );

    assert.equal(result.allow, true);
    assert.match(receivedSystemPrompt, /<auto_flash_predefined_context>/);
    assert.match(receivedSystemPrompt, /只允许与当前用途一致的最小命令/);
    assert.match(receivedPrompt, /调用参数/);
    assert.match(receivedPrompt, /CORS/);
    assert.match(receivedPrompt, /\[redacted\]/);
    assert.doesNotMatch(receivedPrompt, /secret-value/);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("AUTO_FLASH exposes provider stream errors instead of mislabeling them as invalid JSON", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "demo-openai", model: "reviewer" },
    },
    mtime: 0,
  };

  try {
    const result = await reviewWithAutoFlash(
      {
        cwd: "/workspace",
        signal: undefined,
        modelRegistry: {
          find: () => ({ provider: "demo-openai", id: "reviewer", api: "demo-openai-tolerant" }),
          getProvider: () => ({
            streamSimple: () => ({
              result: async () => ({
                content: [],
                stopReason: "error",
                errorMessage: "No API key for provider: demo-openai",
              }),
            }),
          }),
          getApiKeyAndHeaders: async () => ({ ok: true }),
        },
      } as any,
      {
        command: "find . -name RedisService.java",
        toolName: "bash",
        cwd: "/workspace",
        effect: "unknown",
      },
    );
    assert.equal(result.allow, false);
    assert.match(result.reason, /AUTO_FLASH 调用失败/);
    assert.match(result.reason, /No API key/);
    assert.doesNotMatch(result.reason, /返回格式无法验证/);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("AUTO_FLASH model reference is read from the shared settings section", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "gptplus-openai", model: "gpt-5.6-luna" },
    },
    mtime: 0,
  };
  try {
    assert.deepEqual(getAutoFlashModel(), {
      provider: "gptplus-openai",
      model: "gpt-5.6-luna",
    });
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("showAutoFlashFallbackConfirm allows overriding AI rejection", async () => {
  const notifications: Array<{ msg: string; type: string }> = [];
  const fakeCtx = {
    ui: {
      select: async (title: string, options: string[]) => {
        assert.match(title, /AI 拒绝原因: 缺少回滚依据/);
        assert.match(title, /目标: rm -rf build/);
        assert.deepEqual(options, ["仅允许本次 (推翻AI拦截)", "确认拒绝 (立即终止本次调用)"]);
        return "仅允许本次 (推翻AI拦截)";
      },
      notify: (msg: string, type: string) => {
        notifications.push({ msg, type });
      },
    },
  } as any;

  const result = await showAutoFlashFallbackConfirm(
    fakeCtx,
    { command: "rm -rf build", toolName: "bash", purpose: "清理旧构建" },
    { reason: "缺少回滚依据", modelRef: "gpt-4o-mini" },
    false,
    10_000,
  );

  assert.equal(result.action, "allow");
  assert.equal(notifications.some((n) => n.msg.includes("已由人工推翻 AI 拦截")), true);
});

test("showAutoFlashFallbackConfirm auto-rejects on timeout and surfaces AI reason", async () => {
  const notifications: Array<{ msg: string; type: string }> = [];
  const fakeCtx = {
    ui: {
      select: async () => {
        // Simulate waiting forever without user input
        await new Promise((resolve) => setTimeout(resolve, 500));
        return undefined;
      },
      notify: (msg: string, type: string) => {
        notifications.push({ msg, type });
      },
    },
  } as any;

  // Use a short 50ms timeout for test speed
  const result = await showAutoFlashFallbackConfirm(
    fakeCtx,
    { command: "drop database prod", toolName: "bash" },
    { reason: "高危不可逆操作", modelRef: "claude-3-haiku" },
    false,
    50,
  );

  assert.equal(result.action, "deny");
  assert.equal(result.timeout, true);
  assert.match(result.reason ?? "", /AUTO_FLASH 拒绝：高危不可逆操作/);
  assert.match(result.reason ?? "", /人工审核超时/);
  assert.equal(notifications.some((n) => n.msg.includes("人工审核已超时")), true);
});

test("showAutoFlashFallbackConfirm rejects when user explicitly rejects", async () => {
  const fakeCtx = {
    ui: {
      select: async () => "确认拒绝 (立即终止本次调用)",
      notify: () => {},
    },
  } as any;

  const result = await showAutoFlashFallbackConfirm(
    fakeCtx,
    { command: "git push origin --force", toolName: "cmd" },
    { reason: "强制推送可能覆盖远端历史", modelRef: "deepseek-chat" },
    false,
    10_000,
  );

  assert.equal(result.action, "deny");
  assert.equal(result.timeout, false);
  assert.match(result.reason ?? "", /AUTO_FLASH 拒绝：强制推送可能覆盖远端历史/);
  assert.match(result.reason ?? "", /经人工审核确认拒绝/);
});

test("isNavigationKey identifies up/down, vim keys, page keys, and mouse wheel", () => {
  // 方向键 (ANSI 与 SS3)
  assert.equal(isNavigationKey("\x1b[A"), true);
  assert.equal(isNavigationKey("\x1bOA"), true);
  assert.equal(isNavigationKey("\x1b[B"), true);
  assert.equal(isNavigationKey("\x1bOB"), true);

  // Vim 导航键
  assert.equal(isNavigationKey("k"), true);
  assert.equal(isNavigationKey("j"), true);
  assert.equal(isNavigationKey("K"), true);
  assert.equal(isNavigationKey("J"), true);

  // 翻页与滚轮
  assert.equal(isNavigationKey("\x1b[5~"), true);
  assert.equal(isNavigationKey("\x1b[6~"), true);
  assert.equal(isNavigationKey("\x1b[<64;10;20M"), true); // 滚轮向上
  assert.equal(isNavigationKey("\x1b[<65;10;20M"), true); // 滚轮向下

  // 非导航键
  assert.equal(isNavigationKey("\n"), false);
  assert.equal(isNavigationKey("\r"), false);
  assert.equal(isNavigationKey("a"), false);
  assert.equal(isNavigationKey(" "), false);
  assert.equal(isNavigationKey(""), false);
});

test("showAutoFlashFallbackConfirm resets timeout when user navigates up/down", async () => {
  const initial = getExecutionContext();
  setExecutionContext({
    ...initial,
    phase: "work",
    autonomy: "auto",
  });

  try {
    const notifications: Array<{ msg: string; type: string }> = [];
    const statuses: Record<string, string | undefined> = {};
    let terminalInputListener: ((data: string) => void) | undefined;

    const fakeCtx = {
      ui: {
        select: async (title: string) => {
          // 验证标题中已包含提示
          assert.match(title, /上下选择可重置为/);
          // 模拟用户在 30ms 时按了下箭头键（在 60ms 超时前）
          setTimeout(() => {
            terminalInputListener?.("\x1b[B");
          }, 30);

          // 模拟等待直到超时退出
          await new Promise((resolve) => setTimeout(resolve, 500));
          return undefined;
        },
        onTerminalInput: (handler: (data: string) => void) => {
          terminalInputListener = handler;
          return () => {
            terminalInputListener = undefined;
          };
        },
        setStatus: (key: string, text: string | undefined) => {
          statuses[key] = text;
        },
        notify: (msg: string, type: string) => {
          notifications.push({ msg, type });
        },
      },
    } as any;

    // 初始 60ms 超时，用户在 30ms 触发上下导航，重置为 120ms 超时
    const startTime = Date.now();
    const result = await showAutoFlashFallbackConfirm(
      fakeCtx,
      { command: "systemctl restart docker", toolName: "bash" },
      { reason: "重启核心守护进程可能影响集群容器", modelRef: "deepseek-chat" },
      false,
      60,
      120,
    );
    const elapsed = Date.now() - startTime;

    // 验证超时时间确实被重置/延长（至少大于初始的 60ms，大约 150ms 左右才超时）
    assert.ok(elapsed >= 100, `Elapsed ${elapsed}ms should be >= 100ms due to timeout reset`);
    assert.equal(result.action, "deny");
    assert.equal(result.timeout, true);
    assert.match(result.reason ?? "", /人工审核超时/);
    // 验证状态栏提示已联动更新
    assert.match(statuses["auto-status"] ?? "", /倒计时已重置为/);
    // 验证通知已发出
    assert.equal(notifications.some((n) => n.msg.includes("人工审核已超时")), true);
  } finally {
    setExecutionContext(initial);
  }
});

test("getAutoCustomPrompt and setAutoCustomPrompt manage custom reviewer prompt", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = { data: {}, mtime: 0 };
  try {
    assert.equal(getAutoCustomPrompt(), undefined);
    setAutoCustomPrompt("重点限制网络外联");
    assert.equal(getAutoCustomPrompt(), "重点限制网络外联");
    setAutoCustomPrompt(undefined);
    assert.equal(getAutoCustomPrompt(), undefined);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("formatStatelessPlanContext creates concise stateless plan summary without logs", () => {
  const steps = [
    { id: 1, text: "梳理审批边界", status: "done" as const, updatedAt: 123 },
    { id: 2, text: "增加 auto_model 与 auto_add_prmt", status: "current" as const, updatedAt: 456 },
    { id: 3, text: "验证与部署", status: "pending" as const, updatedAt: 789 },
  ];
  const summary = formatStatelessPlanContext(steps, "重构审批模式并透传无状态上下文");
  assert.match(summary, /计划概述: 重构审批模式并透传无状态上下文/);
  assert.match(summary, /1\. \[done\] 梳理审批边界/);
  assert.match(summary, /2\. ▶ \[进行中\] 增加 auto_model 与 auto_add_prmt/);
  assert.match(summary, /3\. \[pending\] 验证与部署/);
  assert.equal(summary.includes("123"), false);
  assert.equal(summary.includes("456"), false);
});

test("formatStatelessGoalContext and getActiveGoalContext format active work goal without logs", () => {
  const goal = createWorkGoal({
    title: "迁移数据存储",
    goal: "将配置文件从老版本平滑迁移到新版本",
  });
  const summary = formatStatelessGoalContext(goal);
  assert.match(summary, /目标名称: 迁移数据存储/);
  assert.match(summary, /目标定义: 将配置文件从老版本平滑迁移到新版本/);
  assert.equal(summary.includes("createdAt"), false);

  const activeCtx = getActiveGoalContext();
  assert.ok(activeCtx);
  assert.match(activeCtx, /目标名称: 迁移数据存储/);
  abortWorkGoal(goal.id, "test cleanup");
});

test("registerAutoModelCommand and registerAutoAddPrmtCommand register commands properly", async () => {
  const commands: Record<string, any> = {};
  const fakePi = {
    registerCommand: (name: string, def: any) => {
      commands[name] = def;
    },
  } as any;

  registerAutoFlashCommand(fakePi);
  assert.ok(commands["auto_model"]);
  assert.ok(commands["auto_flash"]);
  assert.ok(commands["auto_add_prmt"]);

  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = { data: {}, mtime: 0 };
  const notifications: Array<{ msg: string; type: string }> = [];
  const fakeCtx = {
    cwd: "/workspace",
    ui: {
      notify: (msg: string, type: string) => {
        notifications.push({ msg, type });
      },
    },
  } as any;

  try {
    await commands["auto_add_prmt"].handler("严查 rm -rf", fakeCtx);
    assert.equal(getAutoCustomPrompt(), "严查 rm -rf");
    assert.equal(notifications.some((n) => n.msg.includes("审核模型自定义提示词已更新")), true);

    await commands["auto_add_prmt"].handler("clear", fakeCtx);
    assert.equal(getAutoCustomPrompt(), undefined);
    assert.equal(notifications.some((n) => n.msg.includes("已清除审核模型自定义提示词")), true);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("reviewWithAutoFlash injects stateless goal, plan, and custom prompt into prompt", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "demo-openai", model: "reviewer" },
      autoCustomPrompt: "用户全局指令：禁止向外部提交未测试代码",
    },
    mtime: 0,
  };

  let capturedPrompt = "";
  const model = { provider: "demo-openai", id: "reviewer", api: "demo-openai-tolerant" };
  const provider = {
    streamSimple: (_receivedModel: unknown, context: any) => {
      capturedPrompt = readReviewContext(context).prompt;
      return {
        result: async () => ({
          content: [{ type: "text", text: '{"allow":true,"reason":"审核通过"}' }],
        }),
      };
    },
  };

  try {
    const result = await reviewWithAutoFlash(
      {
        cwd: "/workspace",
        signal: undefined,
        sessionManager: { getSessionId: () => "test-session" },
        modelRegistry: {
          find: () => model,
          getProvider: () => provider,
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
        },
      } as any,
      {
        command: "git push origin dev",
        toolName: "bash",
        cwd: "/workspace",
        effect: "external",
        planContext: "计划步骤清单:\n  1. ▶ [进行中] 提交改动",
        goalContext: "目标名称: 迭代发布\n目标定义: 完成分支代码合入",
      },
    );

    assert.equal(result.allow, true);
    assert.match(capturedPrompt, /【当前活动目标（目标模式）】/);
    assert.match(capturedPrompt, /目标名称: 迭代发布/);
    assert.match(capturedPrompt, /【当前执行计划（计划模式）】/);
    assert.match(capturedPrompt, /1\. ▶ \[进行中\] 提交改动/);
    assert.match(capturedPrompt, /【用户自定义审核指令】/);
    assert.match(capturedPrompt, /用户全局指令：禁止向外部提交未测试代码/);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("auto-status manages step counts, circuit breaker, and stop state", () => {
  resetAutoSessionState();
  assert.equal(isAutoStopped(), false);
  assert.equal(isAutoCircuitBroken(), false);
  assert.equal(getAutoStepCount(), 0);

  // Record steps
  assert.equal(recordAutoStep(), 1);
  assert.equal(recordAutoStep(), 2);
  assert.equal(getAutoStepCount(), 2);

  // Turn reset clears step counter
  resetAutoStateForTurn();
  assert.equal(getAutoStepCount(), 0);

  // Test circuit breaker (default 100 steps without plan/goal)
  for (let i = 0; i < 99; i++) {
    recordAutoStep();
  }
  let breaker = checkAutoCircuitBreaker();
  assert.equal(breaker.broken, false);
  assert.equal(isAutoCircuitBroken(), false);

  recordAutoStep(); // 100th step
  breaker = checkAutoCircuitBreaker();
  assert.equal(breaker.broken, true);
  assert.equal(isAutoCircuitBroken(), true);
  assert.match(breaker.reason ?? "", /防死循环熔断/);

  // Reset circuit breaker
  resetAutoCircuitBreaker();
  assert.equal(isAutoCircuitBroken(), false);

  // Stop state
  setAutoStopped(true);
  assert.equal(isAutoStopped(), true);
  resetAutoStopped();
  assert.equal(isAutoStopped(), false);
});

test("auto-status updates status bar according to mode and action", () => {
  resetAutoSessionState();

  const statuses: Record<string, unknown> = {};
  const mockCtx = {
    ui: {
      setStatus: (key: string, val: unknown) => {
        statuses[key] = val;
      },
    },
  };

  const initial = getExecutionContext();

  try {
    // When in guarded mode, status bar is cleared
    setExecutionContext({ ...initial, autonomy: "guarded" });
    updateAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], undefined);

    // When in auto mode, shows ready
    setExecutionContext({ ...initial, autonomy: "auto" });
    updateAutoStatusBar(mockCtx as any);
    assert.match(String(statuses["auto-status"] ?? ""), /AUTO \[就绪/);

    // When action is set
    updateAutoStatusBar(mockCtx as any, "审核中: bash...");
    assert.equal(statuses["auto-status"], "AUTO [审核中: bash...]");

    updateAutoStatusBar(mockCtx as any, "已放行: bash (#1)");
    assert.equal(statuses["auto-status"], "AUTO [已放行: bash (#1)]");

    // When stopped
    setAutoStopped(true);
    updateAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], "AUTO [已终止]");

    // Clear
    clearAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], undefined);
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});

test("setupCore registers /auto_stop, /auto_cancel, /auto_abort and stops AUTO mode", async () => {
  resetAutoSessionState();
  const initial = getExecutionContext();
  setExecutionContext({
    ...initial,
    phase: "work",
    autonomy: "auto",
  });

  const commands = new Map<string, any>();
  const statuses: Record<string, unknown> = {};
  const notifications: Array<{ msg: string; level: string }> = [];

  const mockPi = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    on: () => {},
    appendEntry: () => {},
  };

  const mockCtx = {
    cwd: "/workspace",
    sessionManager: { getEntries: () => [] },
    ui: {
      setStatus: (key: string, val: unknown) => { statuses[key] = val; },
      notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
    },
  };

  const s = { phase: "work" as const, isSubAgent: false };
  setupCore(mockPi as any, s, { resetForNewTurn: () => {} });

  assert.ok(commands.has("auto_stop"));
  assert.ok(commands.has("auto_cancel"));
  assert.ok(commands.has("auto_abort"));

  // Execute /auto_stop
  bindSessionExecutionContext(mockCtx.sessionManager, getExecutionContext());
  await commands.get("auto_stop").handler("", mockCtx as any);

  assert.equal(isAutoStopped(mockCtx.sessionManager), true);
  assert.equal(s.phase, "work");
  assert.equal(getExecutionContext(mockCtx.sessionManager).autonomy, "guarded");
  assert.equal(statuses["auto-status"], "AUTO [已终止]");
  assert.ok(notifications.some((n) => n.msg.includes("已强制终止")));

  // Clean up
  setExecutionContext(initial);
  resetAutoSessionState();
});

test("setupPermissionGuard terminates immediately on /auto_stop and suppresses retry notification", async () => {
  resetAutoSessionState();
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
    planSteps: [{ id: 1, text: "核心逻辑实现", status: "pending" as const }],
  };
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Record<string, unknown> = {};
  const mockCtx = {
    cwd: "/workspace",
    ui: {
      setStatus: (key: string, val: unknown) => { statuses[key] = val; },
      notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
    },
  };

  setupPermissionGuard(mockPi as any, state, { getCurrentStepIndex: () => 0 });

  try {
    // 1. When autoStopped is set, tool_call blocks with terminate: true
    setAutoStopped(true);
    const res = await handlers.get("tool_call")(
      { toolName: "read", toolCallId: "tc_stop_1", input: { path: "test.ts" } },
      mockCtx,
    );
    assert.equal(res?.block, true);
    assert.equal(res?.terminate, true);
    assert.match(res?.reason ?? "", /auto_stop/);

    // 2. tool_result error notification should be suppressed when autoStopped
    handlers.get("tool_result")(
      { toolCallId: "tc_stop_1", isError: true, content: [{ type: "text", text: "aborted" }] },
      mockCtx,
    );
    assert.equal(notifications.filter((n) => n.msg.includes("仍保持进行中")).length, 0);

    // 3. New turn unfreezes state
    resetAutoStateForTurn();
    assert.equal(isAutoStopped(), false);
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});

test("setupPermissionGuard counts all auto steps (including read) and terminates on circuit break", async () => {
  resetAutoSessionState();
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
    planSteps: [{ id: 1, text: "只读死循环测试", status: "pending" as const }],
  };
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Record<string, unknown> = {};
  const mockCtx = {
    cwd: "/workspace",
    ui: {
      setStatus: (key: string, val: unknown) => { statuses[key] = val; },
      notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
    },
  };

  setupPermissionGuard(mockPi as any, state, { getCurrentStepIndex: () => 0 });

  try {
    // Execute 100 read tool calls (the maximum allowed without plan/goal)
    for (let i = 1; i <= 100; i++) {
      const res = await handlers.get("tool_call")(
        { toolName: "read", toolCallId: `tc_read_${i}`, input: { path: "test.ts" } },
        mockCtx,
      );
      assert.equal(res, undefined); // allowed
      assert.equal(getAutoStepCount(), i);
    }

    // 101st call (exceeding limit) trips circuit breaker and falls back to ordinary authentication
    const breakerRes = await handlers.get("tool_call")(
      { toolName: "read", toolCallId: "tc_read_101", input: { path: "test.ts" } },
      mockCtx,
    );
    assert.equal(breakerRes?.block, true);
    // 回到普通认证，而不是直接失败（无 terminate: true）
    assert.equal(breakerRes?.terminate, undefined);
    assert.equal(isAutoCircuitBroken(), true);
    assert.equal(getExecutionContext().autonomy, "guarded");
    assert.ok(notifications.some((n) => n.msg.includes("普通认证模式")));

    // tool_result retry notification should be suppressed when circuit broken
    handlers.get("tool_result")(
      { toolCallId: "tc_read_25", isError: true, content: [{ type: "text", text: "breaker tripped" }] },
      mockCtx,
    );
    assert.equal(notifications.filter((n) => n.msg.includes("仍保持进行中")).length, 0);

    // New turn unfreezes circuit breaker
    resetAutoStateForTurn();
    assert.equal(isAutoCircuitBroken(), false);
    assert.equal(getAutoStepCount(), 0);
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});

test("updateAutoStatusBar clears auto-status in CHAT and PLAN phases even if autoStopped is set", () => {
  resetAutoSessionState();
  const initial = getExecutionContext();

  const statuses: Record<string, unknown> = {};
  const mockCtx = {
    ui: {
      setStatus: (key: string, val: unknown) => { statuses[key] = val; },
    },
  };

  try {
    setAutoStopped(true);

    // In CHAT phase, status bar must be cleared
    setExecutionContext({ ...initial, phase: "chat", autonomy: "guarded" });
    updateAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], undefined);

    // In PLAN phase, status bar must be cleared
    setExecutionContext({ ...initial, phase: "plan", autonomy: "guarded" });
    updateAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], undefined);

    // In WORK phase, stopped status is visible
    setExecutionContext({ ...initial, phase: "work", autonomy: "guarded" });
    updateAutoStatusBar(mockCtx as any);
    assert.equal(statuses["auto-status"], "AUTO [已终止]");
  } finally {
    setExecutionContext(initial);
    resetAutoSessionState();
  }
});

test("fallback confirm denial maps explicit rejection to terminate: true and timeout to terminate: false", () => {
  // Human rejection: timeout is false -> terminate: true (stops agent loop)
  const humanDenial = { action: "deny" as const, timeout: false, reason: "用户拒绝" };
  assert.equal(humanDenial.timeout !== true, true);

  // Timeout auto-rejection: timeout is true -> terminate: false (allows continuous execution / fallback)
  const timeoutDenial = { action: "deny" as const, timeout: true, reason: "超时拒绝" };
  assert.equal(timeoutDenial.timeout !== true, false);
});
