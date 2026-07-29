/**
 * Runtime authorization and audit.
 *
 * Every tool, including custom extension tools, receives a risk decision.
 * Non-read operations are recorded as session audit entries with secrets
 * redacted. A tool failure does not automatically falsify plan progress.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  auditTextPreview,
  compactAuditValue,
  redactAuditText,
} from "../lib/audit-sanitize.js";
import { getExecutionContext } from "../lib/execution-context.js";
import { type ConversationPhase, type PlanStep } from "./types.js";
import { confirmAndRemember } from "./confirm-dialog.js";
import { profileFromPhase } from "./execution-profile.js";
import {
  decideToolCall,
  type ToolDecision,
  type ToolEffect,
} from "./tool-decision.js";

export interface PermissionState {
  phase: ConversationPhase;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  pathAllowlist: Set<string>;
  cmdAllowlist: Set<string>;
  actionAllowlist: Set<string>;
  confirmedCalls: Map<string, string>;
}

export interface PermissionCallbacks {
  getCurrentStepIndex: () => number;
}

interface PendingAudit {
  toolName: string;
  effect: ToolEffect;
  target?: string;
  startedAt: number;
}

async function applyDecision(
  decision: ToolDecision,
  event: { toolCallId: string; toolName: string },
  ctx: ExtensionContext,
  state: PermissionState,
) {
  if (decision.warning) {
    ctx.ui.notify(decision.warning, "warning");
  }
  if (decision.action === "allow") return;

  if (decision.action === "deny") {
    return {
      block: true,
      reason: decision.reason ?? "Tool call denied by workflow authorization",
    };
  }
  if (!decision.confirm) return;

  const allowlist =
    decision.confirm.allowlist === "path"
      ? state.pathAllowlist
      : decision.confirm.allowlist === "cmd"
        ? state.cmdAllowlist
        : state.actionAllowlist;
  const approved = await confirmAndRemember(
    ctx,
    allowlist,
    decision.confirm.type,
    decision.confirm.label,
    decision.confirm.target,
    state.isSubAgent,
    decision.confirm.onEdit,
    decision.confirm.remember !== false,
  );
  if (!approved) {
    return {
      block: true,
      reason: `${event.toolName} was denied by the user`,
    };
  }
  if (approved === "dialog") {
    state.confirmedCalls.set(
      event.toolCallId,
      decision.confirm.confirmedLabel,
    );
  }
}

export function setupPermissionGuard(
  pi: ExtensionAPI,
  state: PermissionState,
  callbacks: PermissionCallbacks,
) {
  const pendingAudit = new Map<string, PendingAudit>();

  pi.on("tool_call", async (event, ctx) => {
    const executionContext = getExecutionContext();
    const profile = profileFromPhase({
      phase: state.phase,
      isSubAgent: state.isSubAgent,
      executionContext,
    });
    const decision = decideToolCall(profile, event, ctx);
    const result = await applyDecision(decision, event, ctx, state);
    const blocked = Boolean(result?.block);

    if (
      decision.effect !== "read" ||
      blocked ||
      decision.action === "ask" ||
      decision.warning
    ) {
      pi.appendEntry("work-audit", {
        kind: blocked
          ? "tool_blocked"
          : decision.warning
            ? "tool_warned"
          : decision.action === "ask"
            ? "tool_approved"
            : "tool_started",
        timestamp: Date.now(),
        phase: state.phase,
        autonomy: executionContext.autonomy,
        toolName: event.toolName,
        effect: decision.effect,
        target: decision.target
          ? redactAuditText(decision.target)
          : undefined,
        input: compactAuditValue((event as { input?: unknown }).input),
        reason: blocked
          ? redactAuditText(result?.reason ?? "blocked")
          : decision.warning || decision.reason
            ? redactAuditText(decision.warning ?? decision.reason ?? "")
            : undefined,
      });
    }

    if (!blocked && decision.effect !== "read") {
      pendingAudit.set(event.toolCallId, {
        toolName: event.toolName,
        effect: decision.effect,
        target: decision.target,
        startedAt: Date.now(),
      });
    }
    return result;
  });

  pi.on("tool_result", (event, ctx) => {
    const pending = pendingAudit.get(event.toolCallId);
    if (pending) {
      pendingAudit.delete(event.toolCallId);
      pi.appendEntry("work-audit", {
        kind: event.isError ? "tool_failed" : "tool_finished",
        timestamp: Date.now(),
        phase: state.phase,
        autonomy: getExecutionContext().autonomy,
        toolName: pending.toolName,
        effect: pending.effect,
        target: pending.target
          ? redactAuditText(pending.target)
          : undefined,
        durationMs: Date.now() - pending.startedAt,
        result: auditTextPreview(event.content),
      });
    }

    if (!event.isError || state.phase !== "work" || state.planSteps.length === 0) {
      return;
    }
    const currentIndex = callbacks.getCurrentStepIndex();
    if (currentIndex < 0) return;
    const preview = auditTextPreview(event.content) ?? "unknown tool error";
    const shortPreview = preview.replace(/\s+/g, " ").slice(0, 120);
    ctx.ui.notify(
      `工具调用失败（${shortPreview}）；步骤“${state.planSteps[currentIndex].text}”仍保持进行中，等待诊断或重试。`,
      "warning",
    );
  });

  pi.on("tool_result", (event) => {
    const label = state.confirmedCalls.get(event.toolCallId);
    if (!label) return;
    state.confirmedCalls.delete(event.toolCallId);
    const index = event.content.findIndex(
      (item: { type: string }) => item.type === "text",
    );
    if (index >= 0) {
      const item = event.content[index];
      if (item.type === "text") {
        event.content[index] = {
          ...item,
          text: `[${label}]\n${item.text}`,
        };
      }
    }
  });
}
