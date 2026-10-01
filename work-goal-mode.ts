import { capabilityToolRegistry } from "./lib/capability-dispatch.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  auditTextPreview,
  compactAuditValue,
  redactAuditText,
} from "./lib/audit-sanitize.js";
import { registerCapability } from "./lib/capability-router.js";
import {
  isToolResultError,
  renderStructuredToolCall,
  renderToolResult,
} from "./lib/tui-render.js";
import {
  getExecutionContext,
  setExecutionContext,
  withSessionScope,
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

function activeWorkGoalOrMessage(sessionManager?: object) {
  const current = getExecutionContext(sessionManager);
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

function shouldRecordGenericTool(
  toolName: string,
  sessionManager?: object,
): boolean {
  if (DEDICATED_COMMAND_TOOLS.has(toolName)) return false;
  if (WORK_GOAL_TOOLS.has(toolName)) return false;
  const ctx = getExecutionContext(sessionManager);
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
  registerCapability({
    id: "work_goal",
    name: "Work Goal Ledger",
    summary: "Structured task audit ledger (start/status/log/finish/abort).",
    keywords: ["goal", "audit", "ledger", "work_goal", "task tracking"],
    phases: ["work"],
    tools: [
      "work_goal_start",
      "work_goal_status",
      "work_goal_log",
      "work_goal_finish",
      "work_goal_abort",
    ],
    toolDescriptions: {
      work_goal_start: "启动当前工作阶段的结构化任务审计账本与进度跟踪",
      work_goal_status: "查看当前工作目标账本状态、运行时长与阶段性审计日志",
      work_goal_log: "查看当前工作目标账本的历史审计条目列表",
      work_goal_finish: "完成当前工作目标账本并提交最终交付物审计摘要",
      work_goal_abort: "终止当前工作目标账本并记录终止原因（保留历史审计记录）",
    },
    usageDoc: `# Work Goal Ledger Subsystem (work_goal)
Provides structured audit logging and progress tracking for execution in WORK mode.

### Available Tools:
- \`work_goal_start(goal, title?)\`: Start an audit ledger for the current Work authorization.
- \`work_goal_status()\`: Show current ledger status and recent logs.
- \`work_goal_log(limit?)\`: Inspect recent ledger entries.
- \`work_goal_finish(summary?)\`: Complete the goal ledger with an audit summary.
- \`work_goal_abort(reason?)\`: Terminate the current ledger without losing records.

### Usage Rules:
- Only call within WORK phase.
- Recording execution never expands or modifies current approval authority.`,
  });

  pi.on("tool_call", (event, ctx) => withSessionScope(ctx.sessionManager, () => {
    if (!shouldRecordGenericTool(event.toolName, ctx.sessionManager)) return;
    const executionContext = getExecutionContext(ctx?.sessionManager);
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
  }));

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

  capabilityToolRegistry(pi).registerTool({
    name: "work_goal_start",
    label: "work_goal_start",
    description:
      "Start an audit ledger for the current Work authorization. It records execution but never grants or expands permissions.",
    parameters: Type.Object({
      goal: Type.String({ description: "Goal to execute toward" }),
      title: Type.Optional(Type.String({ description: "Short target title" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "work_goal_start", [
        { name: "goal", value: args.goal, tone: "accent", maxLength: 180 },
        { name: "title", value: args.title, tone: "toolOutput", maxLength: 120 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 6,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const current = getExecutionContext(ctx?.sessionManager);
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
      const goal = withSessionScope(ctx?.sessionManager, () => createWorkGoal({
        goal: redactAuditText(params.goal),
        title: params.title ? redactAuditText(params.title) : undefined,
        phase: "work",
        autonomy: current.autonomy,
      }));
      const execCtx: ExecutionContext = {
        ...current,
        ledger: "work_goal",
        goalId: goal.id,
        runtime: {
          cwd: ctx?.cwd ?? process.cwd(),
          startedAt: current.runtime.startedAt,
        },
      };
      setExecutionContext(execCtx, ctx?.sessionManager);
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

  capabilityToolRegistry(pi).registerTool({
    name: "work_goal_status",
    label: "work_goal_status",
    description: "Show the current Work goal ledger status and recent logs.",
    parameters: Type.Object({}),
    renderCall(_args, theme, context) {
      return renderStructuredToolCall(theme, context, "work_goal_status", []);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 8,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_tcid, _params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage(ctx?.sessionManager);
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

  capabilityToolRegistry(pi).registerTool({
    name: "work_goal_log",
    label: "work_goal_log",
    description: "Show the current Work goal ledger, optionally limited to the most recent N entries.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Recent log count" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "work_goal_log", [
        { name: "limit", value: args.limit, tone: "muted" },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 10,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage(ctx?.sessionManager);
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

  capabilityToolRegistry(pi).registerTool({
    name: "work_goal_finish",
    label: "work_goal_finish",
    description: "Finish the active Work goal ledger and write a completion summary.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "Optional human summary" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "work_goal_finish", [
        { name: "summary", value: args.summary, tone: "toolOutput", maxLength: 180 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 6,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage(ctx?.sessionManager);
      if (!("logs" in goal)) return goal as any;
      const summary = redactAuditText(
        params.summary?.trim() || summarizeWorkGoal(goal),
      );
      appendWorkGoalLog(goal.id, {
        type: "work_goal_finished",
        message: summary,
      });
      const finished = withSessionScope(ctx?.sessionManager, () => finishWorkGoal(goal.id, summary));
      const current = getExecutionContext(ctx?.sessionManager);
      setExecutionContext({
        ...current,
        ledger: "off",
        goalId: undefined,
      }, ctx?.sessionManager);
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

  capabilityToolRegistry(pi).registerTool({
    name: "work_goal_abort",
    label: "work_goal_abort",
    description:
      "Abort the active Work goal ledger without changing the current Work authorization.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Abort reason" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "work_goal_abort", [
        { name: "reason", value: args.reason, tone: "warning", maxLength: 180 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 6,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const goal = activeWorkGoalOrMessage(ctx?.sessionManager);
      if (!("logs" in goal)) return goal as any;
      const reason = redactAuditText(
        params.reason?.trim() || "Work goal aborted",
      );
      const aborted = withSessionScope(ctx?.sessionManager, () => abortWorkGoal(goal.id, reason));
      const current = getExecutionContext(ctx?.sessionManager);
      setExecutionContext({
        ...current,
        ledger: "off",
        goalId: undefined,
      }, ctx?.sessionManager);
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
