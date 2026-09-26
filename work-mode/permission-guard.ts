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
import { getExecutionContext, setExecutionContext } from "../lib/execution-context.js";
import { type ConversationPhase, type PlanStep } from "./types.js";
import { confirmAndRemember, showAutoFlashFallbackConfirm } from "./confirm-dialog.js";
import { formatStatelessPlanContext, reviewWithAutoFlash, type AutoFlashReviewRequest } from "./auto-flash.js";
import {
  checkAutoCircuitBreaker,
  getOrCreateAutoAbortSignal,
  isAutoCircuitBroken,
  isAutoStopped,
  recordAutoStep,
  resetAutoCircuitBreaker,
  resetAutoSteps,
  updateAutoStatusBar,
} from "./auto-status.js";
import { profileFromPhase } from "./execution-profile.js";
import {
  decideToolCall,
  FILE_MUTATION_TOOLS,
  SHELL_TOOLS,
  commandOf,
  inputOf,
  pathOf,
  purposeOf,
  type ToolDecision,
  type ToolEffect,
} from "./tool-decision.js";

export interface PermissionState {
  phase: ConversationPhase;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  planFullText?: string;
  pathAllowlist: Set<string>;
  cmdAllowlist: Set<string>;
  actionAllowlist: Set<string>;
}

export interface PermissionCallbacks {
  getCurrentStepIndex: () => number;
  onCircuitBreak?: (reason: string, ctx: ExtensionContext) => void;
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
  callbacks?: PermissionCallbacks,
) {
  if (decision.warning) {
    ctx.ui.notify(decision.warning, "warning");
  }

  if (isAutoStopped()) {
    updateAutoStatusBar(ctx);
    return {
      block: true,
      reason: "用户已通过 /auto_stop 强制终止 AUTO 自动化任务",
      terminate: true,
    };
  }

  const executionContext = getExecutionContext();
  if (executionContext.autonomy === "auto" && decision.action !== "deny") {
    const breaker = checkAutoCircuitBreaker();
    if (breaker.broken) {
      if (callbacks?.onCircuitBreak) {
        callbacks.onCircuitBreak(breaker.reason ?? "步数超限", ctx);
      } else {
        setExecutionContext({
          ...executionContext,
          autonomy: "guarded",
          approval: {
            ...executionContext.approval,
            interactive: true,
            preauthorized: false,
            inheritToChildren: false,
            autoAll: false,
          },
        });
      }
      updateAutoStatusBar(ctx);
      ctx.ui.notify(
        breaker.reason ?? "AUTO 连续执行步数已达上限，已触发熔断并转为普通认证模式",
        "warning",
      );

      // 回到普通认证：基于 GUARDED 模式重新生成判定，进入普通人工审批流程
      const currentExecCtx = getExecutionContext();
      const guardedProfile = profileFromPhase({
        phase: state.phase,
        isSubAgent: state.isSubAgent,
        executionContext: currentExecCtx,
      });
      let guardedDecision = decideToolCall(guardedProfile, event, ctx);

      // 若在普通模式下原本为 allow（例如日常命令或只读/写入），因刚触发熔断，
      // 必须包装为人工普通认证放行确认，杜绝静默继续执行，无 10s 超时倒计时
      if (guardedDecision.action === "allow" && !guardedDecision.confirm) {
        if (SHELL_TOOLS.has(event.toolName)) {
          const command = commandOf(event);
          const purpose = purposeOf(event);
          guardedDecision = {
            action: "ask",
            effect: guardedDecision.effect,
            target: command,
            confirm: {
              type: "command",
              label: `AUTO 熔断人工确认: ${event.toolName}`,
              target: command,
              allowlist: "cmd",
              confirmedLabel: "熔断确认放行",
              purpose: purpose || breaker.reason,
              remember: false,
              onEdit: (edited) => {
                inputOf(event).command = edited;
                return true;
              },
            },
          };
        } else if (FILE_MUTATION_TOOLS.has(event.toolName)) {
          const path = pathOf(event, ctx.cwd) ?? event.toolName;
          const purpose = purposeOf(event);
          guardedDecision = {
            action: "ask",
            effect: guardedDecision.effect,
            target: path,
            confirm: {
              type: "path",
              label: `AUTO 熔断人工确认: ${event.toolName}`,
              target: path,
              allowlist: "path",
              confirmedLabel: "熔断确认放行",
              purpose: purpose || breaker.reason,
              remember: false,
            },
          };
        } else {
          const purpose = purposeOf(event);
          guardedDecision = {
            action: "ask",
            effect: guardedDecision.effect,
            target: event.toolName,
            confirm: {
              type: "action",
              label: `AUTO 熔断人工确认: ${event.toolName}`,
              target: event.toolName,
              allowlist: "action",
              confirmedLabel: "熔断确认放行",
              purpose: purpose || breaker.reason,
              remember: false,
            },
          };
        }
      }

      // 执行普通认证流程（无 10s 超时倒计时、无直接失败终止）
      const result = await applyDecision(guardedDecision, event, ctx, state, callbacks);
      if (!result?.block) {
        // 人工确认放行后，重置熔断标志与步数计数器
        resetAutoCircuitBreaker();
        resetAutoSteps();
        updateAutoStatusBar(ctx, `人工放行: ${event.toolName}`);
      }
      return result;
    }
  }

  if (decision.action === "allow") {
    if (decision.flashReview) {
      updateAutoStatusBar(ctx, `审核中: ${event.toolName}...`);
      const signal = getOrCreateAutoAbortSignal(ctx.signal);
      const planContext = (state.planSteps && state.planSteps.length > 0) || state.planFullText
        ? formatStatelessPlanContext(state.planSteps ?? [], state.planFullText)
        : undefined;
      const reviewReq: AutoFlashReviewRequest = {
        ...decision.flashReview,
        ...(planContext ? { planContext } : {}),
        signal,
      };
      const review = await reviewWithAutoFlash(ctx, reviewReq);
      if (isAutoStopped()) {
        updateAutoStatusBar(ctx);
        return {
          block: true,
          reason: "用户已通过 /auto_stop 强制终止 AUTO 自动化任务",
          terminate: true,
        };
      }
      if (!review.allow) {
        updateAutoStatusBar(ctx, `已拦截: ${event.toolName}`);
        const fallback = await showAutoFlashFallbackConfirm(
          ctx,
          reviewReq,
          review,
          state.isSubAgent,
        );
        if (isAutoStopped()) {
          updateAutoStatusBar(ctx);
          return {
            block: true,
            reason: "用户已通过 /auto_stop 强制终止 AUTO 自动化任务",
            terminate: true,
          };
        }
        if (fallback.action === "deny") {
          return {
            block: true,
            reason: fallback.reason ?? review.reason,
            terminate: fallback.timeout !== true,
          };
        }
        const step = recordAutoStep();
        updateAutoStatusBar(ctx, `人工放行: ${event.toolName} (#${step})`);
      } else {
        const step = recordAutoStep();
        updateAutoStatusBar(ctx, `已放行: ${event.toolName} (#${step})`);
        if (!review.skipped) {
          ctx.ui.notify(`AUTO_FLASH 已通过${review.modelRef ? `（${review.modelRef}）` : ""}：${review.reason}`, "info");
        }
      }
    } else if (executionContext.autonomy === "auto") {
      const step = recordAutoStep();
      const actionLabel = decision.effect === "read"
        ? `读取中: ${event.toolName} (#${step})`
        : `执行中: ${event.toolName} (#${step})`;
      updateAutoStatusBar(ctx, actionLabel);
    }
    return;
  }

  if (decision.action === "deny") {
    if (executionContext.autonomy === "auto") {
      updateAutoStatusBar(ctx, `硬拦截: ${event.toolName}`);
    }
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
    decision.confirm.purpose,
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
  if (typeof approved === "object") {
    return {
      block: true,
      reason: `${event.toolName} was denied by the user: ${approved.reason}`,
    };
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
    const result = await applyDecision(decision, event, ctx, state, callbacks);
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

    if (isAutoStopped() || isAutoCircuitBroken()) {
      return;
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

}
