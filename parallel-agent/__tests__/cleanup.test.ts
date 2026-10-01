import test from "node:test";
import assert from "node:assert/strict";
import { runBoundedCleanup } from "../lib/cleanup.ts";

test("bounded cleanup reports success", async () => {
  const failures: string[] = [];
  const outcome = await runBoundedCleanup("abort", async () => undefined, 100, (m) => failures.push(m));
  assert.equal(outcome, "ok");
  assert.deepEqual(failures, []);
});

test("bounded cleanup reports rejection without throwing", async () => {
  const failures: string[] = [];
  const outcome = await runBoundedCleanup("dispose", async () => { throw new Error("rejected"); }, 100, (m) => failures.push(m));
  assert.equal(outcome, "error");
  assert.deepEqual(failures, ["dispose: rejected"]);
});

test("bounded cleanup times out and does not hang or leak unhandled rejection", async () => {
  const failures: string[] = [];
  const outcome = await runBoundedCleanup(
    "abort",
    () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 50);
    }),
    10,
    (m) => failures.push(m),
  );
  assert.equal(outcome, "timeout");
  assert.deepEqual(failures, ["abort: cleanup_timeout"]);
  // 给迟到的拒绝一个事件循环，确认不会变成 unhandledRejection
  await new Promise((resolve) => setTimeout(resolve, 60));
});
