import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupJobs,
  createJob,
  getAgentTaskPanel,
  getJob,
  isPastWallClock,
  markOwnerUnavailable,
  publishWallClockExceeded,
  updateAgentTaskPanel,
} from "../../lib/agent-bus.js";
import { runBounded } from "../lib/bounded-queue.ts";

test("G07: panel progress is monotonic and records a rollback note", () => {
  const job = createJob([{ id: "t-progress", prompt: "p" }]);
  updateAgentTaskPanel(job.jobId, "t-progress", { progress: 60 });
  assert.equal(getAgentTaskPanel(job.jobId, "t-progress")?.progress, 60);

  updateAgentTaskPanel(job.jobId, "t-progress", { progress: 45 });
  const panel = getAgentTaskPanel(job.jobId, "t-progress");
  assert.equal(panel?.progress, 60);
  assert.match(panel?.notes.at(-1)?.text ?? "", /进度回退请求 45% 被忽略/);
});

test("G06: terminal jobs beyond the retention cap are evicted from memory", () => {
  const jobs = Array.from({ length: 4 }, (_, i) => {
    const job = createJob([{ id: `t${i}`, prompt: "p" }]);
    job.status = "complete";
    job.finishedAt = 1_000 + i;
    return job;
  });

  cleanupJobs(Number.MAX_SAFE_INTEGER, 2);

  assert.equal(getJob(jobs[0].jobId), undefined);
  assert.equal(getJob(jobs[1].jobId), undefined);
  assert.ok(getJob(jobs[2].jobId));
  assert.ok(getJob(jobs[3].jobId));
  assert.equal(getAgentTaskPanel(jobs[0].jobId, "t0"), undefined);
});

test("C03: optional wall clock marks queued tasks as timed out", () => {
  const job = createJob([{ id: "wc", prompt: "p" }]);
  assert.equal(isPastWallClock(job.jobId), false);
  job.wallClockSeconds = 1;
  job.wallClockDeadline = Date.now() - 1;
  assert.equal(isPastWallClock(job.jobId), true);

  assert.equal(
    publishWallClockExceeded(job.jobId, { id: "wc", prompt: "p" }, 1),
    true,
  );
  assert.equal(job.results[0]?.outcome, "timed_out");
  assert.match(job.results[0]?.terminalReason ?? "", /总墙钟上限/);
});

test("C08: owner unavailable is recorded per owner without killing tasks", () => {
  const job = createJob([{ id: "o1", prompt: "p" }], "owner-1");
  const other = createJob([{ id: "o2", prompt: "p" }], "owner-2");

  assert.equal(markOwnerUnavailable("owner-1"), 1);
  assert.ok(job.ownerUnavailableAt);
  assert.equal(other.ownerUnavailableAt, undefined);
  // 任务状态不受影响，也不重复计数
  assert.equal(job.status, "dispatched");
  assert.equal(markOwnerUnavailable("owner-1"), 0);
});

test("G08: scheduler drains a large backlog within the concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  let processed = 0;
  const items = Array.from({ length: 200 }, (_, i) => i);

  await runBounded(items, {
    limit: 8,
    worker: async () => {
      active++;
      peak = Math.max(peak, active);
      processed++;
      active--;
    },
  });

  assert.equal(processed, 200);
  assert.ok(peak <= 8, `peak ${peak} exceeded bound`);
});
