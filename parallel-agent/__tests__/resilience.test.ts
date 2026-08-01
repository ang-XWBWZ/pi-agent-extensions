import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatJobPreview } from "../lib/result-format.ts";

const parallelAgentRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(parallelAgentRoot, "..", "..");

test("fatal boundaries do not call an immediate process exit", () => {
  const mcpEntry = readFileSync(
    join(workspaceRoot, "Pwiki", "mcp", "src", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(mcpEntry, /process\.exit\s*\(/);
  assert.match(mcpEntry, /process\.exitCode\s*=\s*1/);
});

test("failed task formatting retains partial output and recovery id", () => {
  const now = Date.now();
  const text = formatJobPreview({
    jobId: "job-timeout",
    tasks: [{ id: "task-timeout", prompt: "long task" }],
    total: 1,
    completed: 1,
    status: "complete",
    createdAt: now - 1_000,
    finishedAt: now,
    results: [{
      id: "task-timeout",
      name: "long task",
      order: 1,
      ok: false,
      error: "timeout",
      errorCode: "timeout",
      output: "durable partial finding",
      saveId: "task-timeout--job-tim",
    }],
  });

  assert.match(text, /durable partial finding/);
  assert.match(text, /task-timeout--job-tim/);
});

test("task panels and timeout saves persist under a bounded data root", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "pi-agent-state-"));
  const previousDataRoot = process.env.PI_AGENT_DATA_DIR;
  process.env.PI_AGENT_DATA_DIR = dataRoot;

  try {
    const bus = await import("../../lib/agent-bus.ts");
    const unsafeTaskId = "../unsafe:task";
    const job = bus.createJob([{
      id: unsafeTaskId,
      prompt: "Inspect the boundary and retain intermediate findings.",
      notes: ["initial durable note"],
    }]);

    const panel = bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
      status: "running",
      progress: 40,
      currentStep: "checking persistence",
      summary: "partial summary",
      note: "milestone note",
      noteSource: "agent",
      outputSnapshot: "partial output snapshot",
    });
    assert.equal(panel?.progress, 40);
    assert.equal(panel?.notes.at(-1)?.text, "milestone note");
    assert.equal(panel?.persistenceError, undefined);

    const firstStage = bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
      progress: 55,
      currentStep: "recording the first stage result",
      conclusion: "已完成持久化边界检查：任务面板与原始输出分离，恢复时不会主动读取完整存档。",
      detail: "验证：原始输出使用独立文件并通过 UTF-8 游标按需读取；该阶段未修改项目文件。",
      reportSource: "agent",
    });
    assert.equal(firstStage?.summary, "已完成持久化边界检查：任务面板与原始输出分离，恢复时不会主动读取完整存档。");
    assert.equal(firstStage?.stageReports.length, 1);
    assert.equal(firstStage?.stageReports.at(-1)?.source, "agent");
    assert.equal(firstStage?.stageReports.at(-1)?.detail, "验证：原始输出使用独立文件并通过 UTF-8 游标按需读取；该阶段未修改项目文件。");

    const secondStage = bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
      progress: 60,
      conclusion: "已完成第二阶段结论；详细说明按需省略。",
      reportSource: "agent",
    });
    assert.equal(secondStage?.stageReports.length, 2);
    assert.equal(secondStage?.stageReports.at(-1)?.detail, undefined);
    const persistedPanels = readdirSync(join(dataRoot, "sub-agent-tasks"), {
      recursive: true,
    })
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => JSON.parse(
        readFileSync(join(dataRoot, "sub-agent-tasks", entry), "utf8"),
      ) as { taskId?: string; stageReports?: Array<{ conclusion?: string; detail?: string }> });
    const persistedPanel = persistedPanels.find((item) => item.taskId === unsafeTaskId);
    assert.equal(persistedPanel?.stageReports?.length, 2);
    assert.equal(persistedPanel?.stageReports?.[0]?.detail, "验证：原始输出使用独立文件并通过 UTF-8 游标按需读取；该阶段未修改项目文件。");

    const rawOutput = `结论：保留完整原始输出。\n${"中".repeat(800)}\n尾部证据。`;
    assert.equal(bus.appendAgentTaskOutput(job.jobId, unsafeTaskId, rawOutput), true);
    const outputInfo = bus.getAgentTaskOutputInfo(job.jobId, unsafeTaskId);
    assert.equal(outputInfo.source, "log");
    assert.ok(outputInfo.byteLength > rawOutput.length);

    let cursor = 0;
    let recoveredOutput = "";
    do {
      const slice = bus.readAgentTaskOutput(job.jobId, unsafeTaskId, {
        cursor,
        maxBytes: 256,
      });
      assert.equal(slice.source, "log");
      assert.ok(slice.nextCursor > cursor || !slice.hasMore);
      recoveredOutput += slice.text;
      cursor = slice.nextCursor;
      if (!slice.hasMore) break;
    } while (true);
    assert.equal(recoveredOutput, rawOutput);

    const capped = bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
      outputSnapshot: "x".repeat(70_000),
      outputLength: 70_000,
    });
    assert.ok(capped?.outputSnapshot);
    assert.ok(
      capped!.outputSnapshot!.length <= bus.TASK_PANEL_OUTPUT_SNAPSHOT_CHARS,
    );
    assert.equal(capped?.outputLength, 70_000);

    const eventBus = bus.getAgentBus();
    let laterListenerRan = false;
    const failingListener = () => {
      throw new Error("listener failure should be isolated");
    };
    const laterListener = () => {
      laterListenerRan = true;
    };
    const originalWarn = console.warn;
    console.warn = () => undefined;
    eventBus.on(bus.Events.TASK_PANEL_UPDATED, failingListener);
    eventBus.on(bus.Events.TASK_PANEL_UPDATED, laterListener);
    try {
      bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
        progress: 45,
      });
    } finally {
      eventBus.off(bus.Events.TASK_PANEL_UPDATED, failingListener);
      eventBus.off(bus.Events.TASK_PANEL_UPDATED, laterListener);
      console.warn = originalWarn;
    }
    assert.equal(laterListenerRan, true);

    const fakeSession = {
      state: {
        messages: [{ role: "assistant", content: "partial answer" }],
      },
      abort: async () => undefined,
      dispose: () => undefined,
    };
    bus.registerInstance({
      jobId: job.jobId,
      taskId: unsafeTaskId,
      name: "unsafe task",
      session: fakeSession,
      status: "running",
      detailedStatus: "running",
      toolHistory: [],
      lastActivityAt: Date.now(),
      autoContinue: false,
      autoContinueDelay: 30,
      startedAt: Date.now(),
      promptLength: 10,
      outputLength: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheTokens: 0,
      cost: 0,
      contextPercent: null,
      contextWindow: 0,
    } as never);

    bus.updateAgentTaskPanel(job.jobId, unsafeTaskId, {
      status: "blocked",
      currentStep: "waiting for a dependency",
    });
    bus.updateInstanceStatus(job.jobId, unsafeTaskId, {
      detailedStatus: "thinking",
      logTool: { toolName: "update_agent_task", status: "done" },
    });
    assert.equal(
      bus.getAgentTaskPanel(job.jobId, unsafeTaskId)?.status,
      "blocked",
      "the update tool completion event must not overwrite its own explicit status",
    );

    const saved = bus.saveAgentState(job.jobId, unsafeTaskId, {
      reason: "timeout",
      output: "partial output snapshot",
    });
    assert.ok(saved);
    assert.equal(saved.reason, "timeout");
    assert.equal(saved.output, "partial output snapshot");
    assert.equal(bus.loadAgentState(saved.saveId)?.saveId, saved.saveId);

    const summaryJob = bus.createJob([{
      id: "summary-task",
      prompt: "Return a final compact conclusion.",
    }]);
    bus.updateAgentTaskPanel(summaryJob.jobId, "summary-task", {
      summary: "intermediate finding",
    });
    bus.publishTaskResult(summaryJob.jobId, {
      id: "summary-task",
      name: "summary task",
      order: 1,
      ok: true,
      summary: "final conclusion with verification",
      output: "long final output",
      outputLength: 999,
    });
    const summaryPanel = bus.getAgentTaskPanel(summaryJob.jobId, "summary-task");
    assert.equal(summaryPanel?.summary, "final conclusion with verification");
    assert.equal(summaryPanel?.stageReports.at(-1)?.conclusion, "final conclusion with verification");
    assert.equal(summaryPanel?.stageReports.at(-1)?.status, "completed");
    assert.equal(summaryPanel?.outputLength, 999);

    const persistedFiles = readdirSync(dataRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name));
    assert.ok(persistedFiles.length >= 2);
    assert.ok(
      persistedFiles.every((file) =>
        file.startsWith(`${resolve(dataRoot)}\\`) ||
        file.startsWith(`${resolve(dataRoot)}/`),
      ),
    );

    bus.unregisterInstance(job.jobId, unsafeTaskId);
  } finally {
    if (previousDataRoot === undefined) {
      delete process.env.PI_AGENT_DATA_DIR;
    } else {
      process.env.PI_AGENT_DATA_DIR = previousDataRoot;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("child task protocol is registered and timeout checkpoints precede abort", () => {
  const entry = readFileSync(join(parallelAgentRoot, "..", "parallel-agent.ts"), "utf8");
  const spawnTool = readFileSync(
    join(parallelAgentRoot, "tools", "spawn-agent.ts"),
    "utf8",
  );
  const runner = readFileSync(
    join(parallelAgentRoot, "lib", "agent-runner.ts"),
    "utf8",
  );

  assert.match(entry, /registerUpdateAgentTask\(pi\)/);
  assert.match(entry, /registerReadAgentOutput\(pi\)/);
  assert.match(spawnTool, /REQUIRED_CHILD_TOOLS[\s\S]*update_agent_task/);
  assert.match(spawnTool, /TOOL_SAFETY_NET[\s\S]*read_agent_output/);
  assert.match(runner, /FINAL_CONCLUSION_MAX_CHARS/);
  assert.match(runner, /每次阶段提交使用 conclusion/);
  assert.match(runner, /errorCode === "timeout"[\s\S]*saveAgentState[\s\S]*session\.abort/);
});

test("sub-agent sessions do not poll or own the parent TUI widget", () => {
  const entry = readFileSync(join(parallelAgentRoot, "..", "parallel-agent.ts"), "utf8");
  const runner = readFileSync(
    join(parallelAgentRoot, "lib", "agent-runner.ts"),
    "utf8",
  );
  const widget = readFileSync(join(parallelAgentRoot, "lib", "widget.ts"), "utf8");

  assert.match(runner, /__pi_parallel_agent_suppress_widget = true/);
  assert.match(runner, /delete \(globalThis as Record<string, unknown>\)\s*\.__pi_parallel_agent_suppress_widget/);
  assert.match(entry, /suppressSubAgentWidget[\s\S]*__pi_parallel_agent_suppress_widget/);
  assert.match(entry, /if \(!suppressSubAgentWidget\) setupWidget\(pi\)/);
  assert.doesNotMatch(widget, /setInterval\s*\(/);
  assert.match(widget, /scheduleWidgetExpiry\(\)/);
  assert.match(widget, /if \(!widgetTui\) return/);
  assert.match(widget, /let widgetRenderNow = 0/);
  assert.match(widget, /visibleStatusSignatures\.get\(key\) === signature/);
  assert.match(widget, /visiblePanelSignatures\.get\(key\) === signature/);
  assert.match(widget, /setTimeout\(\(\) =>/);
});

test("GitHub distribution keeps the same resilience contract", () => {
  const distRoot = join(workspaceRoot, "github特供版", "github-dist");
  const entry = readFileSync(join(distRoot, "parallel-agent.ts"), "utf8");
  const bus = readFileSync(join(distRoot, "lib", "agent-bus.ts"), "utf8");
  const runner = readFileSync(
    join(distRoot, "parallel-agent", "lib", "agent-runner.ts"),
    "utf8",
  );
  const updateTool = readFileSync(
    join(distRoot, "parallel-agent", "tools", "update-task.ts"),
    "utf8",
  );

  assert.match(entry, /registerUpdateAgentTask\(pi\)/);
  assert.match(bus, /TASK_PANEL_UPDATED/);
  assert.match(bus, /safeStorageName/);
  assert.match(updateTool, /name:\s*"update_agent_task"/);
  assert.match(runner, /errorCode === "timeout"[\s\S]*saveAgentState[\s\S]*session\.abort/);
  assert.match(runner, /__pi_default_mode/);
  assert.doesNotMatch(runner, /__pi_default_phase/);
});

test("GitHub distribution keeps the event-driven sub-agent widget contract", () => {
  const distRoot = join(workspaceRoot, "github特供版", "github-dist");
  const entry = readFileSync(join(distRoot, "parallel-agent.ts"), "utf8");
  const runner = readFileSync(
    join(distRoot, "parallel-agent", "lib", "agent-runner.ts"),
    "utf8",
  );
  const widget = readFileSync(
    join(distRoot, "parallel-agent", "lib", "widget.ts"),
    "utf8",
  );

  assert.match(runner, /__pi_parallel_agent_suppress_widget = true/);
  assert.match(entry, /if \(!suppressSubAgentWidget\) setupWidget\(pi\)/);
  assert.doesNotMatch(widget, /setInterval\s*\(/);
  assert.match(widget, /scheduleWidgetExpiry\(\)/);
  assert.match(widget, /if \(!widgetTui\) return/);
  assert.match(widget, /let widgetRenderNow = 0/);
  assert.match(widget, /visibleStatusSignatures\.get\(key\) === signature/);
  assert.match(widget, /visiblePanelSignatures\.get\(key\) === signature/);
});
