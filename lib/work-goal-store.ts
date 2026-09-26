import { randomUUID } from "node:crypto";
import {
  redactAuditText,
  sanitizeAuditValue,
} from "./audit-sanitize.js";
import type {
  AutonomyLevel,
  ConversationPhase,
  WorkGoalEvidence,
  WorkGoalLog,
  WorkGoalState,
} from "./workflow-types.js";

interface WorkGoalStoreState {
  goals: Map<string, WorkGoalState>;
  activeGoalId?: string;
}

const STORE_KEY = "__pi_work_goal_store";

function store(): WorkGoalStoreState {
  let s = (globalThis as Record<string, unknown>)[STORE_KEY] as
    | WorkGoalStoreState
    | undefined;
  if (!s) {
    s = { goals: new Map() };
    (globalThis as Record<string, unknown>)[STORE_KEY] = s;
  }
  return s;
}

function touch(goal: WorkGoalState): WorkGoalState {
  goal.updatedAt = Date.now();
  return goal;
}

export type GoalLifecycleEvent = "created" | "finished" | "aborted" | "deleted";
export type GoalLifecycleListener = (event: GoalLifecycleEvent, goal: WorkGoalState) => void;

const lifecycleListeners = new Set<GoalLifecycleListener>();

export function onGoalLifecycle(listener: GoalLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

function notifyGoalLifecycle(event: GoalLifecycleEvent, goal: WorkGoalState): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event, goal);
    } catch {
      // 容错防止监听器异常中断主流程
    }
  }
}

export function createWorkGoal(input: {
  title?: string;
  goal: string;
  phase?: ConversationPhase;
  autonomy?: AutonomyLevel;
}): WorkGoalState {
  const now = Date.now();
  const safeGoal = redactAuditText(input.goal);
  const title =
    (input.title ? redactAuditText(input.title).trim() : "") ||
    safeGoal.trim().slice(0, 80) ||
    "Work goal";
  const goal: WorkGoalState = {
    id: randomUUID(),
    title,
    goal: safeGoal,
    status: "active",
    phase: input.phase ?? "work",
    autonomy: input.autonomy ?? "guarded",
    createdAt: now,
    updatedAt: now,
    logs: [],
    evidence: [],
  };
  const s = store();
  s.goals.set(goal.id, goal);
  s.activeGoalId = goal.id;
  notifyGoalLifecycle("created", goal);
  return goal;
}

export function hasActiveWorkGoal(): boolean {
  const goal = getActiveWorkGoal();
  return goal !== null && goal.status === "active";
}

export function getActiveWorkGoal(): WorkGoalState | null {
  const s = store();
  if (!s.activeGoalId) return null;
  return s.goals.get(s.activeGoalId) ?? null;
}

export function getWorkGoal(id: string): WorkGoalState | null {
  return store().goals.get(id) ?? null;
}

export function updateWorkGoal(
  id: string,
  updater: (goal: WorkGoalState) => WorkGoalState,
): WorkGoalState {
  const s = store();
  const current = s.goals.get(id);
  if (!current) throw new Error(`Work goal not found: ${id}`);
  const next = touch(updater(current));
  s.goals.set(id, next);
  if (next.status === "active") s.activeGoalId = id;
  if (s.activeGoalId === id && next.status !== "active") {
    s.activeGoalId = undefined;
  }
  return next;
}

export function appendWorkGoalLog(
  goalId: string,
  log: Omit<WorkGoalLog, "id" | "createdAt">,
): WorkGoalLog {
  const safeLog = sanitizeAuditValue(log) as Omit<
    WorkGoalLog,
    "id" | "createdAt"
  >;
  const created: WorkGoalLog = {
    ...safeLog,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  updateWorkGoal(goalId, (goal) => {
    goal.logs.push(created);
    return goal;
  });
  return created;
}

export function appendWorkGoalEvidence(
  goalId: string,
  evidence: Omit<WorkGoalEvidence, "id" | "createdAt">,
): WorkGoalEvidence {
  const safeEvidence = sanitizeAuditValue(evidence) as Omit<
    WorkGoalEvidence,
    "id" | "createdAt"
  >;
  const created: WorkGoalEvidence = {
    ...safeEvidence,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  updateWorkGoal(goalId, (goal) => {
    goal.evidence.push(created);
    return goal;
  });
  return created;
}

export function finishWorkGoal(id: string, summary?: string): WorkGoalState {
  if (summary) {
    appendWorkGoalEvidence(id, {
      type: "summary",
      summary,
      passed: true,
    });
  }
  const finished = updateWorkGoal(id, (goal) => {
    goal.status = "done";
    goal.finishedAt = Date.now();
    return goal;
  });
  notifyGoalLifecycle("finished", finished);
  return finished;
}

export function abortWorkGoal(id: string, reason?: string): WorkGoalState {
  if (reason) {
    appendWorkGoalLog(id, {
      type: "work_goal_aborted",
      message: reason,
    });
  }
  const aborted = updateWorkGoal(id, (goal) => {
    goal.status = "aborted";
    goal.finishedAt = Date.now();
    return goal;
  });
  notifyGoalLifecycle("aborted", aborted);
  return aborted;
}

export function deleteWorkGoal(id: string): boolean {
  const s = store();
  const goal = s.goals.get(id);
  if (!goal) return false;
  s.goals.delete(id);
  if (s.activeGoalId === id) {
    s.activeGoalId = undefined;
  }
  notifyGoalLifecycle("deleted", goal);
  return true;
}

