import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import {
  clearExecutionContext,
  getExecutionContext,
  setExecutionContext,
} from "./lib/execution-context.js";
import {
  abortWorkGoal,
  appendWorkGoalLog,
  createWorkGoal,
  finishWorkGoal,
  getActiveWorkGoal,
} from "./lib/work-goal-store.js";
import type { ExecutionContext, WorkGoalLog, WorkGoalState } from "./lib/workflow-types.js";

const DEDICATED_COMMAND_TOOLS = new Set(["cmd", "powershell"]);
const WORK_GOAL_TOOLS = new Set([
  "work_goal_start",
  "work_goal_status",
  "work_goal_log",
  "work_goal_finish",
  "work_goal_abort",
]);

interface PendingToolCall {
  toolName: string;
  message: string;
  startedAt: number;
}

const pendingToolCalls = new Map<string, PendingToolCall>();

function formatTime(ms: number | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toISOString();
}

function formatLog(log: WorkGoalLog): string {
  const exit =
    log.exitCode === undefined || log.exitCode === null
      ? ""
      : ` exit=${log.exitCode}`;
  const duration = log.durationMs === undefined ? "" : ` ${log.durationMs}ms`;
  return `- [${log.type}] ${log.message}${exit}${duration}`;
}

function summarizeWorkGoal(goal: WorkGoalState): string {
  const commands = goal.logs.filter((log) => log.command);
  const failed = goal.logs.filter((log) => log.type === "command_failed");
  const repairs = goal.logs.filter((log) => log.type === "repair");
  return [
    `Work goal: ${goal.title}`,
    `Goal: ${goal.goal}`,
    `Status: ${goal.status}`,
    "Work ledger: enabled",
    `Autonomy: ${goal.autonomy}`,
    `Started: ${formatTime(goal.createdAt)}`,
    `Finished: ${formatTime(Date.now())}`,
    `Commands: ${commands.length}`,
    `Failed commands: ${failed.length}`,
    repairs.length ? `Repairs: ${repairs.map((log) => log.message).join("; ")}` : "Repairs: none recorded",
    failed.length
      ? `Failures: ${failed.map((log) => log.command ?? log.message).join("; ")}`
      : "Failures: none recorded",
  ].join("\n");
}

function activeWorkGoalOrMessage() {
  const goal = getActiveWorkGoal();
  if (!goal) {
    return {
      content: [{ type: "text", text: "No active Work goal." }],
      details: { active: false },
    };
  }
  return goal;
}

function shouldRecordGenericTool(toolName: string): boolean {
  if (DEDICATED_COMMAND_TOOLS.has(toolName)) return false;
  if (WORK_GOAL_TOOLS.has(toolName)) return false;
  const ctx = getExecutionContext();
  return ctx.ledger === "work_goal";
}

function compact(value: unknown, limit = 500): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) + "...[truncated]" : text;
}

function toolMessage(toolName: string, input: unknown): string {
  const record = input as Record<string, unknown> | undefined;
  const command = record?.command;
  if (typeof command === "string" && command.trim()) return command.trim();
  const path = record?.path;
  if (typeof path === "string" && path.trim()) return `${toolName} ${path.trim()}`;
  const tasks = record?.tasks;
  if (Array.isArray(tasks)) return `${toolName} ${tasks.length} task(s)`;
  return `${toolName} ${compact(input)}`.trim();
}

function resultPreview(event: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  const text = event.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  if (!text) return undefined;
  return text.length > 2000 ? text.slice(0, 2000) + "\n...[truncated]" : text;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (!shouldRecordGenericTool(event.toolName)) return;
    const goal = getActiveWorkGoal();
    if (!goal || goal.status !== "active") return;

    const message = toolMessage(event.toolName, (event as { input?: unknown }).input);
    pendingToolCalls.set(event.toolCallId, {
      toolName: event.toolName,
      message,
      startedAt: Date.now(),
    });
    appendWorkGoalLog(goal.id, {
      type: "command_started",
      message,
      command: event.toolName === "bash" ? message : undefined,
      cwd: ctx?.cwd,
      metadata: {
        toolName: event.toolName,
        inputPreview: compact((event as { input?: unknown }).input),
      },
    });
  });

  pi.on("tool_result", (event) => {
    const pending = pendingToolCalls.get(event.toolCallId);
    if (!pending) return;
    pendingToolCalls.delete(event.toolCallId);

    const goal = getActiveWorkGoal();
    if (!goal || goal.status !== "active") return;

    appendWorkGoalLog(goal.id, {
      type: event.isError ? "command_failed" : "command_finished",
      message: `${pending.toolName} ${event.isError ? "failed" : "finished"}`,
      command: pending.toolName === "bash" ? pending.message : undefined,
      durationMs: Date.now() - pending.startedAt,
      stdoutPreview: resultPreview(event),
      metadata: {
        toolName: pending.toolName,
      },
    });
  });

  pi.registerTool({
    name: "work_goal_start",
    label: "work_goal_start",
    description:
      "Start a Work goal ledger. This is not a separate mode; it records autonomous Work execution and preauthorizes auto context inheritance.",
    promptSnippet: "Start autonomous Work with a goal ledger for a concrete goal",
    promptGuidelines: [
      "Use when: Work is ready, the goal is concrete, and the user wants autonomous execution with an auditable ledger.",
      "Do not use when: the agent is still in Chat/Plan, requirements are unresolved, or the task does not need autonomous execution.",
      "Phase policy: Plan may propose using a ledger; only Work should start it.",
      "Workflow: confirm Work Contract -> start ledger -> execute -> record evidence -> finish or abort.",
      "Conflict policy: manage_requirements confirms the goal; manage_plan tracks intended steps; this ledger records actual execution.",
      "Failure / fallback: if the goal becomes unclear or unsafe, abort the ledger and return to Plan.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Goal to execute toward" }),
      title: Type.Optional(Type.String({ description: "Short target title" })),
    }),
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = createWorkGoal({
        goal: params.goal,
        title: params.title,
        phase: "work",
        autonomy: "auto",
      });
      const execCtx: ExecutionContext = {
        sessionId: randomUUID(),
        phase: "work",
        autonomy: "auto",
        ledger: "work_goal",
        goalId: goal.id,
        approval: {
          interactive: false,
          preauthorized: true,
          inheritToChildren: true,
        },
        runtime: {
          cwd: ctx?.cwd ?? process.cwd(),
          startedAt: Date.now(),
        },
      };
      setExecutionContext(execCtx);
      appendWorkGoalLog(goal.id, {
        type: "work_goal_started",
        message: goal.goal,
        metadata: {
          title: goal.title,
          preauthorized: true,
          inheritToChildren: true,
        },
      });
      ctx?.ui?.setStatus?.("work-goal", `GOAL: ${goal.title}`);
      return {
        content: [
          {
            type: "text",
            text: [
              `Work goal created: ${goal.title}`,
              "Work ledger: enabled",
              "Autonomy: auto",
              "Authorization: preauthorized",
              "Child inheritance: enabled",
              "",
              "Commands and key results will be written to the target log.",
            ].join("\n"),
          },
        ],
        details: { goal, executionContext: execCtx },
      };
    },
  });

  pi.registerTool({
    name: "work_goal_status",
    label: "work_goal_status",
    description: "Show the current Work goal ledger status and recent logs.",
    promptSnippet: "Show current Work goal ledger status",
    parameters: Type.Object({}),
    async execute() {
      const goal = activeWorkGoalOrMessage();
      if (!("logs" in goal)) return goal;
      const recent = goal.logs.slice(-10).map(formatLog);
      return {
        content: [
          {
            type: "text",
            text: [
              `Work goal: ${goal.title}`,
              `Status: ${goal.status}`,
              "Work ledger: enabled",
              `Autonomy: ${goal.autonomy}`,
              `Created: ${formatTime(goal.createdAt)}`,
              `Evidence: ${goal.evidence.length}`,
              "",
              "Recent logs:",
              recent.length ? recent.join("\n") : "- (none)",
            ].join("\n"),
          },
        ],
        details: { goal },
      };
    },
  });

  pi.registerTool({
    name: "work_goal_log",
    label: "work_goal_log",
    description: "Show the current Work goal ledger, optionally limited to the most recent N entries.",
    promptSnippet: "Show Work goal ledger entries",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Recent log count" })),
    }),
    async execute(_tcid, params) {
      const goal = activeWorkGoalOrMessage();
      if (!("logs" in goal)) return goal;
      const limit =
        params.limit != null && Number.isFinite(params.limit) && params.limit > 0
          ? Math.floor(params.limit)
          : goal.logs.length;
      const logs = goal.logs.slice(-limit);
      return {
        content: [
          {
            type: "text",
            text: [
              `Work goal log: ${goal.title}`,
              logs.length ? logs.map(formatLog).join("\n") : "- (none)",
            ].join("\n"),
          },
        ],
        details: { goalId: goal.id, logs },
      };
    },
  });

  pi.registerTool({
    name: "work_goal_finish",
    label: "work_goal_finish",
    description: "Finish the active Work goal ledger and write a completion summary.",
    promptSnippet: "Finish Work goal ledger and summarize execution",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Optional human summary" })),
    }),
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage();
      if (!("logs" in goal)) return goal;
      const summary = params.summary?.trim() || summarizeWorkGoal(goal);
      appendWorkGoalLog(goal.id, {
        type: "work_goal_finished",
        message: summary,
      });
      const finished = finishWorkGoal(goal.id, summary);
      clearExecutionContext();
      ctx?.ui?.setStatus?.("work-goal", "");
      return {
        content: [
          {
            type: "text",
            text: ["Work goal done:", summary].join("\n"),
          },
        ],
        details: { goal: finished, summary },
      };
    },
  });

  pi.registerTool({
    name: "work_goal_abort",
    label: "work_goal_abort",
    description: "Abort the active Work goal ledger and clear autonomous execution context.",
    promptSnippet: "Abort current Work goal ledger",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Abort reason" })),
    }),
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage();
      if (!("logs" in goal)) return goal;
      const reason = params.reason?.trim() || "Work goal aborted";
      const aborted = abortWorkGoal(goal.id, reason);
      clearExecutionContext();
      ctx?.ui?.setStatus?.("work-goal", "");
      return {
        content: [{ type: "text", text: `Work goal aborted: ${goal.title}\n${reason}` }],
        details: { goal: aborted },
      };
    },
  });
}
