import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildContinuityAnchor,
  buildRequirementsCheckpoint,
  REQUIREMENTS_CHECKPOINT_ENTRY,
  REQUIREMENTS_CONTINUITY_MARKER,
  setupRequirementsContinuity,
} from "../requirements-continuity.js";

function contract(status = "accepted") {
  return {
    status,
    objective: "让自定义 provider 的上下文压缩稳定可控",
    scope: ["修正 token 统计", "保留需求和验证状态"],
    outOfScope: ["修改 Pi 内核"],
    constraints: ["不新增压缩触发点"],
    assumptions: ["Pi 继续生成通用摘要"],
    acceptance: ["压缩后仍能继续当前计划", "npm test 通过"],
    risks: ["网关 total_tokens 可能包含预留输出"],
    workContract: "只修改扩展层；apiKey=very-secret-value 不得进入持久状态。",
  };
}

function activePlan() {
  return {
    steps: [
      { id: 1, text: "定位压缩阈值", status: "done", evidence: "已确认 native reserveTokens" },
      { id: 2, text: "实现需求连续性", status: "current" },
    ],
    fullText: "ignored by checkpoint",
    completed: false,
  };
}

function fixtureEntries() {
  return [
    { type: "custom", customType: "work-contract-state", data: contract() },
    { type: "custom", customType: "work-plan-state", data: activePlan() },
    {
      type: "custom",
      customType: "work-audit",
      data: {
        kind: "tool_finished",
        toolName: "powershell",
        target: "npm test",
        result: "all tests passed",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "edit", arguments: { path: "extensions/provider-manager.ts" } },
        ],
      },
    },
  ];
}

test("requirements checkpoint retains contract, active plan, files, decisions, and evidence", () => {
  const checkpoint = buildRequirementsCheckpoint(fixtureEntries(), {
    tokensBefore: 223_232,
    fileOps: {
      read: new Set(["README.md"]),
      written: new Set<string>(),
      edited: new Set(["extensions/work-mode.ts"]),
    },
    messagesToSummarize: [
      { role: "user", content: "必须保持旧 provider 兼容，验收条件是 npm test。" },
    ],
  });

  assert.ok(checkpoint);
  assert.equal(checkpoint.tokensBefore, 223_232);
  assert.equal(checkpoint.contract?.objective, "让自定义 provider 的上下文压缩稳定可控");
  assert.equal(checkpoint.plan[1]?.status, "current");
  assert.deepEqual(checkpoint.modifiedFiles, ["extensions/work-mode.ts", "extensions/provider-manager.ts"]);
  assert.deepEqual(checkpoint.readFiles, ["README.md"]);
  assert.match(checkpoint.validation.join("\n"), /npm test/);
  assert.match(checkpoint.decisions.join("\n"), /必须保持旧 provider 兼容/);

  const anchor = buildContinuityAnchor(checkpoint);
  assert.ok(anchor.startsWith(REQUIREMENTS_CONTINUITY_MARKER));
  assert.match(anchor, /验收标准/);
  assert.match(anchor, /执行计划/);
  assert.match(anchor, /extensions\/provider-manager\.ts/);
  assert.match(anchor, /apiKey=\[redacted\]/);
  assert.doesNotMatch(anchor, /very-secret-value/);
  assert.ok(anchor.length <= 9_000);
});

test("the latest durable checkpoint is used only when there is no live plan state", () => {
  const first = buildRequirementsCheckpoint(fixtureEntries(), {});
  assert.ok(first);

  const next = buildRequirementsCheckpoint([
    { type: "custom", customType: REQUIREMENTS_CHECKPOINT_ENTRY, data: first },
  ], {});

  assert.ok(next);
  assert.deepEqual(next.plan, first.plan);
});

test("an explicitly cleared contract or plan is never revived by an old checkpoint", () => {
  const first = buildRequirementsCheckpoint(fixtureEntries(), {});
  assert.ok(first);

  const cleared = buildRequirementsCheckpoint([
    { type: "custom", customType: REQUIREMENTS_CHECKPOINT_ENTRY, data: first },
    {
      type: "custom",
      customType: "work-contract-state",
      data: { status: "empty", objective: "", scope: [], acceptance: [] },
    },
    { type: "custom", customType: "work-plan-state", data: { steps: [] } },
  ], {});

  assert.equal(cleared, undefined);
});

test("the hook records a checkpoint only after a successful Pi compaction and never overrides it", () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  setupRequirementsContinuity(pi);
  const before = handlers.get("session_before_compact")?.[0];
  const after = handlers.get("session_compact")?.[0];
  const context = handlers.get("context")?.[0];
  assert.ok(before);
  assert.ok(after);
  assert.ok(context);

  const result = before(
    { branchEntries: fixtureEntries(), preparation: { messagesToSummarize: [] } },
    {},
  );
  assert.equal(result, undefined);
  assert.equal(appended.length, 0);

  after({}, { ui: { setStatus() {} } });
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.type, REQUIREMENTS_CHECKPOINT_ENTRY);

  const injected = context(
    {
      messages: [
        { role: "user", content: "继续实现" },
        { role: "user", content: `${REQUIREMENTS_CONTINUITY_MARKER}\nold anchor` },
      ],
    },
    { sessionManager: { getBranch: () => fixtureEntries() } },
  ) as { messages?: Array<{ role: string; content: unknown }> } | undefined;
  assert.ok(injected?.messages);
  const anchors = injected.messages.filter(
    (message) => typeof message.content === "string" && message.content.startsWith(REQUIREMENTS_CONTINUITY_MARKER),
  );
  assert.equal(anchors.length, 1);
  assert.match(String(anchors[0]?.content), /已接受的需求契约/);
});

test("a session without a contract or plan does not create an anchor", () => {
  assert.equal(buildRequirementsCheckpoint([], {}), undefined);
});
