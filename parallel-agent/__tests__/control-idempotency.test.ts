import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getAgentTaskPanel,
  getInstance,
  isTaskCancelled,
  killAgent,
  killJob,
  pauseAgent,
  registerInstance,
  resumeAgent,
  unregisterInstance,
} from "../../lib/agent-bus.js";

function fakeInstance(jobId: string, taskId: string, hooks: Record<string, unknown>) {
  return {
    jobId,
    taskId,
    name: "t",
    session: {
      state: { messages: [] },
      abort: async () => undefined,
      dispose: () => undefined,
      sendUserMessage: async () => undefined,
      steer: async () => undefined,
    },
    status: "running",
    detailedStatus: "running",
    toolHistory: [],
    lastActivityAt: Date.now(),
    autoContinue: false,
    autoContinueDelay: 30,
    startedAt: Date.now(),
    promptLength: 1,
    outputLength: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cost: 0,
    contextPercent: null,
    contextWindow: 0,
    ...hooks,
  };
}

test("C02/C07: pause freezes timers, resume rebuilds, both are idempotent", async () => {
  const job = createJob([{ id: "t", prompt: "p" }]);
  let paused = 0;
  let resumed = 0;
  const inst = fakeInstance(job.jobId, "t", {
    _pauseTimers: () => { paused++; },
    _resumeTimers: () => { resumed++; },
    _abortExternally: () => undefined,
  });
  registerInstance(inst as never);

  assert.equal(await pauseAgent(job.jobId, "t"), true);
  assert.equal(paused, 1);
  assert.equal(inst.status, "paused");

  // 重复 pause 幂等：状态不变，且不重复冻结
  assert.equal(await pauseAgent(job.jobId, "t"), true);
  assert.equal(paused, 1);

  assert.equal(await resumeAgent(job.jobId, "t"), true);
  assert.equal(resumed, 1);
  assert.equal(inst.status, "running");

  // 非暂停态 resume 是明确的状态不适用
  assert.equal(await resumeAgent(job.jobId, "t"), false);
  assert.equal(resumed, 1);

  unregisterInstance(job.jobId, "t");
});

test("G02: killing a queued task cancels it without an SDK session", async () => {
  const job = createJob([{ id: "run", prompt: "r" }, { id: "queued", prompt: "q" }]);
  registerInstance(fakeInstance(job.jobId, "run", {}) as never);

  assert.equal(isTaskCancelled(job.jobId, "queued"), false);
  assert.equal(await killAgent(job.jobId, "queued"), true);
  assert.equal(isTaskCancelled(job.jobId, "queued"), true);
  assert.equal(job.terminalTaskIds?.has("queued"), true);
  assert.equal(getAgentTaskPanel(job.jobId, "queued")?.status, "interrupted");

  // killJob 取消所有尚未启动的排队任务
  const job2 = createJob([{ id: "q1", prompt: "1" }, { id: "q2", prompt: "2" }]);
  assert.equal(await killJob(job2.jobId), 2);
  assert.equal(job2.terminalTaskIds?.has("q1"), true);
  assert.equal(job2.terminalTaskIds?.has("q2"), true);

  unregisterInstance(job.jobId, "run");
});

test("C07: kill is idempotent once the task is terminal", async () => {
  const job = createJob([{ id: "t-k", prompt: "p" }]);
  const inst = fakeInstance(job.jobId, "t-k", { _dispose: undefined });
  registerInstance(inst as never);

  assert.equal(await killAgent(job.jobId, "t-k"), true);
  assert.equal(getInstance(job.jobId, "t-k"), undefined);
  assert.equal(job.terminalTaskIds?.has("t-k"), true);

  // 已终态：再次 kill 幂等成功
  assert.equal(await killAgent(job.jobId, "t-k"), true);
  // 未知任务：明确失败
  assert.equal(await killAgent(job.jobId, "no-such"), false);
});
