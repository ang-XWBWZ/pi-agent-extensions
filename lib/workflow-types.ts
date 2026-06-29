export type ConversationPhase = "chat" | "plan" | "work";
export type AutonomyLevel = "guarded" | "auto";
export type LedgerPolicy = "off" | "work_goal";

export type WorkGoalStatus = "active" | "done" | "aborted" | "blocked";

export type WorkGoalLogType =
  | "work_goal_started"
  | "command_started"
  | "command_finished"
  | "command_failed"
  | "file_changed"
  | "note"
  | "error"
  | "repair"
  | "work_goal_finished"
  | "work_goal_aborted";

export interface WorkGoalState {
  id: string;
  title: string;
  goal: string;
  status: WorkGoalStatus;
  phase: ConversationPhase;
  autonomy: AutonomyLevel;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  logs: WorkGoalLog[];
  evidence: WorkGoalEvidence[];
}

export interface WorkGoalLog {
  id: string;
  type: WorkGoalLogType;
  message: string;
  createdAt: number;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkGoalEvidence {
  id: string;
  type: "command" | "diff" | "test" | "build" | "manual" | "summary";
  summary: string;
  passed?: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionContext {
  sessionId: string;
  phase: ConversationPhase;
  autonomy: AutonomyLevel;
  ledger: LedgerPolicy;
  goalId?: string;
  approval: {
    interactive: boolean;
    preauthorized: boolean;
    inheritToChildren: boolean;
  };
  runtime: {
    cwd: string;
    startedAt: number;
  };
}
