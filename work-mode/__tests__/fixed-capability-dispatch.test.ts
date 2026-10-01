import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { capabilityToolRegistry } from "../../lib/capability-dispatch.js";
import { registerCapability, BASELINE_CORE_TOOLS } from "../../lib/capability-router.js";
import { getExecutionContext, setExecutionContext, withSessionScope, ensureSessionRuntime } from "../../lib/execution-context.js";
import { getSessionRuntime, getSessionRuntimeById } from "../../lib/session-runtime.js";
import { setupCore } from "../core.js";
import { setupPermissionGuard } from "../permission-guard.js";
import { createExtensionRuntime, loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

function harness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const native = new Map<string, any>();
  const activeWrites: string[][] = [];
  const audit: any[] = [];
  const ctx: any = {
    cwd: "/workspace", sessionManager: { getEntries: () => [] },
    ui: { notify: () => {}, setStatus: () => {}, select: async () => { throw new Error("Unexpected confirmation"); } },
  };
  const api = (): any => ({
    on: (name: string, fn: any) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    registerTool: (def: any) => native.set(def.name, def),
    registerCommand: () => {}, appendEntry: (_name: string, entry: any) => audit.push(entry),
    setActiveTools: (names: string[]) => activeWrites.push([...names]),
    getActiveTools: () => activeWrites.at(-1) ?? [],
  });
  const state: any = { phase: "work", isSubAgent: false, planSteps: [], pathAllowlist: new Set(), cmdAllowlist: new Set(), actionAllowlist: new Set() };
  let executions = 0;
  const operationPi = api();
  const register = (name: string, capability = "fixed_probe") => capabilityToolRegistry(operationPi, capability).registerTool({
    name, label: name, description: "Probe operation", parameters: Type.Object({ message: Type.String(), path: Type.Optional(Type.String()) }),
    execute: async (_id, input, _signal, _update, callCtx) => {
      executions++;
      return { content: [{ type: "text", text: input.message }], details: { session: getExecutionContext().sessionId, manager: callCtx.sessionManager === ctx.sessionManager } };
    },
  });
  registerCapability({ id: "fixed_probe", name: "Probe", summary: "Probe", keywords: [], phases: ["work", "plan"], tools: ["update_agent_task", "long_attention_clear_ps", "long_attention_add_ps"], usageDoc: "Probe guide" });
  register("update_agent_task");
  register("long_attention_clear_ps");
  register("long_attention_add_ps");
  const pi = api();
  setupCore(pi, state, { resetForNewTurn: () => {} });
  setupPermissionGuard(pi, state, { getCurrentStepIndex: () => -1 });
  const emit = async (name: string, event: any) => {
    for (const fn of handlers.get(name) ?? []) { const result = await fn(event, ctx); if (result?.block) return result; }
  };
  const load = async () => native.get("load_capability").execute("load", { capability: "fixed_probe" }, undefined, undefined, ctx);
  const invoke = async (id: string, args: any) => {
    const result = await emit("tool_call", { toolName: "call_capability", toolCallId: id, input: args });
    if (result?.block) return result;
    return native.get("call_capability").execute(id, args, undefined, undefined, ctx);
  };
  return { ctx, native, state, activeWrites, audit, emit, load, invoke, register, executions: () => executions };
}

test("fixed transport loads schemas at the tail and executes only reviewed operations", async () => {
  const h = harness();
  await h.emit("session_start", {});
  const args = { capability: "fixed_probe", operation: "update_agent_task", arguments: { message: "checked" } };
  assert.equal((await h.invoke("before-load", args)).block, true);
  const loaded = await h.load();
  assert.match(loaded.content[0].text, /Arguments JSON Schema/);
  assert.equal(h.native.has("update_agent_task"), false);
  assert.deepEqual(h.activeWrites, [BASELINE_CORE_TOOLS]);
  const result = await h.invoke("after-load", args);
  assert.equal(result.content[0].text, "checked");
  assert.equal(result.details.session, getExecutionContext(h.ctx.sessionManager).sessionId);
  assert.equal(result.details.manager, true);
  assert.equal(h.audit.find((entry) => entry.kind === "tool_started")?.toolName, "update_agent_task");
  await assert.rejects(() => h.native.get("call_capability").execute("bypass", args, undefined, undefined, h.ctx), /permission guard/);
  assert.equal((await h.invoke("bad-schema", { ...args, arguments: { message: {} } })).block, true);
  const runtime = getSessionRuntime(h.ctx.sessionManager)!;
  runtime.allowedTools = new Set(["call_capability"]);
  assert.equal((await h.invoke("ceiling", args)).block, true);
  assert.equal(h.executions(), 1);
});

test("PLAN and protected-path policy use the real operation, not the gateway name", async () => {
  const h = harness();
  await h.emit("session_start", {});
  await h.load();
  h.state.phase = "plan";
  setExecutionContext({ ...getExecutionContext(h.ctx.sessionManager), phase: "plan" }, h.ctx.sessionManager);
  const args = { capability: "fixed_probe", operation: "long_attention_clear_ps", arguments: { message: "clear" } };
  assert.equal((await h.invoke("destructive-in-plan", args)).block, true);
  h.state.phase = "work";
  const current = getExecutionContext(h.ctx.sessionManager);
  setExecutionContext({ ...current, phase: "work", autonomy: "auto", approval: { ...current.approval, autoAll: true } }, h.ctx.sessionManager);
  assert.equal((await h.invoke("protected", { ...args, operation: "long_attention_add_ps", arguments: { message: "write", path: "/workspace/.git/config" } })).block, true);
  assert.equal(h.executions(), 0);
});

test("approval is one-shot and bound to arguments; sibling sessions cannot reuse implementations", async () => {
  const a = harness();
  const b = harness();
  await a.emit("session_start", {}); await b.emit("session_start", {});
  await a.load(); await b.load();
  const args = { capability: "fixed_probe", operation: "update_agent_task", arguments: { message: "a" } };
  await a.emit("tool_call", { toolName: "call_capability", toolCallId: "approved", input: args });
  await assert.rejects(() => a.native.get("call_capability").execute("approved", { ...args, arguments: { message: "changed" } }, undefined, undefined, a.ctx), /permission guard/);
  await a.invoke("run-a", args);
  await assert.rejects(() => a.native.get("call_capability").execute("run-a", args, undefined, undefined, a.ctx), /permission guard/);
  assert.equal(a.executions(), 1); assert.equal(b.executions(), 0);
  await b.invoke("run-b", args);
  assert.equal(a.executions(), 1); assert.equal(b.executions(), 1);
});

test("actual OpenAI-compatible request tools and system remain byte-identical after loads, dynamic registration and phase changes", async () => {
  const h = harness();
  await h.emit("session_start", {});
  const tools = [...h.native.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  const capture = async (messages: any[]) => {
    let payload: any;
    const model: any = { id: "cache-probe", name: "Cache probe", provider: "probe", api: "openai-completions", baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await completionsStream(model, normalizeContext({ systemPrompt: "Fixed system", tools, messages }), {
      apiKey: "offline-test", onPayload: (value) => { payload = value; throw new Error("Captured before network"); },
    }).result();
    assert.ok(payload, "capture must reach the real adapter's final payload");
    return payload;
  };
  const history: any[] = [{ role: "user", content: "Initial task", timestamp: 0 }];
  const before = await capture(history);
  const loaded = await h.load();
  await h.load();
  h.register("dynamic_mcp_probe", "mcp");
  h.state.phase = "plan";
  const after = await capture([...history, { role: "user", content: loaded.content[0].text, timestamp: 1 }]);
  assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools));
  assert.equal(JSON.stringify(after.messages.slice(0, before.messages.length)), JSON.stringify(before.messages));
  assert.deepEqual(h.activeWrites, [BASELINE_CORE_TOOLS]);
  assert.equal(h.native.has("dynamic_mcp_probe"), false);
  const event = { systemPromptOptions: { sections: {} } };
  await h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.sections, {});
});

test("runtime identity survives initialization and an unknown nested scope remains guarded", async () => {
  const h = harness();
  const runtime = ensureSessionRuntime(h.ctx.sessionManager);
  await h.emit("session_start", {});
  assert.equal(getExecutionContext(h.ctx.sessionManager).sessionId, runtime.sessionId);
  assert.equal(getSessionRuntimeById(runtime.sessionId), runtime);
  setExecutionContext({ ...getExecutionContext(h.ctx.sessionManager), autonomy: "auto", approval: { interactive: false, preauthorized: true, inheritToChildren: true, autoAll: true } }, h.ctx.sessionManager);
  assert.equal(withSessionScope(h.ctx.sessionManager, () => withSessionScope({}, () => getExecutionContext().approval.autoAll)), false);
});

test("real SDK extension loading shares the session registry across separately loaded modules", async () => {
  const runtime = createExtensionRuntime();
  const mounted: string[][] = [];
  runtime.setActiveTools = (names) => { mounted.push(names); };
  runtime.appendEntry = () => {};
  const loaded = await loadExtensions([
    fileURLToPath(new URL("../../long-attention-ps.ts", import.meta.url)),
    fileURLToPath(new URL("../../work-mode.ts", import.meta.url)),
  ], "/tmp", undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const ctx: any = { cwd: "/tmp", sessionManager: { getEntries: () => [], getBranch: () => [] }, ui: { notify: () => {}, setStatus: () => {} } };
  const emit = async (name: string, event: any) => {
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) {
      const result = await handler(event, ctx) as { block?: boolean } | undefined;
      if (result?.block) return result;
    }
  };
  await emit("session_start", { reason: "switch" });
  const definitions = new Map(loaded.extensions.flatMap((extension) => [...extension.tools].map(([name, tool]) => [name, tool.definition] as const)));
  assert.equal(definitions.has("long_attention_add_ps"), false);
  const load = definitions.get("load_capability")!;
  const call = definitions.get("call_capability")!;
  const result = await load.execute("sdk-load", { capability: "long_attention" }, undefined, undefined, ctx);
  assert.equal((result.details as any).success, true);
  assert.match((result.content[0] as any).text, /Arguments JSON Schema/);
  const args = { capability: "long_attention", operation: "long_attention_add_ps", arguments: { message: "Synthetic SDK integration probe" } };
  const permission = await emit("tool_call", { toolName: "call_capability", toolCallId: "sdk-call", input: args });
  assert.equal(permission?.block, undefined);
  const executed = await call.execute("sdk-call", args, undefined, undefined, ctx);
  assert.ok(executed.content.length > 0);
  assert.deepEqual(mounted, [BASELINE_CORE_TOOLS]);
  await emit("session_shutdown", {});
});
