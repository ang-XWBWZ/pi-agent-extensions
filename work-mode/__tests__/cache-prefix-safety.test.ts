import test from "node:test";
import assert from "node:assert/strict";
import { setupCore } from "../core.js";
import {
  getExecutionContext,
  initializeExecutionContext,
  setExecutionContext,
} from "../../lib/execution-context.js";
import { registerCapability } from "../../lib/capability-router.js";

type Handler = (event: any, ctx: any) => any;

function harness() {
  const session: object = {};
  initializeExecutionContext(
    { phase: "work", autonomy: "guarded", cwd: "/workspace", ledger: "off" },
    session,
  );

  const handlers = new Map<string, Handler[]>();
  const mockPi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: () => {},
    setActiveTools: () => {},
    getActiveTools: () => [],
  };
  const mockCtx = {
    cwd: "/workspace",
    sessionManager: session,
    ui: { setStatus: () => {}, notify: () => {} },
  };

  setupCore(mockPi as any, { phase: "work", isSubAgent: false }, {
    resetForNewTurn: () => {},
  });

  const first = (name: string): Handler => {
    const list = handlers.get(name);
    assert.ok(list && list.length > 0, `expected a ${name} handler to be registered`);
    return list[0];
  };

  const setRuntime = (patch: Record<string, unknown>) => {
    setExecutionContext(
      { ...getExecutionContext(session), ...patch } as any,
      session,
    );
  };

  return { first, mockCtx, setRuntime };
}

function directiveOf(messages: any[]): string {
  const last = messages[messages.length - 1];
  assert.equal(typeof last?.content, "string");
  return last.content as string;
}

/** 系统提示词头部的可变部分（结构化 section）快照。 */
async function headSections(handler: Handler, ctx: any) {
  // 事件对象刻意保持宽松类型：本测试断言的是处理器对它的实际写入，
  // 用结构化类型会让 TS 提前判定这些属性不存在。
  const event: any = {
    systemPrompt: "BASE",
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
  const result = await handler(event, ctx);
  return { result, event };
}

test("before_agent_start never replaces the system prompt head", async () => {
  registerCapability({
    id: "cache_prefix_probe",
    name: "Cache Prefix Probe",
    summary: "Probe capability used by the cache-prefix regression test.",
    keywords: ["probe"],
    phases: ["work"],
    tools: ["cache_prefix_probe_tool"],
    usageDoc: "probe",
  });

  const { first, mockCtx } = harness();
  const { result, event } = await headSections(first("before_agent_start"), mockCtx);

  // 不再走 forceSystemPrompt：内核的 sections 差分机制保持可用。
  assert.equal(result, undefined, "before_agent_start must not return a systemPrompt override");
  assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);

  assert.deepEqual(event.systemPromptOptions.sections, {}, "capability catalog must not enter the system head");
});

test("runtime state changes leave the system prompt head byte-identical", async () => {
  registerCapability({
    id: "cache_prefix_probe",
    name: "Cache Prefix Probe",
    summary: "Probe capability used by the cache-prefix regression test.",
    keywords: ["probe"],
    phases: ["work"],
    tools: ["cache_prefix_probe_tool"],
    usageDoc: "probe",
  });

  const { first, mockCtx, setRuntime } = harness();
  const handler = first("before_agent_start");

  setRuntime({
    autonomy: "guarded",
    ledger: "off",
    approval: { interactive: true, preauthorized: false, inheritToChildren: false, autoAll: false },
  });
  const guarded = await headSections(handler, mockCtx);

  setRuntime({
    autonomy: "auto",
    ledger: "work_goal",
    goalId: "goal-1",
    approval: { interactive: false, preauthorized: true, inheritToChildren: true, autoAll: true },
  });
  const auto = await headSections(handler, mockCtx);

  // 授权档位、审计开关、auto_all 全部翻转后，头部 section 必须完全不变。
  assert.deepEqual(auto.event.systemPromptOptions.sections, guarded.event.systemPromptOptions.sections);
  assert.equal(auto.event.systemPromptOptions.forceSystemPrompt, undefined);
  assert.equal(guarded.event.systemPromptOptions.forceSystemPrompt, undefined);
});

test("the runtime directive is injected at the tail and tracks runtime state", async () => {
  const { first, mockCtx, setRuntime } = harness();
  const handler = first("context");

  setRuntime({
    autonomy: "guarded",
    ledger: "off",
    approval: { interactive: true, preauthorized: false, inheritToChildren: false, autoAll: false },
  });
  const history = [{ role: "user", content: "hi" }];
  const guarded = await handler({ messages: history }, mockCtx);

  // 纯尾部追加：既有历史原样保留，且不就地修改传入数组。
  assert.equal(history.length, 1, "the incoming message list must not be mutated in place");
  assert.equal(guarded.messages.length, 2);
  assert.equal(guarded.messages[0].content, "hi");
  const guardedText = directiveOf(guarded.messages);
  assert.ok(guardedText.startsWith("<pi_runtime_directive>"));
  assert.ok(guardedText.includes('approval="ask_risky"'));
  assert.ok(guardedText.includes("Pi workflow runtime:"));

  setRuntime({
    autonomy: "auto",
    ledger: "off",
    approval: { interactive: false, preauthorized: true, inheritToChildren: true, autoAll: false },
  });
  const auto = await handler({ messages: history }, mockCtx);
  const autoText = directiveOf(auto.messages);
  assert.ok(autoText.includes('approval="never_ask"'));
  assert.notEqual(autoText, guardedText, "the directive must reflect the current runtime state");
});
