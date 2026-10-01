import { captureOperation } from "./support/capability-harness.js";
import "./support/isolated-data-root.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentState } from "../../lib/agent-bus.js";
import { buildResumeContext } from "../lib/resume.ts";
import { MAX_TASKS_PER_DISPATCH, registerSpawnAgent } from "../tools/spawn-agent.ts";

function sampleSave(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    saveId: "s1",
    jobId: "job-1",
    taskId: "task-1",
    name: "resumed task",
    model: "test/model",
    messages: [
      { role: "user", content: "do the work" },
      { role: "assistant", content: "working" },
    ],
    reason: "timeout",
    output: "partial output snapshot",
    savedAt: Date.now(),
    taskPanel: {
      version: 1,
      jobId: "job-1",
      taskId: "task-1",
      name: "resumed task",
      objective: "o",
      status: "timed_out",
      progress: 50,
      summary: "system terminal summary",
      stageReports: [
        {
          id: "r1",
          conclusion: "engineering conclusion with evidence",
          status: "completed",
          progress: 60,
          source: "agent",
          createdAt: 1,
        },
        {
          id: "r2",
          conclusion: "system timeout summary",
          status: "timed_out",
          progress: 50,
          source: "system",
          createdAt: 2,
        },
      ],
      notes: [{ id: "n1", text: "note one", source: "agent", createdAt: 1 }],
      revision: 2,
      createdAt: 0,
      updatedAt: 2,
    },
    ...overrides,
  };
}

test("F02/F03: resume prefers the last engineering conclusion over the system terminal summary", () => {
  const context = buildResumeContext(sampleSave() as never);
  assert.match(context.text, /engineering conclusion with evidence/);
  assert.doesNotMatch(context.text, /system timeout summary/);
  assert.match(context.text, /note one/);
  assert.match(context.text, /partial output snapshot/);
  assert.equal(context.hasEngineeringConclusion, true);
  assert.equal(context.sourceJobId, "job-1");
  assert.equal(context.sourceTaskId, "task-1");
  assert.equal(context.saveId, "s1");
  // F06：明确声明恢复不授予授权
  assert.match(context.text, /不授予或继承任何执行授权/);
});

test("F02: resume context is bounded", () => {
  const save = sampleSave({
    taskPanel: {
      version: 1,
      jobId: "job-1",
      taskId: "task-1",
      name: "big",
      objective: "o",
      status: "completed",
      progress: 100,
      stageReports: [
        {
          id: "r1",
          conclusion: "x".repeat(50_000),
          status: "completed",
          progress: 100,
          source: "agent",
          createdAt: 1,
        },
      ],
      notes: [],
      revision: 1,
      createdAt: 0,
      updatedAt: 1,
    },
  });
  const context = buildResumeContext(save as never);
  assert.ok(context.text.length <= 12_100, `resume too large: ${context.text.length}`);
  assert.match(context.text, /恢复上下文截断/);
});

test("F07: legacy save without version or messages loads with compatible defaults", () => {
  const dir = join(process.env.PI_AGENT_DATA_DIR as string, "sub-agent-saves");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "legacy-save.json"),
    JSON.stringify({ saveId: "legacy-save", taskId: "t", name: "legacy", model: "m", savedAt: 1 }),
  );
  const loaded = loadAgentState("legacy-save");
  assert.ok(loaded);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.messages, []);
  assert.equal(loaded.reason, "manual");
});

test("F04: unknown resumeFrom fails explicitly instead of spawning a fresh task", async () => {
  const tool = captureOperation(registerSpawnAgent, "spawn_agent");

  const res = await tool.execute(
    "tc",
    { tasks: [{ id: "t1", prompt: "p", resumeFrom: "no-such-save" }] },
    undefined,
    undefined,
    {
      cwd: "/workspace",
      model: { provider: "test", id: "model" },
      modelRegistry: { find: () => undefined },
      ui: { notify: () => undefined, setStatus: () => undefined },
    },
  );

  assert.equal(res.details.error, "resume_not_found");
  assert.deepEqual(res.details.missing, ["no-such-save"]);
});

test("G02: spawn_agent rejects a dispatch above the task cap", async () => {
  const tool = captureOperation(registerSpawnAgent, "spawn_agent");

  const tasks = Array.from({ length: MAX_TASKS_PER_DISPATCH + 1 }, (_, i) => ({
    id: `t${i}`,
    prompt: "p",
  }));

  await assert.rejects(() =>
    tool!.execute("tc", { tasks }, undefined, undefined, {
      cwd: "/workspace",
      model: { provider: "test", id: "model" },
      modelRegistry: { find: () => undefined },
      ui: { notify: () => undefined, setStatus: () => undefined },
    }),
  );
});
