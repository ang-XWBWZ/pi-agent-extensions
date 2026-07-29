import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  auditTextPreview,
  compactAuditValue,
  redactAuditText,
} from "./lib/audit-sanitize.js";
import {
  getExecutionContext,
  setExecutionContext,
} from "./lib/execution-context.js";
import {
  abortWorkGoal,
  appendWorkGoalLog,
  createWorkGoal,
  finishWorkGoal,
  getActiveWorkGoal,
  getWorkGoal,
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
  goalId: string;
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
  const current = getExecutionContext();
  const goal =
    (current.goalId ? getWorkGoal(current.goalId) : null) ??
    getActiveWorkGoal();
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

function toolMessage(toolName: string, input: unknown): string {
  const record = input as Record<string, unknown> | undefined;
  const command = record?.command;
  if (typeof command === "string" && command.trim()) {
    return redactAuditText(command.trim());
  }
  const path = record?.path;
  if (typeof path === "string" && path.trim()) {
    return redactAuditText(`${toolName} ${path.trim()}`);
  }
  const tasks = record?.tasks;
  if (Array.isArray(tasks)) return `${toolName} ${tasks.length} task(s)`;
  return `${toolName} ${compactAuditValue(input, 500)}`.trim();
}

function resultPreview(event: { content?: Array<{ type: string; text?: string }> }): string | undefined {
  return auditTextPreview(event.content, 2000);
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (!shouldRecordGenericTool(event.toolName)) return;
    const executionContext = getExecutionContext();
    const goal = executionContext.goalId
      ? getWorkGoal(executionContext.goalId)
      : getActiveWorkGoal();
    if (!goal || goal.status !== "active") return;

    const message = toolMessage(event.toolName, (event as { input?: unknown }).input);
    pendingToolCalls.set(event.toolCallId, {
      goalId: goal.id,
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
        inputPreview: compactAuditValue(
          (event as { input?: unknown }).input,
          500,
        ),
      },
    });
  });

  pi.on("tool_result", (event) => {
    const pending = pendingToolCalls.get(event.toolCallId);
    if (!pending) return;
    pendingToolCalls.delete(event.toolCallId);

    const goal = getWorkGoal(pending.goalId);
    if (!goal) return;

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
      "Start an audit ledger for the current Work authorization. It records execution but never grants or expands permissions.",
    promptSnippet: "Start an audit ledger without changing Work authorization",
    promptGuidelines: [
      "Use work_goal_start only in WORK when a concrete task benefits from a detailed audit ledger.",
      "work_goal_start records the current authorization and must never be used to enable auto execution.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Goal to execute toward" }),
      title: Type.Optional(Type.String({ description: "Short target title" })),
    }),
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const current = getExecutionContext();
      if (current.phase !== "work") {
        return {
          content: [
            {
              type: "text",
              text: "work_goal_start is available only in WORK and cannot change the current authorization.",
            },
          ],
          details: { error: "wrong_phase", phase: current.phase },
        };
      }
      const active = getActiveWorkGoal();
      if (active?.status === "active") {
        return {
          content: [
            {
              type: "text",
              text: `已有活动 Work goal: ${active.title}。请先 finish 或 abort，避免审计链被静默替换。`,
            },
          ],
          details: { error: "active_goal_exists", goal: active },
        };
      }
      const goal = createWorkGoal({
        goal: redactAuditText(params.goal),
        title: params.title ? redactAuditText(params.title) : undefined,
        phase: "work",
        autonomy: current.autonomy,
      });
      const execCtx: ExecutionContext = {
        ...current,
        ledger: "work_goal",
        goalId: goal.id,
        runtime: {
          cwd: ctx?.cwd ?? process.cwd(),
          startedAt: current.runtime.startedAt,
        },
      };
      setExecutionContext(execCtx);
      pi.appendEntry("work-goal-state", {
        goalId: goal.id,
        active: true,
      });
      appendWorkGoalLog(goal.id, {
        type: "work_goal_started",
        message: goal.goal,
        metadata: {
          title: goal.title,
          preauthorized: execCtx.approval.preauthorized,
          inheritToChildren: execCtx.approval.inheritToChildren,
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
              `Autonomy: ${execCtx.autonomy}`,
              `Authorization: ${execCtx.approval.preauthorized ? "preauthorized" : "guarded"}`,
              `Child inheritance: ${execCtx.approval.inheritToChildren ? "enabled" : "disabled"}`,
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
      if (!("logs" in goal)) return goal as any;
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
      if (!("logs" in goal)) return goal as any;
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
      if (!("logs" in goal)) return goal as any;
      const summary = redactAuditText(
        params.summary?.trim() || summarizeWorkGoal(goal),
      );
      appendWorkGoalLog(goal.id, {
        type: "work_goal_finished",
        message: summary,
      });
      const finished = finishWorkGoal(goal.id, summary);
      const current = getExecutionContext();
      setExecutionContext({
        ...current,
        ledger: "off",
        goalId: undefined,
      });
      pi.appendEntry("work-goal-state", {
        goalId: goal.id,
        active: false,
      });
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
    description:
      "Abort the active Work goal ledger without changing the current Work authorization.",
    promptSnippet: "Abort current Work goal ledger without changing authorization",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Abort reason" })),
    }),
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage();
      if (!("logs" in goal)) return goal as any;
      const reason = redactAuditText(
        params.reason?.trim() || "Work goal aborted",
      );
      const aborted = abortWorkGoal(goal.id, reason);
      const current = getExecutionContext();
      setExecutionContext({
        ...current,
        ledger: "off",
        goalId: undefined,
      });
      pi.appendEntry("work-goal-state", {
        goalId: goal.id,
        active: false,
      });
      ctx?.ui?.setStatus?.("work-goal", "");
      return {
        content: [{ type: "text", text: `Work goal aborted: ${goal.title}\n${reason}` }],
        details: { goal: aborted },
      };
    },
  });
}
