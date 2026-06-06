/**
 * work-mode.ts — 工作模式扩展 v3
 *
 * 强制 Plan-First：AI 在回复前必须先进入 PLAN 模式、输出安全计划，
 * 产出计划后等待用户确认，确认后切换到 WORK 模式执行。
 *
 * 状态机: idle → planning → awaiting_confirm → working → error
 *
 * 拆分为 work-mode/ 子模块：
 *   types.ts · core.ts · permission-guard.ts · plan-feature.ts
 *   path-guard.ts · confirm-dialog.ts · plan-parser.ts · security-reviewer.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type WorkMode, type AppState, type PlanStep } from "./work-mode/types.js";
import { resetStepIdCounter } from "./work-mode/plan-parser.js";
import { setupCore } from "./work-mode/core.js";
import { setupPermissionGuard } from "./work-mode/permission-guard.js";
import { setupPlanFeature } from "./work-mode/plan-feature.js";

// ============================================================
// Entry
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- Shared state ----
  const mode: WorkMode =
    ((globalThis as Record<string, unknown>).__pi_default_mode as WorkMode) || "plan";
  const isSubAgent = !!((globalThis as Record<string, unknown>).__pi_is_sub_agent);
  delete (globalThis as Record<string, unknown>).__pi_default_mode;
  delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;

  const s = {
    mode,
    isSubAgent,
    appState: "idle" as AppState,
    needsPlan: false,
    planAccepted: false,
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
    pi.appendEntry("work-mode-state", { mode: s.mode });
    ctx.ui.setStatus("work-mode", "MODE: " + s.mode.toUpperCase());
  }

  function setMode(m: WorkMode, ctx: ExtensionContext) {
    s.mode = m;
    persist(ctx);
  }

  // ---- Wire modules (plan-feature first, then dependents) ----
  const planCb = setupPlanFeature(pi, s, { setMode, persist });

  setupCore(pi, s, {
    clearPlanPanel: planCb.clearPlanPanel,
    resetForNewTurn: () => {
      s.planProduced = false;
      s.confirmedCalls.clear();
    },
  });

  setupPermissionGuard(pi, s, {
    getCurrentStepIndex: planCb.getCurrentStepIndex,
    setMode,
    clearPlanPanel: planCb.clearPlanPanel,
    updatePlanPanel: planCb.updatePlanPanel,
    resetPlanProduced: () => { s.planProduced = false; },
  });
}
