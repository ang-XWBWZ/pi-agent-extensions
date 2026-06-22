/**
 * plan-feature.ts — 计划功能：manage_plan 工具 + 计划命令 + 计划生命周期事件
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, Container } from "@earendil-works/pi-tui";
import { type WorkMode, type AppState, type StepStatus, type PlanStep, MAX_PLAN_STEPS, DEFAULT_VISIBLE_STEPS } from "./types.js";
import { parsePlanSteps, renderPlanPanel, nextStepId, resetStepIdCounter } from "./plan-parser.js";
import { type SecurityFinding, securityReview, formatSecurityReview } from "./security-reviewer.js";

// ============================================================
// Shared state & callbacks
// ============================================================

export interface PlanState {
  mode: WorkMode;
  appState: AppState;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  planFullText: string;
  planProduced: boolean;
  planPanelExpanded: boolean;
  pendingErrorInfo: { stepIndex: number; message: string; isSevere: boolean } | null;
}

export interface PlanCallbacks {
  setMode: (m: WorkMode, ctx: ExtensionContext) => void;
  persist: (ctx: ExtensionContext) => void;
}

// ============================================================
// Setup
// ============================================================

export function setupPlanFeature(
  pi: ExtensionAPI,
  s: PlanState,
  cb: PlanCallbacks,
): {
  updatePlanPanel: (ctx: ExtensionContext) => void;
  closePlanPanel: (ctx: ExtensionContext) => void;
  clearPlanPanel: (ctx: ExtensionContext) => void;
  getCurrentStepIndex: () => number;
} {
  // ---- Widget helpers ----
  function updatePlanPanel(ctx: ExtensionContext) {
    if (s.isSubAgent) return;
    if (s.planSteps.length === 0) {
      ctx.ui.setWidget("plan-panel", undefined);
      return;
    }
    ctx.ui.setWidget("plan-panel", (_tui, theme) => ({
      render: (_width: number) => renderPlanPanel(s.planSteps, theme, s.planPanelExpanded),
      invalidate: () => _tui.requestRender?.(),
    }));
  }

  function clearAllSteps() {
    s.planSteps = [];
    s.planFullText = "";
    resetStepIdCounter(0);
    s.planPanelExpanded = false;
    s.pendingErrorInfo = null;
  }

  function closePlanPanel(ctx: ExtensionContext) {
    if (s.isSubAgent) return;
    clearAllSteps();
    ctx.ui.setWidget("plan-panel", undefined);
  }

  function clearPlanPanel(ctx: ExtensionContext) {
    clearAllSteps();
    ctx.ui.setWidget("plan-panel", undefined);
  }

  function getCurrentStepIndex(): number {
    return s.planSteps.findIndex(st => st.status === "current");
  }

  // ---- acceptPlan ----
  function acceptPlan(ctx: ExtensionContext) {
    s.mode = "work";
    s.appState = "working";
    s.pendingErrorInfo = null;
    cb.setMode("work", ctx);
    if (!s.isSubAgent && s.planSteps.length > 0) updatePlanPanel(ctx);
    ctx.ui.notify("计划已接受，切换到 WORK 模式执行", "info");
  }

  // ---- message_end: detect plan + show confirmation ----
  pi.on("message_end", async (event, ctx) => {
    const textParts = (event.message.content ?? []).filter(
      (c: { type: string }) => c.type === "text",
    );
    if (textParts.length === 0) return;
    if (!textParts.some((c: { text?: string }) => (c.text ?? "").trim().length > 50)) return;
    const fullText = textParts.map((c: { text?: string }) => c.text ?? "").join("\n");

    // Detect explicit ## Execution Plan — works in ANY mode
    //
    // ⚠️ 竞态保护：ctx.ui.select 是异步的，在等待用户响应期间
    // 下一轮 Agent 循环可能已经重置了 planProduced/planSteps。
    // 使用 generation 计数器标识一次原子操作：
    //   - 修改 planSteps 时递增 gen
    //   - await 后检查 gen 未变才执行后续逻辑
    if (!s.planProduced && s.planSteps.length === 0) {
      const hasExplicitPlan = /(?:^|\n)#{2,}\s*Execution\s+Plan\s*\n/i.test(fullText);
      if (hasExplicitPlan) {
        const parsed = parsePlanSteps(fullText);
        if (parsed.length > 0) {
          const _gen = (s as any)._planGen ?? 0;
          s.planProduced = true;
          s.planFullText = fullText;
          s.planSteps = parsed;
          s.appState = "planning";
          (s as any)._planGen = _gen + 1;
          updatePlanPanel(ctx);
          if (s.mode !== "plan") { s.mode = "plan"; cb.persist(ctx); }

          // Show confirmation dialog (message_end is async, UI works here)
          const choice = await ctx.ui.select(
            "是否接受此计划？",
            ["是，开始执行", "修改计划"],
          );

          // 竞态检测：await 期间如果 _planGen 已变（被重置），放弃执行
          if ((s as any)._planGen !== _gen + 1) {
            if (choice === "是，开始执行") {
              ctx.ui.notify("计划状态已变更，无法自动接受。请重新输出计划。", "warning");
            }
            return;
          }

          if (choice === "是，开始执行") {
            acceptPlan(ctx);
            setTimeout(() => {
              pi.sendUserMessage("请按计划步骤逐步执行，使用 manage_plan(set_step_status) 推进面板");
            }, 100);
          } else {
            s.planProduced = false;
            clearAllSteps();
            ctx.ui.notify("计划已放弃", "info");
          }
        }
      }
    }
  });

  // ---- agent_end: (plan continuation handled by SMART_PLAN_PROMPT) ----
  pi.on("tool_execution_end", (_event, ctx) => {
    if (s.mode !== "work" || s.planSteps.length === 0) return;
    updatePlanPanel(ctx);
  });

  // ============================================================
  // Commands
  // ============================================================

  pi.registerCommand("security-review", {
    description: "Run security review on the current plan text (manual trigger)",
    handler: (_a, ctx) => {
      if (!s.planFullText || s.planSteps.length === 0) {
        ctx.ui.notify("没有当前计划可审查。先使用 /plan 或让 AI 输出带 ## Execution Plan 标记的计划", "warning");
        return;
      }
      const findings = securityReview(s.planFullText, s.planSteps);
      if (findings.length === 0) {
        ctx.ui.notify("安全审查通过，未发现问题", "info");
      } else {
        ctx.ui.notify(formatSecurityReview(findings), "warning");
      }
    },
  });

  pi.registerCommand("plan-expand", {
    description: "展开计划面板显示全部步骤",
    handler: (_a, ctx) => {
      s.planPanelExpanded = true;
      updatePlanPanel(ctx);
      ctx.ui.notify("计划面板已展开", "info");
    },
  });

  pi.registerCommand("plan-collapse", {
    description: "折叠计划面板，以当前步骤为中心滚动显示 " + DEFAULT_VISIBLE_STEPS + " 步",
    handler: (_a, ctx) => {
      s.planPanelExpanded = false;
      updatePlanPanel(ctx);
      ctx.ui.notify("计划面板已折叠为滚动视图", "info");
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "终止当前计划，清除面板，回到空闲状态",
    handler: (_a, ctx) => {
      clearPlanPanel(ctx);
      s.appState = "idle";
      s.planProduced = false;
      ctx.ui.notify("计划已终止，面板已清除", "info");
    },
  });

  // ============================================================
  // manage_plan tool
  // ============================================================

  const isStatus = (x: unknown): x is StepStatus =>
    x === "pending" || x === "current" || x === "done" || x === "error" || x === "skipped";

  pi.registerTool({
    name: "manage_plan",
    label: "Manage Plan",
    description:
      "操控计划面板：设置步骤、推进进度、标记错误、清除面板。" +
      "让 AI 在执行过程中主动更新面板状态。",
    promptSnippet: "Update the plan panel (set steps, advance, mark errors, clear)",
    promptGuidelines: [
      "Use manage_plan to update the execution plan panel during task execution.",
      "Actions: 'set_steps' (replace all steps), 'set_step_status' (set a step's status), 'insert_step' (insert at position), 'delete_step' (remove by id/index), 'update_step' (edit step text), 'complete' (mark all done + close), 'clear' (remove panel), 'status' (query current plan state).",
      "Step statuses: 'pending' | 'current' | 'done' | 'error' | 'skipped'. Only ONE step should be 'current' at a time.",
      "Use set_step_status to advance: mark current step 'done', mark next step 'current'.",
      "Use set_steps to replace the current plan with a refined one (max 10 steps).",
      "Use clear when the task is done or the plan is no longer relevant.",
      "Advance one step at a time via set_step_status. Mark errors honestly — don't skip silently.",
      "FORBIDDEN: Do NOT clear the panel when steps remain unfinished, unless the user explicitly says so.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: set_steps | set_step_status | insert_step | delete_step | update_step | complete | clear | status" }),
      steps: Type.Optional(Type.Array(Type.String(), { description: "步骤文本列表 (set_steps 时使用，上限10)" })),
      stepId: Type.Optional(Type.Number({ description: "步骤 id（set_step_status/delete_step/update_step 时使用）" })),
      stepIndex: Type.Optional(Type.Number({ description: "步骤索引（insert_step 时使用，0-based，默认追加到末尾）" })),
      status: Type.Optional(Type.String({ description: "步骤状态: pending | current | done | error | skipped（set_step_status 时使用）" })),
      text: Type.Optional(Type.String({ description: "步骤文本（insert_step/update_step 时使用）" })),
    }),

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const action = typeof args.action === "string" ? args.action : "?";
      let detail = "";
      switch (action) {
        case "set_steps":
          detail = args.steps ? ` ${args.steps.length}步` : "";
          break;
        case "set_step_status":
          detail = ` #${args.stepId} → ${args.status}`;
          break;
        case "insert_step":
          detail = args.text ? ` "${args.text.slice(0, 30)}"` : "";
          break;
        case "delete_step":
          detail = ` #${args.stepId}`;
          break;
        case "update_step":
          detail = ` #${args.stepId}`;
          break;
        case "complete":
          detail = " ✅";
          break;
        case "clear":
          detail = " 🧹";
          break;
        case "status":
          detail = " 🔍";
          break;
      }
      text.setText(theme.fg("toolTitle", theme.bold(`manage_plan: ${action}${detail}`)));
      return text;
    },

    renderResult(result, options, theme, context) {
      const text = result.content
        ?.filter((c: { type: string; text?: string }) => c.type === "text")
        .map((c: { type: string; text?: string }) => c.text ?? "")
        .join("\n")
        .trim() ?? "";
      if (!text) return (context.lastComponent as Container) ?? new Container();

      const container = (context.lastComponent as Container) ?? new Container();
      container.clear();

      if (options.expanded) {
        // 展开：显示完整输出
        container.addChild(new Text(text, 0, 0));
      } else {
        // 折叠：只显示一行摘要
        const firstLine = text.split("\n")[0].slice(0, 100);
        const hint = text.includes("\n") || text.length > 100
          ? theme.fg("muted", " … (Ctrl+O 展开)")
          : "";
        container.addChild(new Text(firstLine + hint, 0, 0));
      }
      return container;
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "set_steps": {
          if (!params.steps || params.steps.length === 0) {
            return { content: [{ type: "text", text: "错误: set_steps 需要 steps 参数" }], details: { error: "missing_steps" } };
          }
          const texts = params.steps.slice(0, MAX_PLAN_STEPS);
          resetStepIdCounter(0);
          s.planSteps = texts.map((t, i) => ({
            id: nextStepId(),
            text: t,
            status: i === 0 ? "current" : "pending",
          }));
          s.planPanelExpanded = s.planSteps.length <= DEFAULT_VISIBLE_STEPS;
          s.pendingErrorInfo = null;
          updatePlanPanel(ctx);
          return { content: [{ type: "text", text: `✅ 计划面板已更新: ${s.planSteps.length} 步` }], details: { action: "set_steps", count: s.planSteps.length } };
        }

        case "set_step_status": {
          if (params.stepId == null || !isStatus(params.status)) {
            return { content: [{ type: "text", text: "错误: set_step_status 需要 stepId (number) 和 status (pending|current|done|error|skipped)" }], details: { error: "missing_params" } };
          }
          const target = s.planSteps.find(st => st.id === params.stepId);
          if (!target) {
            return { content: [{ type: "text", text: `错误: stepId ${params.stepId} 不存在` }], details: { error: "invalid_id" } };
          }
          if (params.status === "current") {
            for (const st of s.planSteps) { if (st.status === "current") st.status = "done"; }
          }
          target.status = params.status as StepStatus;
          updatePlanPanel(ctx);
          return { content: [{ type: "text", text: `步骤 #${target.id} "${target.text.slice(0, 40)}" → ${params.status}` }], details: { action: "set_step_status", stepId: target.id, status: params.status } };
        }

        case "insert_step": {
          if (!params.text) {
            return { content: [{ type: "text", text: "错误: insert_step 需要 text 参数" }], details: { error: "missing_text" } };
          }
          if (s.planSteps.length >= MAX_PLAN_STEPS) {
            return { content: [{ type: "text", text: `错误: 已达上限 ${MAX_PLAN_STEPS} 步` }], details: { error: "max_steps" } };
          }
          const idx = params.stepIndex != null ? params.stepIndex : s.planSteps.length;
          const clampedIdx = Math.max(0, Math.min(idx, s.planSteps.length));
          s.planSteps.splice(clampedIdx, 0, { id: nextStepId(), text: params.text, status: "pending" });
          updatePlanPanel(ctx);
          return { content: [{ type: "text", text: `➕ 在位置 ${clampedIdx + 1} 插入步骤: ${params.text.slice(0, 40)}` }], details: { action: "insert_step", stepIndex: clampedIdx } };
        }

        case "delete_step": {
          if (params.stepId == null) {
            return { content: [{ type: "text", text: "错误: delete_step 需要 stepId 参数" }], details: { error: "missing_stepId" } };
          }
          const idx = s.planSteps.findIndex(st => st.id === params.stepId);
          if (idx < 0) {
            return { content: [{ type: "text", text: `错误: stepId ${params.stepId} 不存在` }], details: { error: "invalid_id" } };
          }
          const removed = s.planSteps[idx];
          s.planSteps.splice(idx, 1);
          updatePlanPanel(ctx);
          return { content: [{ type: "text", text: `🗑 已删除步骤 #${removed.id}: ${removed.text.slice(0, 40)}` }], details: { action: "delete_step", stepId: removed.id } };
        }

        case "update_step": {
          if (params.stepId == null || !params.text) {
            return { content: [{ type: "text", text: "错误: update_step 需要 stepId 和 text 参数" }], details: { error: "missing_params" } };
          }
          const target2 = s.planSteps.find(st => st.id === params.stepId);
          if (!target2) {
            return { content: [{ type: "text", text: `错误: stepId ${params.stepId} 不存在` }], details: { error: "invalid_id" } };
          }
          target2.text = params.text;
          updatePlanPanel(ctx);
          return { content: [{ type: "text", text: `✏ 步骤 #${target2.id} 已更新: ${params.text.slice(0, 40)}` }], details: { action: "update_step", stepId: target2.id } };
        }

        case "status": {
          if (s.planSteps.length === 0) {
            return { content: [{ type: "text", text: "当前无计划" }], details: { action: "status", steps: [], count: 0 } };
          }
          const summary = s.planSteps.map(st => {
            const icon = st.status === "current" ? "▶" : st.status === "done" ? "✅" : st.status === "error" ? "❌" : st.status === "skipped" ? "⏭" : "○";
            return `${icon} [id=${st.id}] ${st.status}: ${st.text}`;
          }).join("\n");
          return {
            content: [{ type: "text", text: `计划面板状态 (${s.planSteps.length} 步):\n${summary}` }],
            details: { action: "status", steps: s.planSteps.map(st => ({ id: st.id, text: st.text, status: st.status })), count: s.planSteps.length },
          };
        }

        case "complete": {
          for (const st of s.planSteps) st.status = "done";
          closePlanPanel(ctx);
          s.appState = "working";
          return { content: [{ type: "text", text: "✅ 计划已全部完成，面板已关闭" }], details: { action: "complete" } };
        }

        case "clear": {
          clearPlanPanel(ctx);
          return { content: [{ type: "text", text: "🧹 计划面板已清除" }], details: { action: "clear" } };
        }

        default:
          return { content: [{ type: "text", text: `未知操作: ${params.action}\n支持: set_steps | set_step_status | insert_step | delete_step | update_step | complete | clear` }], details: { error: "unknown_action" } };
      }
    },
  });

  return { updatePlanPanel, closePlanPanel, clearPlanPanel, getCurrentStepIndex };
}
