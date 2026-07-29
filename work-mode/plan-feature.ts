/**
 * Structured execution progress for Work.
 *
 * Plans are created from structured tool input, never parsed from assistant
 * markdown. State changes are persisted as session audit entries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, Container } from "@earendil-works/pi-tui";
import { redactAuditText } from "../lib/audit-sanitize.js";
import {
  type ConversationPhase,
  type PlanStep,
  MAX_PLAN_STEPS,
  DEFAULT_VISIBLE_STEPS,
} from "./types.js";
import { renderPlanPanel, nextStepId, resetStepIdCounter } from "./plan-parser.js";
import { securityReview, formatSecurityReview } from "./security-reviewer.js";
import {
  advancePlanWithEvidence,
  hasUnfinishedPlan,
  isPlanComplete,
  setPlanStepStatus,
} from "./plan-state.js";

export interface PlanState {
  phase: ConversationPhase;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  planFullText: string;
  planPanelExpanded: boolean;
}

interface PlanEntry {
  type: "custom";
  customType: "work-plan-state";
  data: {
    steps: PlanStep[];
    fullText: string;
    completed: boolean;
  };
}

export function setupPlanFeature(
  pi: ExtensionAPI,
  s: PlanState,
): {
  updatePlanPanel: (ctx: ExtensionContext) => void;
  clearPlanPanel: (ctx: ExtensionContext) => void;
  getCurrentStepIndex: () => number;
  replacePlanSteps: (steps: string[], ctx: ExtensionContext, fullText?: string) => void;
} {
  function persistPlan(completed = false) {
    pi.appendEntry("work-plan-state", {
      steps: s.planSteps.map((step) => ({ ...step })),
      fullText: s.planFullText,
      completed,
    });
  }

  function updatePlanPanel(ctx: ExtensionContext) {
    if (s.isSubAgent) return;
    if (s.planSteps.length === 0) {
      ctx.ui.setWidget("plan-panel", undefined);
      return;
    }
    ctx.ui.setWidget("plan-panel", (_tui, theme) => ({
      render: (_width: number) =>
        renderPlanPanel(s.planSteps, theme, s.planPanelExpanded),
      invalidate: () => _tui.requestRender?.(),
    }));
  }

  function clearState() {
    s.planSteps = [];
    s.planFullText = "";
    s.planPanelExpanded = false;
    resetStepIdCounter(0);
  }

  function clearPlanPanel(ctx: ExtensionContext) {
    clearState();
    if (!s.isSubAgent) ctx.ui.setWidget("plan-panel", undefined);
    persistPlan(false);
  }

  function getCurrentStepIndex(): number {
    return s.planSteps.findIndex((step) => step.status === "current");
  }

  function replacePlanSteps(
    steps: string[],
    ctx: ExtensionContext,
    fullText = "",
  ) {
    const texts = steps
      .map((step) => redactAuditText(step.trim()).slice(0, 300))
      .filter(Boolean)
      .slice(0, MAX_PLAN_STEPS);
    resetStepIdCounter(0);
    s.planSteps = texts.map((text, index) => ({
      id: nextStepId(),
      text,
      status: index === 0 ? "current" : "pending",
      updatedAt: Date.now(),
    }));
    s.planFullText = fullText;
    s.planPanelExpanded = s.planSteps.length <= DEFAULT_VISIBLE_STEPS;
    updatePlanPanel(ctx);
    persistPlan(false);
  }

  pi.on("session_start", (_event, ctx) => {
    let restored: PlanEntry["data"] | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as PlanEntry).customType === "work-plan-state"
      ) {
        restored = (entry as PlanEntry).data;
      }
    }
    if (!restored) return;
    const validStatuses = new Set([
      "pending",
      "current",
      "done",
      "error",
      "skipped",
    ]);
    s.planSteps = (Array.isArray(restored.steps) ? restored.steps : [])
      .filter(
        (step) =>
          step &&
          Number.isFinite(step.id) &&
          typeof step.text === "string" &&
          step.text.trim().length > 0 &&
          validStatuses.has(step.status),
      )
      .slice(0, MAX_PLAN_STEPS)
      .map((step) => ({
        ...step,
        text: redactAuditText(step.text.trim()).slice(0, 300),
        evidence:
          typeof step.evidence === "string"
            ? redactAuditText(step.evidence.trim()).slice(0, 500) || undefined
            : undefined,
      }));
    let sawCurrent = false;
    for (const step of s.planSteps) {
      if (step.status !== "current") continue;
      if (sawCurrent) step.status = "pending";
      sawCurrent = true;
    }
    s.planFullText =
      typeof restored.fullText === "string"
        ? redactAuditText(restored.fullText).slice(0, 12_000)
        : "";
    resetStepIdCounter(Math.max(0, ...s.planSteps.map((step) => step.id)));
    updatePlanPanel(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (s.phase === "work" && s.planSteps.length > 0) updatePlanPanel(ctx);
  });

  pi.registerCommand("security-review", {
    description: "Run a rule-based review on the current structured plan",
    handler: async (_a, ctx) => {
      if (s.planSteps.length === 0) {
        ctx.ui.notify("当前没有可审查的执行计划", "warning");
        return;
      }
      const reviewText =
        s.planFullText || s.planSteps.map((step) => step.text).join("\n");
      const findings = securityReview(reviewText, s.planSteps);
      ctx.ui.notify(
        findings.length === 0 ? "安全审查通过，未发现问题" : formatSecurityReview(findings),
        findings.length === 0 ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("plan-expand", {
    description: "展开计划面板显示全部步骤",
    handler: async (_a, ctx) => {
      s.planPanelExpanded = true;
      updatePlanPanel(ctx);
    },
  });

  pi.registerCommand("plan-collapse", {
    description: "折叠计划面板",
    handler: async (_a, ctx) => {
      s.planPanelExpanded = false;
      updatePlanPanel(ctx);
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "按用户指令放弃当前计划并保留审计快照",
    handler: async (_a, ctx) => {
      clearPlanPanel(ctx);
      ctx.ui.notify("当前计划已由用户终止", "warning");
    },
  });

  const evidenceFrom = (value: unknown): string =>
    typeof value === "string"
      ? redactAuditText(value.trim()).slice(0, 500)
      : "";

  const statusErrorText = (error: string): string =>
    ({
      invalid_status:
        "错误: status 必须是 current | done | error | skipped。",
      missing_evidence: "错误: 结束当前步骤需要简短、可观察的 evidence。",
      no_current_step: "错误: 当前没有进行中的步骤。",
      invalid_id: "错误: stepId 不存在。",
      non_current_terminal_transition:
        "错误: 只有当前步骤可进入终态；请按顺序推进计划。",
      invalid_current_transition:
        "错误: 只有 pending 或 error 步骤可以重新设为 current。",
      current_step_exists:
        "错误: 已有步骤正在进行；请先用 advance 结束它。",
    })[error] ?? `错误: 无效的计划状态转换 (${error})`;

  pi.registerTool({
    name: "manage_plan",
    label: "Manage Plan",
    description:
      "Maintain truthful execution progress for multi-step Work. It does not confirm requirements or grant authorization.",
    promptSnippet: "Update truthful multi-step Work progress",
    promptGuidelines: [
      "Use manage_plan only for meaningful multi-step Work; use manage_requirements for contract confirmation.",
      "Use manage_plan action=advance with observable evidence to finish the current step and select the next one atomically.",
      "Never use manage_plan complete or force-clear while unfinished work remains.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "set_steps | advance | set_step_status | insert_step | delete_step | update_step | complete | clear | status",
      }),
      steps: Type.Optional(
        Type.Array(Type.String(), {
          description: "Top-level execution steps for set_steps (maximum 10)",
        }),
      ),
      stepId: Type.Optional(Type.Number({ description: "Stable plan step id" })),
      stepIndex: Type.Optional(
        Type.Number({ description: "Zero-based insertion index" }),
      ),
      status: Type.Optional(
        Type.String({
          description: "current | done | error | skipped",
        }),
      ),
      text: Type.Optional(Type.String({ description: "Step text" })),
      evidence: Type.Optional(
        Type.String({
          description:
            "Short observable evidence required for done, error, or skipped transitions",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Use with clear only after the user explicitly abandons unfinished work",
        }),
      ),
    }),

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const action = typeof args.action === "string" ? args.action : "?";
      const detail =
        action === "set_steps"
            ? ` ${args.steps?.length ?? 0}步`
          : action === "advance"
            ? ` → ${args.status ?? "?"}`
            : action === "set_step_status"
              ? ` #${args.stepId} → ${args.status}`
              : args.stepId != null
                ? ` #${args.stepId}`
                : "";
      text.setText(
        theme.fg("toolTitle", theme.bold(`manage_plan: ${action}${detail}`)),
      );
      return text;
    },

    renderResult(result, options, theme, context) {
      const output =
        result.content
          ?.flatMap((item) => (item.type === "text" ? [item.text ?? ""] : []))
          .join("\n")
          .trim() ?? "";
      if (!output) {
        return (context.lastComponent as Container) ?? new Container();
      }
      const container =
        (context.lastComponent as Container) ?? new Container();
      container.clear();
      const shown = options.expanded
        ? output
        : output.split("\n")[0].slice(0, 120) +
          (output.includes("\n") || output.length > 120
            ? theme.fg("muted", " … (Ctrl+O 展开)")
            : "");
      container.addChild(new Text(shown, 0, 0));
      return container;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (s.phase !== "work" && params.action !== "status") {
        return {
          content: [
            {
              type: "text",
              text: "manage_plan 只在 WORK 阶段更新进度；PLAN 请使用 manage_requirements。",
            },
          ],
          details: { error: "wrong_phase", phase: s.phase },
        };
      }

      switch (params.action) {
        case "set_steps": {
          if (!params.steps?.length) {
            return {
              content: [{ type: "text", text: "错误: set_steps 需要 steps" }],
              details: { error: "missing_steps" },
            };
          }
          if (hasUnfinishedPlan(s.planSteps)) {
            return {
              content: [
                {
                  type: "text",
                  text: "错误: 已有未完成计划；请推进或由用户通过 /plan-cancel 放弃，不能静默覆盖。",
                },
              ],
              details: { error: "unfinished_plan_exists" },
            };
          }
          replacePlanSteps(params.steps, ctx);
          return {
            content: [
              { type: "text", text: `计划已建立: ${s.planSteps.length} 步` },
            ],
            details: { action: "set_steps", steps: s.planSteps },
          };
        }

        case "advance": {
          const evidence = evidenceFrom(params.evidence);
          const result = advancePlanWithEvidence(
            s.planSteps,
            params.status,
            evidence,
          );
          if (!result.ok) {
            return {
              content: [{ type: "text", text: statusErrorText(result.error) }],
              details: result,
            };
          }
          updatePlanPanel(ctx);
          persistPlan(false);
          return {
            content: [
              {
                type: "text",
                text: result.next
                  ? `步骤 #${result.target.id} → ${result.status}（${result.target.evidence}）；下一步 #${result.next.id}: ${result.next.text}`
                  : `步骤 #${result.target.id} → ${result.status}（${result.target.evidence}）；没有剩余待办`,
              },
            ],
            details: { action: "advance", ...result },
          };
        }

        case "set_step_status": {
          if (params.stepId == null) {
            return {
              content: [
                {
                  type: "text",
                  text: "错误: set_step_status 需要有效的 stepId 和 status",
                },
              ],
              details: { error: "missing_params" },
            };
          }
          const result = setPlanStepStatus(
            s.planSteps,
            params.stepId,
            params.status,
            evidenceFrom(params.evidence),
          );
          if (!result.ok) {
            return {
              content: [
                { type: "text", text: statusErrorText(result.error) },
              ],
              details: result,
            };
          }
          updatePlanPanel(ctx);
          persistPlan(false);
          return {
            content: [
              {
                type: "text",
                text: `步骤 #${result.target.id} → ${result.status}${
                  result.target.evidence
                    ? `（${result.target.evidence}）`
                    : ""
                }`,
              },
            ],
            details: { action: "set_step_status", ...result },
          };
        }

        case "insert_step": {
          const value = params.text
            ? redactAuditText(params.text.trim()).slice(0, 300)
            : "";
          if (!value) {
            return {
              content: [{ type: "text", text: "错误: insert_step 需要 text" }],
              details: { error: "missing_text" },
            };
          }
          if (s.planSteps.length >= MAX_PLAN_STEPS) {
            return {
              content: [
                { type: "text", text: `错误: 计划最多 ${MAX_PLAN_STEPS} 步` },
              ],
              details: { error: "max_steps" },
            };
          }
          const index = Math.max(
            0,
            Math.min(params.stepIndex ?? s.planSteps.length, s.planSteps.length),
          );
          const step: PlanStep = {
            id: nextStepId(),
            text: value,
            status: "pending",
            updatedAt: Date.now(),
          };
          s.planSteps.splice(index, 0, step);
          updatePlanPanel(ctx);
          persistPlan(false);
          return {
            content: [{ type: "text", text: `已插入步骤 #${step.id}` }],
            details: { action: "insert_step", step, index },
          };
        }

        case "delete_step": {
          if (params.stepId == null) {
            return {
              content: [{ type: "text", text: "错误: delete_step 需要 stepId" }],
              details: { error: "missing_stepId" },
            };
          }
          const index = s.planSteps.findIndex(
            (step) => step.id === params.stepId,
          );
          if (index < 0) {
            return {
              content: [
                { type: "text", text: `错误: stepId ${params.stepId} 不存在` },
              ],
              details: { error: "invalid_id" },
            };
          }
          const [removed] = s.planSteps.splice(index, 1);
          if (removed.status === "current") {
            const next = s.planSteps.find((step) => step.status === "pending");
            if (next) {
              next.status = "current";
              next.updatedAt = Date.now();
            }
          }
          updatePlanPanel(ctx);
          persistPlan(false);
          return {
            content: [{ type: "text", text: `已删除步骤 #${removed.id}` }],
            details: { action: "delete_step", removed },
          };
        }

        case "update_step": {
          const value = params.text
            ? redactAuditText(params.text.trim()).slice(0, 300)
            : "";
          const target = s.planSteps.find((step) => step.id === params.stepId);
          if (!target || !value) {
            return {
              content: [
                {
                  type: "text",
                  text: "错误: update_step 需要有效的 stepId 和 text",
                },
              ],
              details: { error: "missing_params" },
            };
          }
          if (target.status === "done" || target.status === "skipped") {
            return {
              content: [
                {
                  type: "text",
                  text: "错误: 已完成或已跳过步骤是审计事实，不能静默改写。",
                },
              ],
              details: { error: "terminal_step_immutable" },
            };
          }
          target.text = value;
          target.updatedAt = Date.now();
          updatePlanPanel(ctx);
          persistPlan(false);
          return {
            content: [{ type: "text", text: `已更新步骤 #${target.id}` }],
            details: { action: "update_step", step: target },
          };
        }

        case "status": {
          if (s.planSteps.length === 0) {
            return {
              content: [{ type: "text", text: "当前无执行计划" }],
              details: { action: "status", steps: [] },
            };
          }
          const lines = s.planSteps.map(
            (step) =>
              `[${step.id}] ${step.status}: ${step.text}${
                step.evidence ? ` — evidence: ${step.evidence}` : ""
              }`,
          );
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              action: "status",
              steps: s.planSteps.map((step) => ({ ...step })),
            },
          };
        }

        case "complete": {
          const unfinished = s.planSteps.filter(
            (step) => step.status !== "done" && step.status !== "skipped",
          );
          if (!isPlanComplete(s.planSteps)) {
            return {
              content: [
                {
                  type: "text",
                  text: `无法完成计划：仍有 ${unfinished.length} 个未完成步骤。`,
                },
              ],
              details: { error: "unfinished_steps", unfinished },
            };
          }
          updatePlanPanel(ctx);
          persistPlan(true);
          return {
            content: [
              { type: "text", text: "计划已完成，最终状态保留用于审计" },
            ],
            details: { action: "complete", steps: s.planSteps },
          };
        }

        case "clear": {
          const unfinished = hasUnfinishedPlan(s.planSteps);
          if (unfinished && params.force !== true) {
            return {
              content: [
                {
                  type: "text",
                  text: "拒绝清除：计划尚未完成。仅在用户明确放弃后传 force=true。",
                },
              ],
              details: { error: "unfinished_plan" },
            };
          }
          clearPlanPanel(ctx);
          return {
            content: [{ type: "text", text: "计划面板已清除" }],
            details: { action: "clear" },
          };
        }

        default:
          return {
            content: [
              { type: "text", text: `未知 manage_plan 操作: ${params.action}` },
            ],
            details: { error: "unknown_action" },
          };
      }
    },
  });

  return {
    updatePlanPanel,
    clearPlanPanel,
    getCurrentStepIndex,
    replacePlanSteps,
  };
}
