import test from "node:test";
import assert from "node:assert/strict";
import { SpeedTracker } from "../speed-tracker.js";

test("SpeedTracker returns undefined format label before any generation", () => {
  const tracker = new SpeedTracker();
  assert.equal(tracker.getLatestStats(), undefined);
  assert.equal(tracker.formatStatusLabel(), undefined);
});

test("SpeedTracker tracks streaming progress, calculates TTFT and output TPS", async () => {
  const tracker = new SpeedTracker();
  tracker.startMessage("assistant");
  assert.equal(tracker.isStreaming(), true);

  // 模拟首个 token 和增量流式更新
  const live1 = tracker.updateLiveProgress(10);
  assert.ok(live1 === "... t/s" || live1?.endsWith("t/s"));

  // 稍作等待以产生毫秒差
  await new Promise((r) => setTimeout(r, 20));

  tracker.updateLiveProgress(50);

  // 完成并提供权威 usage
  const stats = tracker.finishMessage({
    input: 1000,
    output: 200,
    reasoning: 50,
  });

  assert.ok(stats);
  assert.equal(stats.outputTokens, 200);
  assert.equal(stats.reasoningTokens, 50);
  assert.equal(stats.inputTokens, 1000);
  assert.ok(stats.ttftMs !== undefined && stats.ttftMs >= 0);
  assert.ok(stats.genDurationMs !== undefined && stats.genDurationMs > 0);
  assert.ok(stats.totalDurationMs !== undefined && stats.totalDurationMs >= stats.genDurationMs);
  assert.ok(stats.outputTps > 0);
  assert.ok(stats.totalTps > 0);

  // 验证底栏状态标签：纯文本，只包含速率，无任何表情符号
  const label = tracker.formatStatusLabel();
  assert.ok(label);
  assert.match(label, /^\d+\.\d+\s+t\/s$/);
  assert.doesNotMatch(label, /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u);
});

test("SpeedTracker accumulates session statistics across multiple turns", () => {
  const tracker = new SpeedTracker();

  // 轮次 1
  tracker.startMessage("assistant");
  tracker.recordFirstToken();
  tracker.finishMessage({ output: 100, reasoning: 0 });

  // 轮次 2
  tracker.startMessage("assistant");
  tracker.recordFirstToken();
  tracker.finishMessage({ output: 300, reasoning: 100 });

  const session = tracker.getSessionStats();
  assert.equal(session.totalTurns, 2);
  assert.equal(session.totalOutputTokens, 400);
  assert.equal(session.totalReasoningTokens, 100);
  assert.ok(session.avgOutputTps > 0);
});
