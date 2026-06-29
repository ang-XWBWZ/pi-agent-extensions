import type { ConversationPhase, ExecutionContext } from "../lib/workflow-types.js";

export type WorkIntent = "chat" | "plan" | "work";
export type ExecutionBoundary = "read_only" | "workspace_write" | "full_access";
export type ApprovalPolicy = "ask_all" | "ask_risky" | "never_ask" | "deny_untrusted";

export interface ExecutionProfile {
  intent: WorkIntent;
  boundary: ExecutionBoundary;
  approval: ApprovalPolicy;
  ledger: "off" | "work_goal";
  isSubAgent: boolean;
  label: string;
}

export function profileFromPhase(input: {
  phase: ConversationPhase;
  isSubAgent: boolean;
  executionContext: ExecutionContext;
}): ExecutionProfile {
  const { phase, isSubAgent, executionContext } = input;

  if (executionContext.approval.preauthorized || executionContext.autonomy === "auto") {
    return {
      intent: "work",
      boundary: "full_access",
      approval: "never_ask",
      ledger: executionContext.ledger,
      isSubAgent,
      label: executionContext.ledger === "work_goal" ? "WORK+GOAL" : "WORK+AUTO",
    };
  }

  if (phase === "chat") {
    return {
      intent: "chat",
      boundary: "read_only",
      approval: "deny_untrusted",
      ledger: "off",
      isSubAgent,
      label: "CHAT",
    };
  }

  if (phase === "plan") {
    return {
      intent: "plan",
      boundary: "read_only",
      approval: "deny_untrusted",
      ledger: "off",
      isSubAgent,
      label: "PLAN",
    };
  }

  return {
    intent: "work",
    boundary: "workspace_write",
    approval: "ask_risky",
    ledger: "off",
    isSubAgent,
    label: "WORK",
  };
}

export function formatProfileForPrompt(profile: ExecutionProfile): string {
  if (profile.ledger === "work_goal") {
    return [
      "Current execution profile:",
      "- intent: work",
      "- boundary: full access at extension layer",
      "- approval: never ask",
      "- ledger: work goal ledger enabled",
      "- continue autonomously around the active Work goal",
    ].join("\n");
  }

  if (profile.intent === "chat") {
    return [
      "Current execution profile:",
      "- intent: chat",
      "- boundary: read-only",
      "- approval: execution tools are denied",
      "- discuss, clarify, and avoid repository side effects",
    ].join("\n");
  }

  if (profile.intent === "plan") {
    return [
      "Current execution profile:",
      "- intent: plan",
      "- boundary: read-only",
      "- approval: execution tools are denied",
      "- produce a plan before edits or commands",
    ].join("\n");
  }

  if (profile.approval === "never_ask") {
    return [
      "Current execution profile:",
      "- intent: work",
      "- boundary: full access at extension layer",
      "- approval: never ask",
      "- autonomy: auto authorization inside Work, not a separate phase",
    ].join("\n");
  }

  return [
    "Current execution profile:",
    "- intent: work",
    "- boundary: workspace write",
    "- approval: ask before risky or out-of-workspace actions",
    "- prefer structured project tools over raw shell when available",
  ].join("\n");
}
