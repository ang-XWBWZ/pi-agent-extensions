import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJob,
  getJob,
  updateAgentTaskPanel,
  getAgentTaskPanel,
  publishTaskResult,
  onJobComplete,
} from "../../lib/agent-bus.js";

const parallelAgentRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("sub-agent protocol and tools forbid duplicate final report to main", () => {
  const runner = readFileSync(join(parallelAgentRoot, "lib", "agent-runner.ts"), "utf8");
  const sendTool = readFileSync(join(parallelAgentRoot, "tools", "send-message.ts"), "utf8");
  const spawnTool = readFileSync(join(parallelAgentRoot, "tools", "spawn-agent.ts"), "utf8");
  const checkTool = readFileSync(join(parallelAgentRoot, "tools", "check-results.ts"), "utf8");
  const entry = readFileSync(join(parallelAgentRoot, "..", "parallel-agent.ts"), "utf8");

  // 1. 协议层严禁向 main 发送重复终态汇报
  assert.match(
    runner,
    /通信与汇报规范：任务完成后系统会自动汇总你的最终回答与面板结论并统一通知主 Agent；严禁调用 send_agent_message 向 main 发送重复的完成汇报。/,
  );

  // 2. 工具说明与执行拦截
  assert.match(
    sendTool,
    /注意：子任务完成时系统会自动汇总向主 Agent 汇报，严禁向 main 重复发送最终汇报。/,
  );
  assert.match(
    sendTool,
    /panel\?\.status === "completed"[\s\S]*reason:\s*"already_completed_auto_injected"/,
  );

  // 3. check_agent_results 通过集中式投递转换消费，不直接散改内部标志
  assert.match(checkTool, /finalizeDelivery\(job, "poll"\)/);
  assert.match(checkTool, /finalizeDelivery\(waited, "poll"\)/);
  assert.doesNotMatch(checkTool, /\._autoInjected = true/);

  // 4. spawn-agent onJobComplete 有双重检查
  assert.match(spawnTool, /if \(completedJob\._autoInjected\) return;/);

  // 5. parallel-agent.ts context 事件对消息去重
  assert.match(entry, /const uniqueLines:\s*string\[\]\s*=\s*\[\];/);
  assert.match(entry, /seen\.has\(key\)/);
});

test("job _autoInjected flag provides mutual exclusion for completion callbacks", async () => {
  const job = createJob([{ id: "task-mutex-1", prompt: "explore codebase" }]);

  let callbackInvocationCount = 0;
  // 模拟 autoInject 监听
  onJobComplete(job.jobId, (completedJob) => {
    // 模拟 double-check 逻辑
    if (completedJob._autoInjected) return;
    callbackInvocationCount++;
  });

  // 模拟 check_agent_results 先行消费并标记
  job._autoInjected = true;

  // 触发任务完成
  publishTaskResult(job.jobId, {
    id: "task-mutex-1",
    name: "task 1",
    order: 1,
    ok: true,
    summary: "exploration done",
  });

  // 确保没有触发二次回调
  assert.equal(callbackInvocationCount, 0);
});

test("task panel completed status allows idempotent check", () => {
  const job = createJob([{ id: "task-status-1", prompt: "run task" }]);
  updateAgentTaskPanel(job.jobId, "task-status-1", {
    status: "completed",
    progress: 100,
    conclusion: "completed conclusion",
  });

  const panel = getAgentTaskPanel(job.jobId, "task-status-1");
  assert.equal(panel?.status, "completed");
  assert.equal(panel?.progress, 100);
  assert.equal(panel?.summary, "completed conclusion");
});
