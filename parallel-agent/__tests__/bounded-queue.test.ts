import test from "node:test";
import assert from "node:assert/strict";
import { runBounded } from "../lib/bounded-queue.ts";

test("G01: runBounded respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await runBounded(items, {
    limit: 3,
    worker: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    },
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
  assert.ok(peak >= 2, "expected some concurrency");
});

test("G01: runBounded processes every item exactly once", async () => {
  const seen: number[] = [];
  await runBounded([1, 2, 3, 4, 5], {
    limit: 2,
    worker: async (n) => {
      seen.push(n);
    },
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("G02: runBounded skips items before starting them", async () => {
  const started: number[] = [];
  const skipped: number[] = [];
  await runBounded([1, 2, 3, 4, 5, 6], {
    limit: 2,
    shouldSkip: (n) => n % 2 === 0,
    onSkip: (n) => skipped.push(n),
    worker: async (n) => {
      started.push(n);
    },
  });
  assert.deepEqual([...started].sort((a, b) => a - b), [1, 3, 5]);
  assert.deepEqual([...skipped].sort((a, b) => a - b), [2, 4, 6]);
});

test("runBounded tolerates worker rejection and keeps draining", async () => {
  const seen: number[] = [];
  await runBounded([1, 2, 3], {
    limit: 1,
    worker: async (n) => {
      if (n === 2) throw new Error("boom");
      seen.push(n);
    },
  });
  assert.deepEqual(seen, [1, 3]);
});
