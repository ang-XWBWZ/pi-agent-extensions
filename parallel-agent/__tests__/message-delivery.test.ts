import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  deliverAgentMessage,
  listMessageReceivers,
  registerInstance,
  unregisterInstance,
} from "../../lib/agent-bus.js";

function fakeInstance(jobId: string, taskId: string, seen: string[]) {
  return {
    jobId,
    taskId,
    name: taskId,
    session: {
      state: { messages: [] },
      steer: async (text: string) => { seen.push(text); },
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
  };
}

test("D01/D04: point-to-point message reaches the instance receiver", () => {
  const job = createJob([{ id: "t-msg", prompt: "p" }]);
  const seen: string[] = [];
  registerInstance(fakeInstance(job.jobId, "t-msg", seen) as never);

  const delivery = deliverAgentMessage("main", "t-msg", "info", "please report");
  assert.equal(delivery.status, "queued");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /please report/);
  assert.match(seen[0], /from main/);

  // 未知目标绝不返回成功
  assert.equal(
    deliverAgentMessage("main", "no-such-target", "info", "x").status,
    "not_found",
  );

  unregisterInstance(job.jobId, "t-msg");
  assert.equal(listMessageReceivers().length, 0);
  assert.equal(
    deliverAgentMessage("main", "t-msg", "info", "after unregister").status,
    "not_found",
  );
});

test("D02: same taskId across jobs is ambiguous unless scoped by jobId", () => {
  const jobA = createJob([{ id: "dup", prompt: "a" }]);
  const jobB = createJob([{ id: "dup", prompt: "b" }]);
  const seenA: string[] = [];
  const seenB: string[] = [];
  registerInstance(fakeInstance(jobA.jobId, "dup", seenA) as never);
  registerInstance(fakeInstance(jobB.jobId, "dup", seenB) as never);

  assert.equal(
    deliverAgentMessage("main", "dup", "info", "global").status,
    "ambiguous_target",
  );
  assert.equal(seenA.length, 0);
  assert.equal(seenB.length, 0);

  const scoped = deliverAgentMessage("main", "dup", "info", "scoped", {
    jobId: jobA.jobId,
  });
  assert.equal(scoped.status, "queued");
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 0);

  const byJob = deliverAgentMessage("main", jobB.jobId, "info", "by job");
  assert.equal(byJob.status, "queued");
  assert.equal(seenB.length, 1);

  unregisterInstance(jobA.jobId, "dup");
  unregisterInstance(jobB.jobId, "dup");
});

test("D03: broadcast is scoped to the sender job domain", () => {
  const jobA = createJob([{ id: "a1", prompt: "a" }]);
  const jobB = createJob([{ id: "b1", prompt: "b" }]);
  const seenA: string[] = [];
  const seenB: string[] = [];
  registerInstance(fakeInstance(jobA.jobId, "a1", seenA) as never);
  registerInstance(fakeInstance(jobB.jobId, "b1", seenB) as never);

  const scoped = deliverAgentMessage("a1", "broadcast", "info", "hi", {
    jobId: jobA.jobId,
  });
  assert.equal(scoped.status, "queued");
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 0);

  // 无任务域限定时才广播到所有活动接收器
  const global = deliverAgentMessage("main", "broadcast", "info", "all");
  assert.equal(global.status, "queued");
  assert.equal(seenA.length, 2);
  assert.equal(seenB.length, 1);

  unregisterInstance(jobA.jobId, "a1");
  unregisterInstance(jobB.jobId, "b1");
});

test("D05: duplicate msgId is deduplicated and main target is queued", () => {
  const job = createJob([{ id: "t-dup", prompt: "p" }]);
  const seen: string[] = [];
  registerInstance(fakeInstance(job.jobId, "t-dup", seen) as never);

  const first = deliverAgentMessage("main", "t-dup", "info", "one", {
    msgId: "m-1",
  });
  const dup = deliverAgentMessage("main", "t-dup", "info", "one", {
    msgId: "m-1",
  });
  assert.equal(first.status, "queued");
  assert.equal(dup.status, "duplicate");
  assert.equal(seen.length, 1);

  assert.equal(
    deliverAgentMessage("sub", "main", "info", "to main").status,
    "queued",
  );

  unregisterInstance(job.jobId, "t-dup");
});
