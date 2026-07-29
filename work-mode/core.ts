import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBusInput, registerBusUI, type BusUI } from "../lib/confirm-bus.js";
import { getWorkGoal } from "../lib/work-goal-store.js";
import {
  autonomyForSessionStart,
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
      `${s.phase.toUpperCase()} · ${executionContext.autonomy.toUpperCase()}`,
    );
    ctx.ui.setStatus("work-auth", "");
  }

  function applyProfile(
    phase: ConversationPhase,
    autonomy: "guarded" | "auto",
    ctx: ExtensionContext,
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
      },
    });
    pi.appendEntry("work-phase-state", { phase, autonomy });
    updateStatus(ctx);
  }

  function showPhaseNotification(ctx: ExtensionContext) {
    const labels: Record<ConversationPhase, string> = {
      chat: "CHAT phase - conversation and clarification",
      plan: "PLAN phase - requirement confirmation",
      work: `WORK phase - ${getExecutionContext().autonomy} authorization`,
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
    });
    ctx.ui.setStatus(
      "work-goal",
      restoredGoal?.status === "active" ? `GOAL: ${restoredGoal.title}` : "",
    );
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event, _ctx) => {
    resetForNewTurn();
    const profile = profileFromPhase({
      phase: s.phase,
      isSubAgent: s.isSubAgent,
      executionContext: getExecutionContext(),
    });
    const runtimePrompt = [
      formatProfileForPrompt(profile),
      workflowPromptForPhase(s.phase),
    ].join("\n\n");
    return { systemPrompt: event.systemPrompt + "\n\n" + runtimePrompt };
  });

  pi.registerCommand("chat", {
    description: "CHAT phase - pure conversation and clarification",
    handler: async (_a, ctx) => {
      applyProfile("chat", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "PLAN phase - confirm requirements before execution",
    handler: async (_a, ctx) => {
      applyProfile("plan", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("work", {
    description: "WORK phase - execute with guarded authorization",
    handler: async (_a, ctx) => {
      applyProfile("work", "guarded", ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("auto", {
    description: "WORK phase - autonomous authorization",
    handler: async (_a, ctx) => {
      applyProfile("work", "auto", ctx);
      ctx.ui.notify("WORK phase - autonomous authorization", "info");
    },
  });

  pi.registerCommand("yolo", {
    description: "Compatibility alias for /auto",
    handler: async (_a, ctx) => {
      applyProfile("work", "auto", ctx);
      ctx.ui.notify("/yolo 已兼容映射到 /auto", "warning");
    },
  });
}
