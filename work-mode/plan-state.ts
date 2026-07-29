import type { PlanStep } from "./types.js";

export type TerminalStepStatus = "done" | "error" | "skipped";

export type PlanStatusResult =
  | {
      ok: false;
      error:
        | "invalid_status"
        | "missing_evidence"
        | "no_current_step"
        | "invalid_id"
        | "non_current_terminal_transition"
        | "invalid_current_transition"
        | "current_step_exists";
    }
  | {
      ok: true;
      status: "current" | TerminalStepStatus;
      target: PlanStep;
      next?: PlanStep;
    };

export type AdvancePlanResult =
  | { ok: false; error: "no_current_step" }
  | { ok: true; current: PlanStep; next?: PlanStep };

export function advancePlanSteps(
  steps: PlanStep[],
  terminalStatus: TerminalStepStatus,
): AdvancePlanResult {
  const currentIndex = steps.findIndex((step) => step.status === "current");
  if (currentIndex < 0) return { ok: false, error: "no_current_step" };

  const current = steps[currentIndex];
  current.status = terminalStatus;
  if (terminalStatus === "error") {
    return { ok: true, current };
  }

  const next =
    steps
      .slice(currentIndex + 1)
      .find((step) => step.status === "pending") ??
    steps.find((step) => step.status === "pending");
  if (next) next.status = "current";
  return { ok: true, current, next };
}

function isTerminalStatus(value: unknown): value is TerminalStepStatus {
  return value === "done" || value === "error" || value === "skipped";
}

export function advancePlanWithEvidence(
  steps: PlanStep[],
  status: unknown,
  evidence: unknown,
  now = Date.now(),
): PlanStatusResult {
  if (!isTerminalStatus(status)) {
    return { ok: false, error: "invalid_status" };
  }
  const proof = typeof evidence === "string" ? evidence.trim() : "";
  if (!proof) return { ok: false, error: "missing_evidence" };

  const result = advancePlanSteps(steps, status);
  if (!result.ok) return result;
  result.current.evidence = proof;
  result.current.updatedAt = now;
  if (result.next) result.next.updatedAt = now;
  return {
    ok: true,
    status,
    target: result.current,
    next: result.next,
  };
}

export function setPlanStepStatus(
  steps: PlanStep[],
  stepId: number,
  status: unknown,
  evidence: unknown,
  now = Date.now(),
): PlanStatusResult {
  const target = steps.find((step) => step.id === stepId);
  if (!target) return { ok: false, error: "invalid_id" };

  if (isTerminalStatus(status)) {
    if (target.status !== "current") {
      return {
        ok: false,
        error: "non_current_terminal_transition",
      };
    }
    return advancePlanWithEvidence(steps, status, evidence, now);
  }

  if (status !== "current") {
    return { ok: false, error: "invalid_status" };
  }
  if (target.status !== "pending" && target.status !== "error") {
    return { ok: false, error: "invalid_current_transition" };
  }
  const current = steps.find(
    (step) => step.status === "current" && step.id !== target.id,
  );
  if (current) return { ok: false, error: "current_step_exists" };

  target.status = "current";
  target.evidence = undefined;
  target.updatedAt = now;
  return { ok: true, status: "current", target };
}

export function isPlanComplete(steps: PlanStep[]): boolean {
  return (
    steps.length > 0 &&
    steps.every((step) => step.status === "done" || step.status === "skipped")
  );
}

export function hasUnfinishedPlan(steps: PlanStep[]): boolean {
  return steps.some(
    (step) =>
      step.status === "pending" ||
      step.status === "current" ||
      step.status === "error",
  );
}
