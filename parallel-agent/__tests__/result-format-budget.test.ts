import test from "node:test";
import assert from "node:assert/strict";
import { formatJobFullResult } from "../lib/result-format.ts";

test("E07: job-wide injection budget folds oversized results into a bounded summary", () => {
  const now = Date.now();
  const results = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`,
    name: `task ${i}`,
    order: i + 1,
    ok: true,
    summary: "S".repeat(5_000),
    output: "O".repeat(20_000),
    outputLength: 20_000,
  }));

  const text = formatJobFullResult({
    jobId: "job-big",
    tasks: results.map((r) => ({ id: r.id, prompt: "p" })),
    total: results.length,
    completed: results.length,
    status: "complete",
    createdAt: now - 1_000,
    finishedAt: now,
    results,
  } as never);

  assert.ok(text.length <= 42_000, `injected text too large: ${text.length}`);
  assert.match(text, /超出自动注入预算/);
  assert.match(text, /read_agent_output/);
});
