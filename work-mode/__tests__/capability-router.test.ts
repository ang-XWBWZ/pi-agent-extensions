import test from "node:test";
import assert from "node:assert/strict";
import {
  registerCapability,
  getRegisteredCapabilities,
  getCapability,
  findCapabilityByTool,
  isCapabilityActive,
  resetActivatedCapabilities,
  formatImmutableCapabilityIndex,
  formatFullCapabilityCatalog,
  activateCapability,
  syncActiveToolsForPhase,
  computeActiveTools,
  createCapabilityActivationState,
  BASELINE_CORE_TOOLS,
  CHAT_CORE_TOOLS,
  PLAN_CORE_TOOLS,
} from "../../lib/capability-router.js";
import { registerCapabilityTool } from "../../lib/capability-tool.js";

test("capability registry stores manifests and looks up by ID and tool name", () => {
  resetActivatedCapabilities();

  registerCapability({
    id: "test_alpha",
    name: "Alpha Capability",
    summary: "Alpha capability for testing purposes.",
    keywords: ["alpha", "test"],
    phases: ["work"],
    tools: ["test_tool_a1", "test_tool_a2"],
    usageDoc: "# Alpha Guide\nUse alpha wisely.",
  });

  registerCapability({
    id: "test_beta",
    name: "Beta Capability",
    summary: "Beta capability for testing purposes.",
    keywords: ["beta", "test"],
    phases: ["work"],
    tools: ["test_tool_b1"],
    usageDoc: "# Beta Guide\nUse beta wisely.",
  });

  const alpha = getCapability("test_alpha");
  assert.ok(alpha);
  assert.equal(alpha.name, "Alpha Capability");

  const byTool1 = findCapabilityByTool("test_tool_a1");
  assert.equal(byTool1?.id, "test_alpha");

  const byTool2 = findCapabilityByTool("test_tool_b1");
  assert.equal(byTool2?.id, "test_beta");

  const missing = findCapabilityByTool("non_existent_tool");
  assert.equal(missing, undefined);
});

test("formatImmutableCapabilityIndex produces deterministic sorted XML block", () => {
  const index = formatImmutableCapabilityIndex();
  assert.match(index, /^<subsystems>\nSpecialized capabilities are loaded on demand via load_capability/);
  assert.match(index, /<\/subsystems>$/);

  // 必须按 id 字典序排序
  const lines = index.split("\n").filter((l) => l.startsWith("- "));
  const ids = lines.map((l) => l.split(":")[0].replace("- ", "").trim());
  const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ids, sortedIds, "Capability index must be deterministically sorted by ID");
});

test("loading a capability never changes the native tools", async () => {
  resetActivatedCapabilities();
  const original = ["read", "bash", "edit", "write"];
  let writes = 0;
  const pi: any = { setActiveTools: () => writes++ };
  const result = await activateCapability("test_alpha", pi, {} as any);
  assert.equal(result.success, true);
  assert.ok(result.doc?.includes("# Alpha Guide"));
  assert.equal(isCapabilityActive("test_alpha"), true);
  await activateCapability("test_alpha", pi, {} as any);
  assert.equal(writes, 0);
});

test("activateCapability gracefully handles non-existent capability", async () => {
  const mockPi: any = {
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const mockCtx: any = {};

  const res = await activateCapability("non_existent_xyz", mockPi, mockCtx);
  assert.equal(res.success, false);
  assert.match(res.message, /未找到指定能力标识符/);
});

test("native tools stay fixed through loads and phase transitions", async () => {
  const activation = createCapabilityActivationState();
  let tools: string[] = [];
  let writes = 0;
  const pi: any = { setActiveTools: (next: string[]) => { tools = next; writes++; } };
  syncActiveToolsForPhase("chat", pi, activation);
  assert.deepEqual(tools, BASELINE_CORE_TOOLS);
  for (const phase of ["plan", "work", "chat", "work"] as const) {
    if (phase === "work") await activateCapability("test_alpha", pi, {} as any, phase, activation);
    syncActiveToolsForPhase(phase, pi, activation);
    assert.deepEqual(tools, BASELINE_CORE_TOOLS);
  }
  assert.equal(writes, 1);
  assert.equal(tools.includes("test_tool_a1"), false);
});

test("load_capability tool executes and returns usageDoc in tool_result", async () => {
  let registeredToolDef: any = null;
  const mockPi: any = {
    registerTool: (def: any) => {
      registeredToolDef = def;
    },
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => {},
  };

  registerCapabilityTool(mockPi);
  assert.ok(registeredToolDef);
  assert.equal(registeredToolDef.name, "load_capability");

  // 验证无 promptGuidelines 与 promptSnippet，保护缓存
  assert.equal(registeredToolDef.promptGuidelines, undefined);
  assert.equal(registeredToolDef.promptSnippet, undefined);

  // 执行 load_capability
  const result = await registeredToolDef.execute(
    "call_123",
    { capability: "test_alpha" },
    undefined,
    undefined,
    {},
  );
  assert.ok(result.content);
  assert.match(result.content[0].text, /能力 \[Alpha Capability\] 激活成功/);
  assert.match(result.content[0].text, /# Alpha Guide/);
});

test("formatFullCapabilityCatalog lists baseline tools and detailed capability tool descriptions", () => {
  const catalog = formatFullCapabilityCatalog();
  assert.match(catalog, /系统能力与工具功能清单 \(Capability Catalog\)/);
  assert.match(catalog, /【常驻核心基础工具 \(Baseline Core Tools\)】/);
  assert.match(catalog, /manage_plan/);
  assert.match(catalog, /load_capability/);
  assert.match(catalog, /【可用进阶能力清单/);
  assert.match(catalog, /test_alpha/);
  assert.match(catalog, /包含工具与具体用途/);
});

test("load_capability action=list or empty parameter returns full catalog", async () => {
  let registeredToolDef: any = null;
  const mockPi: any = {
    registerTool: (def: any) => {
      registeredToolDef = def;
    },
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => {},
  };

  registerCapabilityTool(mockPi);

  // 1. action="list"
  const listRes = await registeredToolDef.execute("call_list", { action: "list" }, undefined, undefined, {});
  assert.match(listRes.content[0].text, /系统能力与工具功能清单/);
  assert.equal(listRes.details.action, "list");

  // 2. 空参数
  const emptyRes = await registeredToolDef.execute("call_empty", {}, undefined, undefined, {});
  assert.match(emptyRes.content[0].text, /系统能力与工具功能清单/);

  // 3. 未知能力 ID：错误提示同时包含全量清单，方便 AI 重新自选
  const unknownRes = await registeredToolDef.execute("call_unknown", { capability: "unknown_xyz" }, undefined, undefined, {});
  assert.match(unknownRes.content[0].text, /未找到指定能力标识符: "unknown_xyz"/);
  assert.match(unknownRes.content[0].text, /系统能力与工具功能清单/);
});

test("computeActiveTools correctly projects capabilities declaring PLAN phase into PLAN", () => {
  registerCapability({
    id: "test_plan_cap",
    name: "Plan Cap",
    summary: "Plan enabled capability",
    keywords: ["plan"],
    phases: ["plan", "work"],
    tools: ["plan_tool_1", "plan_tool_2"],
    usageDoc: "Plan doc",
  });

  registerCapability({
    id: "test_work_only_cap",
    name: "Work Only Cap",
    summary: "Work only capability",
    keywords: ["work"],
    phases: ["work"],
    tools: ["work_only_tool"],
    usageDoc: "Work doc",
  });

  const session = createCapabilityActivationState();
  session.activated.add("test_plan_cap");
  session.activated.add("test_work_only_cap");

  const planTools = computeActiveTools("plan", session);
  assert.ok(planTools.includes("load_capability"), "PLAN must include load_capability");
  assert.ok(planTools.includes("plan_tool_1"), "PLAN must project plan-allowed capabilities");
  assert.ok(planTools.includes("plan_tool_2"), "PLAN must project plan-allowed capabilities");
  assert.ok(!planTools.includes("work_only_tool"), "PLAN must NOT include work-only capabilities");

  const workTools = computeActiveTools("work", session);
  assert.ok(workTools.includes("plan_tool_1"), "WORK should include both");
  assert.ok(workTools.includes("work_only_tool"), "WORK should include work-only tool");
});

test("session activation isolation prevents capability state leaking across sessions", () => {
  const sessionA = createCapabilityActivationState();
  const sessionB = createCapabilityActivationState();

  sessionA.activated.add("test_alpha");
  assert.equal(isCapabilityActive("test_alpha", sessionA), true);
  assert.equal(isCapabilityActive("test_alpha", sessionB), false);
});

test("activateCapability rejects capabilities incompatible with current phase", async () => {
  const mockPi: any = {
    setActiveTools: () => {},
  };
  const session = createCapabilityActivationState();

  // test_work_only_cap only allows ["work"]
  const res = await activateCapability("test_work_only_cap", mockPi, {} as any, "plan", session);
  assert.equal(res.success, false);
  assert.match(res.message, /在当前阶段 \(PLAN\) 不可用/);
  assert.equal(session.activated.has("test_work_only_cap"), false);
});

test("registerCapability clears stale reverse mappings when manifest tools change", () => {
  registerCapability({
    id: "dynamic_cap",
    name: "Dynamic Cap",
    summary: "test",
    keywords: [],
    tools: ["old_tool_1", "shared_tool"],
    usageDoc: "",
  });

  assert.equal(findCapabilityByTool("old_tool_1")?.id, "dynamic_cap");

  // Re-register with old_tool_1 removed
  registerCapability({
    id: "dynamic_cap",
    name: "Dynamic Cap",
    summary: "test",
    keywords: [],
    tools: ["new_tool_2", "shared_tool"],
    usageDoc: "",
  });

  assert.equal(findCapabilityByTool("old_tool_1"), undefined);
  assert.equal(findCapabilityByTool("new_tool_2")?.id, "dynamic_cap");
  assert.equal(findCapabilityByTool("shared_tool")?.id, "dynamic_cap");
});

test("activateCapability deduplicates concurrent onActivate calls via single-flight", async () => {
  let activateCalls = 0;
  registerCapability({
    id: "single_flight_cap",
    name: "Single Flight",
    summary: "test",
    keywords: [],
    phases: ["work"],
    tools: ["sf_tool"],
    usageDoc: "",
    onActivate: async () => {
      activateCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  });

  const session = createCapabilityActivationState();
  const mockPi: any = { setActiveTools: () => {} };

  // Call concurrently
  const [res1, res2] = await Promise.all([
    activateCapability("single_flight_cap", mockPi, {} as any, "work", session),
    activateCapability("single_flight_cap", mockPi, {} as any, "work", session),
  ]);

  assert.equal(res1.success, true);
  assert.equal(res2.success, true);
  assert.equal(activateCalls, 1, "onActivate should be called exactly once despite concurrent activations");
});
