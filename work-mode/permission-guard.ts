/**
 * permission-guard.ts - tool_call interception, confirmation routing,
 * protected-path enforcement, and plan-step error recovery.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestConfirm } from "../lib/confirm-bus.js";
import { getExecutionContext } from "../lib/execution-context.js";
import { type ConversationPhase, type AppState, type PlanStep } from "./types.js";
import { confirmAndRemember } from "./confirm-dialog.js";
import { profileFromPhase } from "./execution-profile.js";
import { decideToolCall, type ToolDecision } from "./tool-decision.js";

export interface PermissionState {
  phase: ConversationPhase;
  appState: AppState;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  pathAllowlist: Set<string>;
  cmdAllowlist: Set<string>;
  confirmedCalls: Map<string, string>;
  pendingErrorInfo: { stepIndex: number; message: string; isSevere: boolean } | null;
}

export interface PermissionCallbacks {
  getCurrentStepIndex: () => number;
  setPhase: (phase: ConversationPhase, ctx: ExtensionContext) => void;
  clearPlanPanel: (ctx: ExtensionContext) => void;
  updatePlanPanel: (ctx: ExtensionContext) => void;
  resetPlanProduced: () => void;
}

async function applyDecision(
  decision: ToolDecision,
  event: { toolCallId: string; toolName: string },
  ctx: ExtensionContext,
  s: PermissionState,
) {
  if (decision.action === "allow") return;

  if (decision.action === "deny") {
    return {
      block: true,
      reason: decision.reason ?? "Tool call denied by execution profile",
    };
  }

  if (!decision.confirm) return;

  const allowlist =
    decision.confirm.allowlist === "path" ? s.pathAllowlist : s.cmdAllowlist;
  const ok = await confirmAndRemember(
    ctx,
    allowlist,
    decision.confirm.type,
    decision.confirm.label,
    decision.confirm.target,
    s.isSubAgent,
    decision.confirm.onEdit,
  );

  if (!ok) {
    return {
      block: true,
      reason: event.toolName + " user denied",
    };
  }
  if (ok === "dialog") {
    s.confirmedCalls.set(event.toolCallId, decision.confirm.confirmedLabel);
  }
}

function handleErrorChoice(
  choice: string | undefined,
  ctx: ExtensionContext,
  s: PermissionState,
  cb: PermissionCallbacks,
) {
  if (choice === "继续执行" || choice === "继续执行 (跳过该步)") {
    const currIdx = cb.getCurrentStepIndex();
    if (currIdx >= 0 && currIdx < s.planSteps.length) {
      s.planSteps[currIdx].status = "skipped";
    }
    const nextIdx = currIdx + 1;
    if (nextIdx < s.planSteps.length) {
      s.planSteps[nextIdx].status = "current";
    }
    s.appState = "working";
    s.pendingErrorInfo = null;
    cb.updatePlanPanel(ctx);
    ctx.ui.notify("已跳过错误，继续执行", "info");
  } else if (choice === "重新规划") {
    cb.clearPlanPanel(ctx);
    cb.setPhase("plan", ctx);
    s.appState = "planning";
    cb.resetPlanProduced();
    ctx.ui.notify("已切换到 PLAN 模式，请重新制定计划", "info");
  } else {
    s.appState = "error";
    ctx.ui.notify("执行已中止", "warning");
  }
}

function isSevereError(text: string): boolean {
  return (
    text.includes("protected path") ||
    text.includes("blocked") ||
    text.includes("user denied") ||
    text.includes("Permission denied") ||
    text.includes("Access denied") ||
    text.includes("权限")
  );
}

export function setupPermissionGuard(
  pi: ExtensionAPI,
  s: PermissionState,
  cb: PermissionCallbacks,
) {
  pi.on("tool_call", async (event, ctx) => {
    if (s.appState === "error") {
      const safeTools = ["read", "manage_plan", "manage_requirements", "check_agent_results", "context"];
      if (safeTools.includes(event.toolName)) return;
      return {
        block: true,
        reason:
          "Execution is paused after an error. Choose continue, re-plan, or stop before using more tools.",
      };
    }

    const profile = profileFromPhase({
      phase: s.phase,
      isSubAgent: s.isSubAgent,
      executionContext: getExecutionContext(),
    });
    const decision = decideToolCall(profile, event, ctx);
    return applyDecision(decision, event, ctx, s);
  });

  pi.on("tool_result", async (event, ctx) => {
    const profile = profileFromPhase({
      phase: s.phase,
      isSubAgent: s.isSubAgent,
      executionContext: getExecutionContext(),
    });
    if (profile.approval === "never_ask") return;
    if (s.phase !== "work" || s.planSteps.length === 0) return;
    if (s.appState === "error") return;

    const currentIdx = cb.getCurrentStepIndex();
    if (currentIdx < 0) return;
    if (!event.isError) return;

    const textContent = event.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");

    const severe = isSevereError(textContent);
    s.planSteps[currentIdx].status = "error";
    s.appState = "error";
    cb.updatePlanPanel(ctx);

    const stepLabel = s.planSteps[currentIdx].text;
    s.pendingErrorInfo = {
      stepIndex: currentIdx,
      message: "Step " + stepLabel + " failed:\n" + textContent.slice(0, 300),
      isSevere: severe,
    };

    if (severe) {
      ctx.ui.notify("Severe error paused execution: " + textContent.slice(0, 100), "error");
      ctx.ui.setStatus("work-mode", "PHASE: " + s.phase.toUpperCase() + " PAUSED");
      return;
    }

    if (s.isSubAgent) {
      const choice = await requestConfirm(
        "error_recovery",
        s.pendingErrorInfo.message,
        "Step failed. How should execution continue?",
        ["继续执行", "重新规划", "中止"],
      );
      handleErrorChoice(choice, ctx, s, cb);
    } else {
      const choice = await ctx.ui.select(
        "Step failed\n\n" + s.pendingErrorInfo.message + "\n\nHow should execution continue?",
        ["继续执行 (跳过该步)", "重新规划", "中止执行"],
      );
      handleErrorChoice(choice, ctx, s, cb);
    }
  });

  pi.on("tool_result", (event) => {
    const label = s.confirmedCalls.get(event.toolCallId);
    if (!label) return;
    s.confirmedCalls.delete(event.toolCallId);

    const idx = event.content.findIndex((b: { type: string }) => b.type === "text");
    if (idx >= 0) {
      event.content[idx] = {
        ...event.content[idx],
        text: "[" + label + "]\n" + event.content[idx].text,
      };
    }
  });
}
