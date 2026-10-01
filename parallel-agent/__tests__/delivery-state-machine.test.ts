import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getAgentTaskPanel,
  publishTaskResult,
  publishJobError,
  killJob,
  waitForJob,
  claimDelivery,
  onJobComplete,
} from "../../lib/agent-bus.js";

test("publishTaskResult deduplicates terminal results and counts completed correctly", () => {
  const job = createJob([
    { id: "task-1", prompt: "first" },
    { id: "task-2", prompt: "second" },
  ]);

  publishTaskResult(job.jobId, {
    id: "task-1",
    name: "task 1",
    order: 1,
    ok: true,
    summary: "done 1",
  });
  assert.equal(job.completed, 1);
  assert.equal(job.results.length, 1);

  // Duplicate publishTaskResult for task-1 (e.g. race condition)
  publishTaskResult(job.jobId, {
    id: "task-1",
    name: "task 1",
    order: 1,
    ok: true,
    summary: "done 1 duplicate",
  });
  assert.equal(job.completed, 1);
  assert.equal(job.results.length, 1);

  // Complete second task
  publishTaskResult(job.jobId, {
    id: "task-2",
    name: "task 2",
    order: 2,
    ok: true,
    summary: "done 2",
  });
  assert.equal(job.completed, 2);
  assert.equal(job.results.length, 2);
  assert.equal(job.status, "complete");
});

test("publishTaskResult commits a task terminal state exactly once", () => {
  const job = createJob([{ id: "t-once", prompt: "p" }]);

  const first = publishTaskResult(job.jobId, {
    id: "t-once",
    name: "t",
    order: 1,
    ok: true,
    summary: "done",
  });
  // 竞态/重复结算：第二次必须被拒绝，且不得污染结果
  const second = publishTaskResult(job.jobId, {
    id: "t-once",
    name: "t",
    order: 1,
    ok: false,
    error: "late duplicate",
    errorCode: "runtime",
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(job.results.length, 1);
  assert.equal(job.results[0].ok, true);
  assert.equal(job.completed, 1);
  assert.equal(
    publishTaskResult("missing-job", { id: "x", name: "x", order: 1, ok: true }),
    false,
  );
});

test("terminal projection maps blocked outcome and keeps the last useful conclusion", () => {
  const job = createJob([{ id: "t-blocked", prompt: "p" }]);
  publishTaskResult(job.jobId, {
    id: "t-blocked",
    name: "t",
    order: 1,
    ok: false,
    outcome: "blocked",
    errorCode: "blocked",
    error: "blocked",
    lastUsefulConclusion: "已完成阶段一，等待外部依赖",
  });

  const panel = getAgentTaskPanel(job.jobId, "t-blocked");
  assert.equal(panel?.status, "blocked");
  assert.equal(panel?.summary, "已完成阶段一，等待外部依赖");
});

test("claimDelivery enforces mutual exclusion between poll and auto", () => {
  const job = createJob([{ id: "t1", prompt: "p" }]);

  // Initial state
  assert.equal(job.delivery?.state, "none");

  // poll claims first
  const pollClaimed = claimDelivery(job, "poll");
  assert.equal(pollClaimed, true);
  assert.equal(job.delivery?.state, "claimed_by_poll");
  assert.equal(job._autoInjected, true);

  // auto attempt must fail
  const autoClaimed = claimDelivery(job, "auto");
  assert.equal(autoClaimed, false);
});

test("claimDelivery auto claims and blocks poll", () => {
  const job = createJob([{ id: "t1", prompt: "p" }]);

  // auto claims first
  const autoClaimed = claimDelivery(job, "auto");
  assert.equal(autoClaimed, true);
  assert.equal(job.delivery?.state, "delivering");
  assert.equal(job._autoInjecting, true);

  // poll attempt must fail
  const pollClaimed = claimDelivery(job, "poll");
  assert.equal(pollClaimed, false);
});

test("waitForJob resolves on killJob without timing out", async () => {
  const job = createJob([{ id: "t-kill", prompt: "p" }]);
  job.status = "running";

  const waitPromise = waitForJob(job.jobId, 5000);

  // Trigger killJob
  await killJob(job.jobId);

  const finishedJob = await waitPromise;
  assert.equal(finishedJob.status, "killed");
});

test("onJobComplete triggers on killJob", async () => {
  const job = createJob([{ id: "t-kill-cb", prompt: "p" }]);
  job.status = "running";

  let receivedStatus: string | undefined;
  onJobComplete(job.jobId, (j) => {
    receivedStatus = j.status;
  });

  await killJob(job.jobId);

  // Wait a microtask / tick
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(receivedStatus, "killed");
});
