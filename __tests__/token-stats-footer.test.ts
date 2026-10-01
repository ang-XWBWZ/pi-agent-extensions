import test from "node:test";
import assert from "node:assert/strict";
import { buildTwoLineFooter, formatTokens, formatCwdForFooter } from "../token-stats.js";
import { setExecutionContext, initializeExecutionContext, getExecutionContext } from "../lib/execution-context.js";
import { setAutoAction, resetAutoStateForTurn, setAutoStopped, onAutoStatusChange } from "../work-mode/auto-status.js";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("formatTokens formats token counts correctly", () => {
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(67000), "67k");
  assert.equal(formatTokens(1000000), "1.0M");
  assert.equal(formatTokens(2500000), "2.5M");
});

test("formatCwdForFooter collapses home directory", () => {
  const home = "/home/user";
  assert.equal(formatCwdForFooter("/home/user/project", home), "~/project");
  assert.equal(formatCwdForFooter("/home/user", home), "~");
  assert.equal(formatCwdForFooter("/var/log", home), "/var/log");
});

test("buildTwoLineFooter strictly produces 2 lines with comprehensive stats and auto status", () => {
  initializeExecutionContext({
    phase: "work",
    autonomy: "auto",
    cwd: "/workspace/demo",
    ledger: "off",
  });
  resetAutoStateForTurn();

  const mockCtx: any = {
    cwd: "/workspace/demo",
    sessionManager: {
      getCwd: () => "/workspace/demo",
      getSessionName: () => "feature-login",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 67000,
              output: 22000,
              cacheRead: 50000,
              cacheWrite: 2000,
              cost: { total: 0.085 },
            },
          },
        },
      ],
    },
    getContextUsage: () => ({
      percent: 3.2,
      contextWindow: 1000000,
    }),
    model: {
      provider: "gptplus-openai",
      id: "deepseek-flash",
      reasoning: true,
    },
  };

  const mockFooterData = {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  };

  const lines = buildTwoLineFooter(
    mockCtx,
    mockTheme,
    mockFooterData,
    140,
    "48.2 t/s",
    true,
    "max",
  );

  // 1. 严格只有 2 行
  assert.equal(lines.length, 2);

  // 2. 第一行包含路径、分支与会话名
  assert.match(lines[0], /\/workspace\/demo \(main\) • feature-login/);

  // 3. 第二行左侧包含全量指标: ↑67k ↓22k R50k W2.0k CH42.0% $0.085 3.2%/1.0M (auto) · 48.2 t/s
  assert.match(lines[1], /↑67k/);
  assert.match(lines[1], /↓22k/);
  assert.match(lines[1], /R50k/);
  assert.match(lines[1], /W2\.0k/);
  assert.match(lines[1], /CH42\.0%/);
  assert.match(lines[1], /\$0\.085/);
  assert.match(lines[1], /3\.2%\/1\.0M \(auto\)/);
  assert.match(lines[1], /48\.2 t\/s/);

  // 4. 第二行右侧包含 AUTO 模式与模型融合，且无 🧠 表情
  assert.match(lines[1], /AUTO \[就绪\] · \(gptplus-openai\) deepseek-flash • max/);
  assert.doesNotMatch(lines[1], /🧠/);
  assert.doesNotMatch(lines[1], /🤖/);
});

test("buildTwoLineFooter reflects intercepted action and termination cleanly without emojis", () => {
  initializeExecutionContext({
    phase: "work",
    autonomy: "auto",
    cwd: "/workspace/demo",
    ledger: "off",
  });
  resetAutoStateForTurn();
  setAutoAction("已拦截: bash");

  const mockCtx: any = {
    cwd: "/workspace/demo",
    sessionManager: {
      getCwd: () => "/workspace/demo",
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 1.0, contextWindow: 128000 }),
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      reasoning: false,
    },
  };

  const mockFooterData = {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  };

  const lines = buildTwoLineFooter(
    mockCtx,
    mockTheme,
    mockFooterData,
    120,
    undefined,
    true,
  );

  assert.equal(lines.length, 2);
  assert.match(lines[1], /WORK · AUTO \[已拦截: bash\] · \(deepseek\) deepseek-chat/);
  assert.doesNotMatch(lines[1], /🧠/);
  assert.doesNotMatch(lines[1], /🤖/);

  // 测试终止状态
  setAutoStopped(true);
  const linesStopped = buildTwoLineFooter(
    mockCtx,
    mockTheme,
    mockFooterData,
    120,
  );
  assert.match(linesStopped[1], /WORK · AUTO \[已终止\] · \(deepseek\) deepseek-chat/);
});

test("buildTwoLineFooter accurately displays WORK · GUARDED, PLAN, CHAT, and WORK · AUTO_ALL", () => {
  const mockCtx: any = {
    cwd: "/workspace/demo",
    sessionManager: {
      getCwd: () => "/workspace/demo",
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 1.0, contextWindow: 128000 }),
    model: { provider: "openai", id: "gpt-4o" },
  };
  const mockFooterData = {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  };

  // 1. WORK · GUARDED (默认常规工作模式)
  initializeExecutionContext({
    phase: "work",
    autonomy: "guarded",
    cwd: "/workspace/demo",
    ledger: "off",
  });
  resetAutoStateForTurn();
  let lines = buildTwoLineFooter(mockCtx, mockTheme, mockFooterData, 120);
  assert.match(lines[1], /WORK · GUARDED · \(openai\) gpt-4o/);

  // 2. PLAN 模式
  setExecutionContext({
    ...getExecutionContext(),
    phase: "plan",
    autonomy: "guarded",
  });
  lines = buildTwoLineFooter(mockCtx, mockTheme, mockFooterData, 120);
  assert.match(lines[1], /PLAN · \(openai\) gpt-4o/);

  // 3. CHAT 模式
  setExecutionContext({
    ...getExecutionContext(),
    phase: "chat",
    autonomy: "guarded",
  });
  lines = buildTwoLineFooter(mockCtx, mockTheme, mockFooterData, 120);
  assert.match(lines[1], /CHAT · \(openai\) gpt-4o/);

  // 4. WORK · AUTO_ALL 模式
  setExecutionContext({
    ...getExecutionContext(),
    phase: "work",
    autonomy: "auto",
    approval: {
      interactive: false,
      preauthorized: true,
      inheritToChildren: true,
      autoAll: true,
    },
  });
  lines = buildTwoLineFooter(mockCtx, mockTheme, mockFooterData, 120);
  assert.match(lines[1], /WORK · AUTO_ALL \[就绪\] · \(openai\) gpt-4o/);
});

test("onAutoStatusChange triggers reactive callback when status changes", () => {
  let called = 0;
  const unsub = onAutoStatusChange(() => {
    called++;
  });

  setAutoAction("审核中: bash");
  assert.equal(called, 1);

  setAutoStopped(true);
  assert.equal(called, 2);

  resetAutoStateForTurn();
  assert.equal(called, 3);

  unsub();
  setAutoAction(undefined);
  assert.equal(called, 3); // 取消订阅后不再触发
});

test("narrow terminal width preserves phase and mode status cleanly", () => {
  initializeExecutionContext({
    phase: "work",
    autonomy: "guarded",
    cwd: "/workspace/demo",
    ledger: "off",
  });
  resetAutoStateForTurn();

  const mockCtx: any = {
    cwd: "/workspace/demo",
    sessionManager: {
      getCwd: () => "/workspace/demo",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 80000, output: 20000, cost: { total: 0.12 } },
          },
        },
      ],
    },
    getContextUsage: () => ({ percent: 65.0, contextWindow: 128000 }),
    model: { provider: "anthropic", id: "claude-3-5-sonnet" },
  };
  const mockFooterData = {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  };

  // 在 65 字符的紧凑终端宽度下，WORK · GUARDED 必须优先被完整展示
  const lines = buildTwoLineFooter(mockCtx, mockTheme, mockFooterData, 65);
  assert.match(lines[1], /WORK · GUARDED/);
});
