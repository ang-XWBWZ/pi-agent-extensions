/**
 * work-mode.ts - collaboration phase, execution profile, requirements, and
 * progress panel wiring.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ConversationPhase, type AppState, type PlanStep } from "./work-mode/types.js";
import { resetStepIdCounter } from "./work-mode/plan-parser.js";
import { setupCore } from "./work-mode/core.js";
import { setupPermissionGuard } from "./work-mode/permission-guard.js";
import { setupPlanFeature } from "./work-mode/plan-feature.js";
import { setupRequirementsFeature } from "./work-mode/requirements-feature.js";
import { getExecutionContext, setExecutionContext } from "./lib/execution-context.js";

// ============================================================
// Entry
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- Shared state ----
  const phase: ConversationPhase =
    ((globalThis as Record<string, unknown>).__pi_default_phase as ConversationPhase) || "chat";
  const isSubAgent = !!((globalThis as Record<string, unknown>).__pi_is_sub_agent);
  delete (globalThis as Record<string, unknown>).__pi_default_phase;
  delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;

  const s = {
    phase,
    isSubAgent,
    appState: "idle" as AppState,
    planProduced: false,
    planSteps: [] as PlanStep[],
    planFullText: "",
    planPanelExpanded: false,
    pendingErrorInfo: null as { stepIndex: number; message: string; isSevere: boolean } | null,
    pathAllowlist: new Set<string>(),
    cmdAllowlist: new Set<string>(),
    confirmedCalls: new Map<string, string>(),
  };

  resetStepIdCounter(0);

  // ---- Shared callbacks ----
  function persist(ctx: ExtensionContext) {
    pi.appendEntry("work-phase-state", { phase: s.phase });
    ctx.ui.setStatus("work-mode", "PHASE: " + s.phase.toUpperCase());
  }

  function setPhase(phase: ConversationPhase, ctx: ExtensionContext) {
    s.phase = phase;
    persist(ctx);
    const current = getExecutionContext();
    setExecutionContext({ ...current, phase });
  }

  // ---- Wire modules (plan-feature first, then dependents) ----
  const planCb = setupPlanFeature(pi, s, { setPhase, persist });
  setupRequirementsFeature(pi);

  setupCore(pi, s, {
    clearPlanPanel: planCb.clearPlanPanel,
    resetForNewTurn: () => {
      s.planProduced = false;
      s.confirmedCalls.clear();
    },
  });

  setupPermissionGuard(pi, s, {
    getCurrentStepIndex: planCb.getCurrentStepIndex,
    setPhase,
    clearPlanPanel: planCb.clearPlanPanel,
    updatePlanPanel: planCb.updatePlanPanel,
    resetPlanProduced: () => { s.planProduced = false; },
  });
}
