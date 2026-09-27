import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBusInput, registerBusUI, type BusUI } from "../lib/confirm-bus.js";
import { getWorkGoal } from "../lib/work-goal-store.js";
import {
  autonomyForSessionStart,
  autoAllForSessionStart,
  getExecutionContext,
  initializeExecutionContext,
  setExecutionContext,
} from "../lib/execution-context.js";
import {
  type ConversationPhase,
  type PhaseEntry,
  workflowPromptForPhase,
} from "./types.js";
import { formatProfileForPrompt, profileFromPhase } from "./execution-profile.js";
import { ensureAutoFlashSystemContext, getAutoFlashModel, registerAutoFlashCommand } from "./auto-flash.js";
import {
  resetAutoSessionState,
  resetAutoStateForTurn,
  setAutoStopped,
  updateAutoStatusBar,
} from "./auto-status.js";
import {
  formatImmutableCapabilityIndex,
  formatFullCapabilityCatalog,
  syncActiveToolsForPhase,
} from "../lib/capability-router.js";
import { registerCapabilityTool } from "../lib/capability-tool.js";

export interface CoreState {
  phase: ConversationPhase;
  isSubAgent: boolean;
}

interface WorkGoalSessionEntry {
  type: "custom";
  customType: "work-goal-state";
  data: {
    goalId?: string;
    active: boolean;
  };
}

export function setupCore(
  pi: ExtensionAPI,
  s: CoreState,
  callbacks: {
    resetForNewTurn: () => void;
  },
) {
  const { resetForNewTurn } = callbacks;

  let unregBus: (() => void) | undefined;
  let unregInput: (() => void) | undefined;

  registerCapabilityTool(pi);

  if (!s.isSubAgent) {
    pi.on("session_start", (_event, ctx) => {
      const busUI: BusUI = {
        select: (title, opts) => ctx.ui.select(title, opts),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        editor: (title, prefill) => ctx.ui.editor(title, prefill),
        notify: (msg, type) => ctx.ui.notify(msg, type as "info" | "warning" | "error"),
      };
      unregBus?.();
      unregInput?.();
      unregBus = registerBusUI(busUI);
      unregInput = registerBusInput(busUI);
    });
    pi.on("session_shutdown", () => {
      unregBus?.();
      unregInput?.();
    });
  }

  function updateStatus(ctx: ExtensionContext) {
    const executionContext = getExecutionContext();
    ctx.ui.setStatus(
      "work-mode",
      `${s.phase.toUpperCase()} · ${executionContext.approval.autoAll ? "AUTO_ALL" : executionContext.autonomy.toUpperCase()}`,
    );
    ctx.ui.setStatus("work-auth", "");
    updateAutoStatusBar(ctx);
  }

  function applyProfile(
    phase: ConversationPhase,
    autonomy: "guarded" | "auto",
    ctx: ExtensionContext,
    autoAll = false,
  ) {
    s.phase = phase;
    const current = getExecutionContext();
    setExecutionContext({
      ...current,
      phase,
      autonomy,
      approval: {
        ...current.approval,
        interactive: autonomy !== "auto",
        preauthorized: autonomy === "auto",
        inheritToChildren: autonomy === "auto",
        autoAll,
      },
    });
    pi.appendEntry("work-phase-state", { phase, autonomy, autoAll });
    updateStatus(ctx);
    syncActiveToolsForPhase(phase, pi);
  }

  function showPhaseNotification(ctx: ExtensionContext) {
    const labels: Record<ConversationPhase, string> = {
      chat: "CHAT phase - conversation and clarification",
      plan: "PLAN phase - requirement confirmation",
      work: `WORK phase - ${getExecutionContext().approval.autoAll ? "auto_all" : getExecutionContext().autonomy} authorization`,
    };
    ctx.ui.notify(labels[s.phase], "info");
  }

  pi.on("session_start", (_event, ctx) => {
    const inheritedContext = getExecutionContext();
    const restoredAutonomy = autonomyForSessionStart(
      s.isSubAgent,
      inheritedContext,
    );
    let restoredGoalId: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as PhaseEntry).customType === "work-phase-state"
      ) {
        const restoredPhase = (entry as PhaseEntry).data.phase;
        if (
          restoredPhase === "chat" ||
          restoredPhase === "plan" ||
          restoredPhase === "work"
        ) {
          s.phase = restoredPhase;
        }
      }
      if (
        entry.type === "custom" &&
        (entry as WorkGoalSessionEntry).customType === "work-goal-state"
      ) {
        const goalState = (entry as WorkGoalSessionEntry).data;
        restoredGoalId = goalState.active ? goalState.goalId : undefined;
      }
    }
    const restoredGoal = restoredGoalId
      ? getWorkGoal(restoredGoalId)
      : null;
    initializeExecutionContext({
      phase: s.phase,
      autonomy: restoredAutonomy,
      cwd: ctx.cwd,
      ledger: restoredGoal?.status === "active" ? "work_goal" : "off",
      goalId: restoredGoal?.status === "active" ? restoredGoal.id : undefined,
      autoAll: autoAllForSessionStart(s.isSubAgent, inheritedContext),
    });
    ctx.ui.setStatus(
      "work-goal",
      restoredGoal?.status === "active" ? `GOAL: ${restoredGoal.title}` : "",
    );
    updateStatus(ctx);
    syncActiveToolsForPhase(s.phase, pi);
  });

  pi.on("before_agent_start", (event, ctx) => {
    resetForNewTurn();
    resetAutoStateForTurn();
    updateAutoStatusBar(ctx);
    const profile = profileFromPhase({
      phase: s.phase,
      isSubAgent: s.isSubAgent,
      executionContext: getExecutionContext(),
    });
    const capabilityIndex = formatImmutableCapabilityIndex();
    const runtimePrompt = [
      formatProfileForPrompt(profile),
      workflowPromptForPhase(s.phase),
      ...(capabilityIndex ? [capabilityIndex] : []),
    ].join("\n\n");
    return { systemPrompt: event.systemPrompt + "\n\n" + runtimePrompt };
  });

  pi.registerCommand("chat", {
    description: "CHAT phase - pure conversation and clarification",
    handler: async (_a, ctx) => {
      resetAutoSessionState();
      applyProfile("chat", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "PLAN phase - confirm requirements before execution",
    handler: async (_a, ctx) => {
      resetAutoSessionState();
      applyProfile("plan", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("work", {
    description: "WORK phase - execute with guarded authorization",
    handler: async (_a, ctx) => {
      resetAutoSessionState();
      applyProfile("work", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("auto", {
    description: "WORK phase - AI-reviewed command authorization; use /auto_model to configure the reviewer",
    handler: async (_a, ctx) => {
      ensureAutoFlashSystemContext(ctx.cwd);
      resetAutoSessionState();
      applyProfile("work", "auto", ctx);
      const model = getAutoFlashModel();
      ctx.ui.notify(
        model
          ? `WORK phase - AUTO AI 审批（${model.provider}/${model.model}）`
          : "WORK phase - AUTO AI 审批；尚未配置 AI 审批模型，请执行 /auto_model <provider>/<model>",
        model ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("auto_all", {
    description: "WORK phase - explicitly authorize all non-protected command calls; use auto_all=true",
    handler: async (_a, ctx) => {
      resetAutoSessionState();
      applyProfile("work", "auto", ctx, true);
      ctx.ui.notify(
        "WORK phase - AUTO_ALL 全同意已启用；cmd/powershell 需传 auto_all=true 和 purpose，受保护路径仍硬拦截，不调用 AI 审批。",
        "warning",
      );
    },
  });

  const autoStopHandler = async (_a: string, ctx: ExtensionContext) => {
    setAutoStopped(true);
    if (typeof (ctx as any).abort === "function") {
      try {
        (ctx as any).abort();
      } catch {
        // ignore
      }
    }
    applyProfile("work", "guarded", ctx);
    updateAutoStatusBar(ctx, "已终止");
    ctx.ui.notify("已强制终止当前 AUTO 自动化任务，已回退至 GUARDED 手动确认模式。", "info");
  };

  pi.registerCommand("auto_stop", {
    description: "强制终止当前 AUTO 任务并回退到 GUARDED 模式，避免死循环",
    handler: autoStopHandler,
  });

  pi.registerCommand("auto_cancel", {
    description: "别名：强制终止当前 AUTO 任务 (/auto_stop)",
    handler: autoStopHandler,
  });

  pi.registerCommand("auto_abort", {
    description: "别名：强制终止当前 AUTO 任务 (/auto_stop)",
    handler: autoStopHandler,
  });

  registerAutoFlashCommand(pi);

  pi.registerCommand("yolo", {
    description: "Compatibility alias for /auto",
    handler: async (_a, ctx) => {
      ensureAutoFlashSystemContext(ctx.cwd);
      resetAutoSessionState();
      applyProfile("work", "auto", ctx);
      ctx.ui.notify("/yolo 已兼容映射到 /auto", "warning");
    },
  });

  const capabilitiesHandler = async (_a: string, ctx: ExtensionContext) => {
    const catalog = formatFullCapabilityCatalog();
    ctx.ui.notify(catalog, "info");
  };

  pi.registerCommand("capabilities", {
    description: "查看系统可用能力与工具功能清单 (PCS)",
    handler: capabilitiesHandler,
  });

  pi.registerCommand("caps", {
    description: "查看系统可用能力与工具功能清单别名 (/capabilities)",
    handler: capabilitiesHandler,
  });
}
