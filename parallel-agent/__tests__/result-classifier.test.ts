import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTerminal,
  extractFinalAssistantText,
  panelStatusForOutcome,
  readFinalAssistantSignal,
} from "../lib/result-classifier.ts";

test("empty session end without completion evidence is not a success", () => {
  const decision = classifyTerminal({ output: "" });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome, "incomplete");
  assert.equal(decision.errorCode, "empty_result");
  assert.match(decision.terminalReason, /没有有效结论或完成证据/);
});

test("a normal final answer succeeds with the last answer as conclusion", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "stop" },
    output: "  已修复并验证\n",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.outcome, "succeeded");
  assert.equal(decision.lastUsefulConclusion, "已修复并验证");
  assert.equal(decision.errorCode, undefined);
});

test("model error stop reason is a failure, not a silent success", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "error", errorMessage: "upstream 500" },
    output: "partial",
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome, "failed");
  assert.equal(decision.errorCode, "model_error");
  assert.equal(decision.error, "upstream 500");
  assert.equal(decision.lastUsefulConclusion, "partial");
});

test("aborted and length terminations are not success", () => {
  const aborted = classifyTerminal({
    finalAssistant: { stopReason: "aborted" },
    output: "x",
  });
  assert.equal(aborted.outcome, "cancelled");
  assert.equal(aborted.ok, false);

  const truncated = classifyTerminal({
    finalAssistant: { stopReason: "length" },
    output: "x".repeat(10),
  });
  assert.equal(truncated.outcome, "incomplete");
  assert.equal(truncated.errorCode, "incomplete");
  assert.equal(truncated.ok, false);
});

test("agent reported blocked is not overwritten by a successful end", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "stop" },
    panelStatus: "blocked",
    stageReports: [{ status: "blocked", conclusion: "等待外部依赖" }],
    output: "部分产出",
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.errorCode, "blocked");
  assert.equal(decision.lastUsefulConclusion, "等待外部依赖");
});

test("agent reported failed wins over a later completed report", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "stop" },
    panelStatus: "failed",
    stageReports: [
      { status: "completed", conclusion: "阶段一完成" },
      { status: "failed", conclusion: "最终校验失败" },
    ],
  });
  assert.equal(decision.outcome, "failed");
  assert.equal(decision.errorCode, "agent_failed");
  // B04：优先最后一条完成报告，而不是更早的中间结论。
  assert.equal(decision.lastUsefulConclusion, "阶段一完成");
});

test("a silent task with a structured completed report still succeeds", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "stop" },
    panelStatus: "completed",
    stageReports: [{ status: "completed", conclusion: "静默完成：仅提交面板结论" }],
    output: "",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.outcome, "succeeded");
  assert.equal(decision.hasCompletionEvidence, true);
  assert.equal(decision.lastUsefulConclusion, "静默完成：仅提交面板结论");
});

test("last completed report beats an older panel summary", () => {
  const decision = classifyTerminal({
    finalAssistant: { stopReason: "stop" },
    stageReports: [
      { status: "running", conclusion: "中间摘要，不应作为最终结论" },
      { status: "completed", conclusion: "最终结论" },
    ],
    panelSummary: "旧的兼容 summary",
    output: "最后回答",
  });
  assert.equal(decision.lastUsefulConclusion, "最终结论");
});

test("external control has the highest precedence", () => {
  const timeout = classifyTerminal({
    control: "timeout",
    output: "仍有部分产出",
  });
  assert.equal(timeout.outcome, "timed_out");
  assert.equal(timeout.errorCode, "timeout");
  assert.equal(timeout.lastUsefulConclusion, "仍有部分产出");

  assert.equal(classifyTerminal({ control: "killed" }).outcome, "killed");
  assert.equal(classifyTerminal({ control: "disposed" }).outcome, "cancelled");
});

test("runtime exception is a failure that retains partial output", () => {
  const decision = classifyTerminal({
    runtimeError: "boom",
    output: "partial",
  });
  assert.equal(decision.outcome, "failed");
  assert.equal(decision.errorCode, "runtime");
  assert.equal(decision.error, "boom");
  assert.equal(decision.lastUsefulConclusion, "partial");
});

test("checkpoint and cleanup failures always enter the result", () => {
  const decision = classifyTerminal({
    output: "done",
    checkpointError: "disk full",
    cleanupErrors: ["abort rejected", "dispose rejected"],
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.warnings, [
    "checkpoint: disk full",
    "cleanup: abort rejected; dispose rejected",
  ]);
});

test("extractFinalAssistantText keeps only the last assistant text", () => {
  const messages = [
    { role: "assistant", content: "intermediate summary" },
    { role: "user", content: "continue" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "final answer" },
      ],
    },
  ];
  const text = extractFinalAssistantText(messages);
  assert.equal(text, "final answer");
  assert.doesNotMatch(text, /intermediate/);

  const signal = readFinalAssistantSignal([
    { role: "assistant", stopReason: "stop" },
    { role: "user", content: "again" },
    { role: "assistant", stopReason: "error", errorMessage: "bad" },
  ]);
  assert.equal(signal.stopReason, "error");
  assert.equal(signal.errorMessage, "bad");
});

test("panelStatusForOutcome maps every terminal outcome", () => {
  assert.equal(panelStatusForOutcome("succeeded"), "completed");
  assert.equal(panelStatusForOutcome("blocked"), "blocked");
  assert.equal(panelStatusForOutcome("timed_out"), "timed_out");
  assert.equal(panelStatusForOutcome("cancelled"), "interrupted");
  assert.equal(panelStatusForOutcome("killed"), "killed");
  assert.equal(panelStatusForOutcome("failed"), "failed");
  assert.equal(panelStatusForOutcome("incomplete"), "failed");
});

test("agent-runner no longer hard-codes success at agent_end", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runner = readFileSync(join(root, "lib", "agent-runner.ts"), "utf8");

  assert.match(runner, /classifyTerminal\(\{/);
  assert.match(runner, /ok: decision\.ok/);
  // F02：agent_end 不再无条件提交 ok=true。
  assert.doesNotMatch(runner, /ok: true/);
  // SDK 自动重试期间不是终态。
  assert.match(runner, /willRetry/);
});
