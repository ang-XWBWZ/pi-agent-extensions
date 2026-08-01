/**
 * work-mode.ts - collaboration phase, execution profile, requirements, and
 * progress panel wiring.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConversationPhase, type PlanStep } from "./work-mode/types.js";
import { resetStepIdCounter } from "./work-mode/plan-parser.js";
import { setupCore } from "./work-mode/core.js";
import { setupPermissionGuard } from "./work-mode/permission-guard.js";
import { setupPlanFeature } from "./work-mode/plan-feature.js";
import {
  formatWorkContract,
  setupRequirementsFeature,
} from "./work-mode/requirements-feature.js";
import { setupRequirementsContinuity } from "./work-mode/requirements-continuity.js";
import { getExecutionContext, setExecutionContext } from "./lib/execution-context.js";

// ============================================================
// Entry
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- Shared state ----
  const initialExecutionContext = getExecutionContext();
  const isSubAgent = !!((globalThis as Record<string, unknown>).__pi_is_sub_agent);
  const phase: ConversationPhase =
    isSubAgent
      ? ((globalThis as Record<string, unknown>)
          .__pi_default_phase as ConversationPhase) ||
        initialExecutionContext.phase ||
        "work"
      : "work";
  delete (globalThis as Record<string, unknown>).__pi_default_phase;
  delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;

  const s = {
    phase,
    isSubAgent,
    planSteps: [] as PlanStep[],
    planFullText: "",
    pathAllowlist: new Set<string>(),
    cmdAllowlist: new Set<string>(),
    actionAllowlist: new Set<string>(),
    confirmedCalls: new Map<string, string>(),
  };

  resetStepIdCounter(0);

  // ---- Shared callbacks ----
  function persist(ctx: ExtensionContext) {
    const executionContext = getExecutionContext();
    pi.appendEntry("work-phase-state", {
      phase: s.phase,
      autonomy: executionContext.autonomy,
    });
    ctx.ui.setStatus(
      "work-mode",
      `${s.phase.toUpperCase()} · ${executionContext.autonomy.toUpperCase()}`,
    );
  }

  function setPhase(phase: ConversationPhase, ctx: ExtensionContext) {
    s.phase = phase;
    const current = getExecutionContext();
    const autonomy = phase === "work" ? current.autonomy : "guarded";
    setExecutionContext({
      ...current,
      phase,
      autonomy,
      approval: {
        ...current.approval,
        interactive: autonomy !== "auto",
        preauthorized: autonomy === "auto",
        inheritToChildren: autonomy === "auto",
      },
    });
    persist(ctx);
  }

  // ---- Wire modules (plan-feature first, then dependents) ----
  const planCb = setupPlanFeature(pi, s);
  setupRequirementsFeature(pi, s, {
    acceptContract: (contract, ctx) => {
      setPhase("work", ctx);
      planCb.replacePlanSteps(
        contract.steps,
        ctx,
        formatWorkContract(contract),
      );
    },
    pauseForRevision: (ctx) => {
      setPhase("plan", ctx);
    },
  });
  setupRequirementsContinuity(pi);

  setupCore(pi, s, {
    resetForNewTurn: () => {
      s.confirmedCalls.clear();
    },
  });

  setupPermissionGuard(pi, s, {
    getCurrentStepIndex: planCb.getCurrentStepIndex,
  });
}
