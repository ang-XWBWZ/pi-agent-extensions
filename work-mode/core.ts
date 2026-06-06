/**
 * core.ts — 工作模式核心：状态机 + /plan /work /yolo 命令 + Bus UI
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerBusUI, registerBusInput, type BusUI } from "../lib/confirm-bus.js";
import { type WorkMode, type AppState, type ModeEntry, SMART_PLAN_PROMPT } from "./types.js";

// ============================================================
// Shared state (owned by work-mode.ts, passed as parameter)
// ============================================================

export interface CoreState {
  mode: WorkMode;
  appState: AppState;
  needsPlan: boolean;
  planAccepted: boolean;
  isSubAgent: boolean;
}

// ============================================================
// Setup
// ============================================================

export function setupCore(pi: ExtensionAPI, s: CoreState, callbacks: {
  clearPlanPanel: (ctx: ExtensionContext) => void;
  resetForNewTurn: () => void;
}) {
  const { clearPlanPanel, resetForNewTurn } = callbacks;

  // ---- Bus UI (sub-agent confirm routing) ----
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

  // ---- Helpers ----
  function persist(ctx: ExtensionContext) {
    pi.appendEntry("work-mode-state", { mode: s.mode });
    ctx.ui.setStatus("work-mode", "MODE: " + s.mode.toUpperCase());
  }

  function setMode(m: WorkMode, ctx: ExtensionContext) {
    s.mode = m;
    persist(ctx);
  }

  function showModeNotification(ctx: ExtensionContext) {
    const labels: Record<string, string> = {
      plan: "PLAN mode - read-only, all mutations blocked",
      work: "WORK mode - cwd + protected path guard",
      yolo: "YOLO mode - unrestricted, user only",
    };
    ctx.ui.notify(labels[s.mode], "info");
  }

  // ---- Restore state from session ----
  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as ModeEntry).customType === "work-mode-state"
      ) {
        s.mode = (entry as ModeEntry).data.mode;
      }
    }
    ctx.ui.setStatus("work-mode", "MODE: " + s.mode.toUpperCase());
    s.needsPlan = false;
    s.appState = "idle";
    clearPlanPanel(ctx);
  });

  // ---- before_agent_start: inject Smart Mode prompt + reset plan state ----
  pi.on("before_agent_start", (event, _ctx) => {
    resetForNewTurn();
    if (s.mode === "yolo") return;
    if (s.isSubAgent) return;
    if (s.mode === "plan") {
      s.appState = "planning";
    } else {
      s.appState = "working";
    }
    return { systemPrompt: event.systemPrompt + SMART_PLAN_PROMPT };
  });

  // ---- Commands ----
  pi.registerCommand("plan", {
    description: "PLAN mode - read-only, write/edit & terminal blocked",
    handler: (_a, ctx) => {
      setMode("plan", ctx);
      s.needsPlan = true;
      s.planAccepted = false;
      s.appState = "planning";
      clearPlanPanel(ctx);
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("work", {
    description: "WORK mode - cwd guard + protected path guard",
    handler: (_a, ctx) => {
      setMode("work", ctx);
      s.needsPlan = false;
      s.planAccepted = true;
      s.appState = "working";
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("yolo", {
    description: "YOLO mode - unrestricted, user only",
    handler: (_a, ctx) => {
      setMode("yolo", ctx);
      s.appState = "working";
      clearPlanPanel(ctx);
      showModeNotification(ctx);
    },
  });
}
