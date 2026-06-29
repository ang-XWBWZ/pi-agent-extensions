import { getExecutionContext } from "./execution-context.js";
import { appendWorkGoalLog, getActiveWorkGoal } from "./work-goal-store.js";

function preview(text?: string, limit = 2000): string | undefined {
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) + "\n...[truncated]" : text;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shouldRecord(): string | null {
  const ctx = getExecutionContext();
  if (ctx.ledger !== "work_goal") return null;
  const goal = getActiveWorkGoal();
  if (!goal || goal.status !== "active") return null;
  return goal.id;
}

export async function beforeCommand(input: {
  command: string;
  cwd: string;
}): Promise<{ logId?: string; startedAt: number }> {
  const startedAt = Date.now();
  const goalId = shouldRecord();
  if (!goalId) return { startedAt };
  const log = appendWorkGoalLog(goalId, {
    type: "command_started",
    message: input.command,
    command: input.command,
    cwd: input.cwd,
  });
  return { logId: log.id, startedAt };
}

export async function afterCommand(input: {
  command: string;
  cwd: string;
  startedAt: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
}): Promise<void> {
  const goalId = shouldRecord();
  if (!goalId) return;

  const failed =
    input.error !== undefined ||
    (input.exitCode !== undefined &&
      input.exitCode !== null &&
      input.exitCode !== 0);
  const durationMs = Date.now() - input.startedAt;
  appendWorkGoalLog(goalId, {
    type: failed ? "command_failed" : "command_finished",
    message: failed
      ? `${input.command} failed`
      : `${input.command} finished`,
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode ?? (input.error ? -1 : null),
    durationMs,
    stdoutPreview: preview(input.stdout),
    stderrPreview: preview(input.stderr),
    metadata: input.error ? { error: errorMessage(input.error) } : undefined,
  });
}
