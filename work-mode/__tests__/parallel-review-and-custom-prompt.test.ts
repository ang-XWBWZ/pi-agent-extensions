import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewWithAutoFlash,
  setAutoCustomPrompt,
  getAutoCustomPrompt,
  clearReviewCache,
} from "../auto-flash.js";
import { confirmAndRemember } from "../confirm-dialog.js";

test("setAutoCustomPrompt supports in-memory session override and immediate effect", () => {
  clearReviewCache();
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = { data: {}, mtime: 0 };
  try {
    setAutoCustomPrompt("临时指令：放行所有的 npm 脚本", false);
    assert.equal(getAutoCustomPrompt(), "临时指令：放行所有的 npm 脚本");

    setAutoCustomPrompt(undefined, false);
    assert.equal(getAutoCustomPrompt(), undefined);
  } finally {
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("reviewWithAutoFlash injects customPrompt as top-authority rule in systemPrompt", async () => {
  clearReviewCache();
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "mock", model: "reviewer" },
    },
    mtime: 0,
  };

  let capturedSystemPrompt = "";
  let capturedUserPrompt = "";

  const model = { provider: "mock", id: "reviewer", api: "openai-tolerant" };
  const provider = {
    streamSimple: (_m: unknown, context: any) => {
      // streamSimple 接收归一化后的 TranscriptContext：系统提示词是消息列表首条的
      // system 消息，顶层没有 systemPrompt 字段。
      const messages: Array<{ role?: string; content?: unknown }> = context.messages ?? [];
      const systemMessage = messages.find((message) => message.role === "system");
      const userMessage = messages.find((message) => message.role === "user");
      capturedSystemPrompt =
        typeof systemMessage?.content === "string" ? systemMessage.content : "";
      capturedUserPrompt =
        typeof userMessage?.content === "string" ? userMessage.content : "";
      return {
        result: async () => ({
          content: [{ type: "text", text: '{"allow":true,"reason":"依据用户特许指令放行"}' }],
        }),
      };
    },
  };

  const fakeCtx = {
    cwd: "/workspace",
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {
      find: () => model,
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
    },
  } as any;

  try {
    setAutoCustomPrompt("放行所有读取 /opt/data 的请求", false);

    const result = await reviewWithAutoFlash(fakeCtx, {
      command: "ls -la /opt/data",
      toolName: "bash",
      cwd: "/workspace",
      effect: "read",
    });

    assert.equal(result.allow, true);
    // 验证置顶注入到 systemPrompt
    assert.match(capturedSystemPrompt, /【用户特许审核指令（最高裁决权）】/);
    assert.match(capturedSystemPrompt, /放行所有读取 \/opt\/data 的请求/);
    assert.match(capturedSystemPrompt, /必须优先严格遵循用户的此项自定义指令做出审批/);

    // 验证 user prompt 中的最高裁量原则
    assert.match(capturedUserPrompt, /【最高裁量原则】: 必须优先遵守【用户特许审核指令】/);
  } finally {
    setAutoCustomPrompt(undefined, false);
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("reviewWithAutoFlash deduplicates concurrent in-flight requests and uses review cache", async () => {
  clearReviewCache();
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_settings_cache;
  globals.__pi_settings_cache = {
    data: {
      autoFlashModel: { provider: "mock", model: "reviewer" },
    },
    mtime: 0,
  };

  let providerCallCount = 0;
  const model = { provider: "mock", id: "reviewer", api: "openai-tolerant" };
  const provider = {
    streamSimple: () => {
      providerCallCount++;
      return {
        result: async () => {
          // 模拟稍微耗时的审核
          await new Promise((r) => setTimeout(r, 20));
          return {
            content: [{ type: "text", text: '{"allow":true,"reason":"验证通过"}' }],
          };
        },
      };
    },
  };

  const fakeCtx = {
    cwd: "/workspace",
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {
      find: () => model,
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
    },
  } as any;

  try {
    // 并发发起两个相同的审核请求
    const req = {
      command: "git status",
      toolName: "bash",
      cwd: "/workspace",
      effect: "read",
    };

    const [res1, res2] = await Promise.all([
      reviewWithAutoFlash(fakeCtx, req),
      reviewWithAutoFlash(fakeCtx, req),
    ]);

    assert.equal(res1.allow, true);
    assert.equal(res2.allow, true);
    // In-flight 合并：并发调用时底层 provider 只被调用了 1 次
    assert.equal(providerCallCount, 1);

    // 紧接着发起的第三次请求命中短期缓存
    const res3 = await reviewWithAutoFlash(fakeCtx, req);
    assert.equal(res3.allow, true);
    assert.match(res3.reason, /并发审批复用/);
    assert.equal(providerCallCount, 1);
  } finally {
    clearReviewCache();
    if (previous === undefined) delete globals.__pi_settings_cache;
    else globals.__pi_settings_cache = previous;
  }
});

test("confirmAndRemember shares allowlist globally across multiple sub-agents", async () => {
  const allowlistA = new Set<string>();
  const allowlistB = new Set<string>();

  const fakeCtx = {
    ui: {
      notify: () => {},
      select: async () => "始终允许同类命令",
    },
  } as any;

  // 1. Agent A 批准并记住命令
  const resA = await confirmAndRemember(
    fakeCtx,
    allowlistA,
    "command",
    "执行测试",
    "npm test 'auth'",
    "单元测试",
    false,
  );
  assert.equal(resA, "dialog");

  // 2. 并行的 Agent B（不同实例、全新 allowlistB）对相同类型的命令应直接命中全局白名单并静默放行 (silent)
  const resB = await confirmAndRemember(
    fakeCtx,
    allowlistB,
    "command",
    "执行测试",
    "npm test 'user'",
    "子任务测试",
    true,
  );
  assert.equal(resB, "silent");
});
