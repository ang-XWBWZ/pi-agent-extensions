import { captureOperation } from "./support/capability-harness.js";
import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimDelivery,
  createJob,
  publishTaskResult,
} from "../../lib/agent-bus.js";
import { registerCheckResults } from "../tools/check-results.js";

function captureTool() { return captureOperation(registerCheckResults, "check_agent_results"); }

const ctx = {
  ui: { setStatus: () => undefined, notify: () => undefined },
};

test("E03/F06: wait timeout does not consume delivery, auto push can still take over", async () => {
  const job = createJob([{ id: "t1", prompt: "p" }]);
  job.status = "running";
  const tool = captureTool();

  const res = await tool.execute(
    "tc1",
    { jobId: job.jobId, wait: true, timeout: 0.02 },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(res.details.status, "wait_timeout");
  assert.notEqual(job._autoInjected, true);
  assert.notEqual(job.delivery?.state, "delivered");
  assert.notEqual(job.delivery?.state, "claimed_by_poll");

  // 完成后自动推送资格仍在
  job._autoInjectRequested = true;
  assert.equal(claimDelivery(job, "auto"), true);
});

test("E02: terminal poll consumes once, later polls only show the notice", async () => {
  const job = createJob([{ id: "t2", prompt: "p" }]);
  publishTaskResult(job.jobId, {
    id: "t2",
    name: "t2",
    order: 1,
    ok: true,
    summary: "final conclusion",
  });
  const tool = captureTool();

  const first = await tool.execute(
    "tc2a",
    { jobId: job.jobId, wait: false },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(first.details.deliveryState, "delivered");
  assert.match(first.content[0].text, /final conclusion/);

  const second = await tool.execute(
    "tc2b",
    { jobId: job.jobId, wait: false },
    undefined,
    undefined,
    ctx,
  );
  assert.match(second.content[0].text, /已自动推送过/);
});

test("E02: wait that completes during the window returns the full result", async () => {
  const job = createJob([{ id: "t3", prompt: "p" }]);
  job.status = "running";
  const tool = captureTool();

  const promise = tool.execute(
    "tc3",
    { jobId: job.jobId, wait: true, timeout: 2 },
    undefined,
    undefined,
    ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  publishTaskResult(job.jobId, {
    id: "t3",
    name: "t3",
    order: 1,
    ok: true,
    summary: "finished during wait",
  });

  const res = await promise;
  assert.equal(job.delivery?.state, "delivered");
  assert.match(res.content[0].text, /finished during wait/);
});
