import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBusInput, registerBusUI, type BusUI } from "../lib/confirm-bus.js";
import { getExecutionContext, setExecutionContext } from "../lib/execution-context.js";
import {
  type AppState,
  type ConversationPhase,
  type PhaseEntry,
  SMART_PLAN_PROMPT,
} from "./types.js";
import { formatProfileForPrompt, profileFromPhase } from "./execution-profile.js";

export interface CoreState {
  phase: ConversationPhase;
  appState: AppState;
  isSubAgent: boolean;
}

export function setupCore(
  pi: ExtensionAPI,
  s: CoreState,
  callbacks: {
    clearPlanPanel: (ctx: ExtensionContext) => void;
    resetForNewTurn: () => void;
  },
) {
  const { clearPlanPanel, resetForNewTurn } = callbacks;

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

  function setAutonomy(
    autonomy: "guarded" | "auto",
    ctx: ExtensionContext,
    inheritToChildren = autonomy === "auto",
  ) {
    const current = getExecutionContext();
    setExecutionContext({
      ...current,
      phase: s.phase,
      autonomy,
      ledger: autonomy === "auto" ? current.ledger : "off",
      goalId: autonomy === "auto" ? current.goalId : undefined,
      approval: {
        ...current.approval,
        interactive: autonomy !== "auto",
        preauthorized: autonomy === "auto",
        inheritToChildren,
      },
    });
    ctx.ui.setStatus("work-auth", "AUTH: " + autonomy.toUpperCase());
  }

  function showPhaseNotification(ctx: ExtensionContext) {
    const labels: Record<ConversationPhase, string> = {
      chat: "CHAT phase - conversation and clarification",
      plan: "PLAN phase - requirement confirmation",
      work: "WORK phase - execution with guarded authorization",
    };
    ctx.ui.notify(labels[s.phase], "info");
  }

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as PhaseEntry).customType === "work-phase-state"
      ) {
        s.phase = (entry as PhaseEntry).data.phase;
      }
    }
    ctx.ui.setStatus("work-mode", "PHASE: " + s.phase.toUpperCase());
    s.appState = "idle";
    clearPlanPanel(ctx);
  });

  pi.on("before_agent_start", (event, _ctx) => {
    resetForNewTurn();
    const profile = profileFromPhase({
      phase: s.phase,
      isSubAgent: s.isSubAgent,
      executionContext: getExecutionContext(),
    });
    const profilePrompt = "\n\n" + formatProfileForPrompt(profile);
    if (profile.ledger === "work_goal") {
      return { systemPrompt: event.systemPrompt + profilePrompt };
    }
    if (s.isSubAgent) return;
    if (s.phase === "plan") {
      s.appState = "planning";
    } else if (s.phase === "chat") {
      s.appState = "idle";
    } else {
      s.appState = "working";
    }
    return { systemPrompt: event.systemPrompt + profilePrompt + SMART_PLAN_PROMPT };
  });

  pi.registerCommand("chat", {
    description: "CHAT phase - pure conversation and clarification",
    handler: (_a, ctx) => {
      setPhase("chat", ctx);
      setAutonomy("guarded", ctx, false);
      s.appState = "idle";
      clearPlanPanel(ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "PLAN phase - confirm requirements before execution",
    handler: (_a, ctx) => {
      setPhase("plan", ctx);
      setAutonomy("guarded", ctx, false);
      s.appState = "planning";
      clearPlanPanel(ctx);
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("work", {
    description: "WORK phase - execute with guarded authorization",
    handler: (_a, ctx) => {
      setPhase("work", ctx);
      setAutonomy("guarded", ctx, false);
      s.appState = "working";
      showPhaseNotification(ctx);
    },
  });

  pi.registerCommand("auto", {
    description: "WORK phase - autonomous authorization",
    handler: (_a, ctx) => {
      setPhase("work", ctx);
      setAutonomy("auto", ctx, true);
      s.appState = "working";
      clearPlanPanel(ctx);
      ctx.ui.notify("WORK phase - autonomous authorization", "info");
    },
  });
}
