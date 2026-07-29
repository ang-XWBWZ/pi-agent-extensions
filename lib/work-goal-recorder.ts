import { redactAuditText } from "./audit-sanitize.js";
import { getExecutionContext } from "./execution-context.js";
import {
  appendWorkGoalLog,
  getActiveWorkGoal,
  getWorkGoal,
} from "./work-goal-store.js";

function preview(text?: string, limit = 2000): string | undefined {
  if (!text) return undefined;
  const value =
    text.length > limit ? text.slice(0, limit) + "\n...[truncated]" : text;
  return redactAuditText(value);
}

function errorMessage(error: unknown): string {
  return redactAuditText(
    error instanceof Error ? error.message : String(error),
  );
}

function shouldRecord(): string | null {
  const ctx = getExecutionContext();
  if (ctx.ledger !== "work_goal") return null;
  const goal = ctx.goalId ? getWorkGoal(ctx.goalId) : getActiveWorkGoal();
  if (!goal || goal.status !== "active") return null;
  return goal.id;
}

export async function beforeCommand(input: {
  command: string;
  cwd: string;
}): Promise<{ logId?: string; goalId?: string; startedAt: number }> {
  const startedAt = Date.now();
  const goalId = shouldRecord();
  if (!goalId) return { startedAt };
  const command = redactAuditText(input.command);
  const log = appendWorkGoalLog(goalId, {
    type: "command_started",
    message: command,
    command,
    cwd: input.cwd,
  });
  return { logId: log.id, goalId, startedAt };
}

export async function afterCommand(input: {
  command: string;
  cwd: string;
  goalId?: string;
  startedAt: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
}): Promise<void> {
  const goalId = input.goalId ?? shouldRecord();
  if (!goalId) return;

  const failed =
    input.error !== undefined ||
    (input.exitCode !== undefined &&
      input.exitCode !== null &&
      input.exitCode !== 0);
  const durationMs = Date.now() - input.startedAt;
  const command = redactAuditText(input.command);
  appendWorkGoalLog(goalId, {
    type: failed ? "command_failed" : "command_finished",
    message: failed
      ? `${command} failed`
      : `${command} finished`,
    command,
    cwd: input.cwd,
    exitCode: input.exitCode ?? (input.error ? -1 : null),
    durationMs,
    stdoutPreview: preview(input.stdout),
    stderrPreview: preview(input.stderr),
    metadata: input.error ? { error: errorMessage(input.error) } : undefined,
  });
}
