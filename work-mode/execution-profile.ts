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
  autoAll?: boolean;
  label: string;
}

export function profileFromPhase(input: {
  phase: ConversationPhase;
  isSubAgent: boolean;
  executionContext: ExecutionContext;
}): ExecutionProfile {
  const { phase, isSubAgent, executionContext } = input;

  if (phase === "chat") {
    return {
      intent: "chat",
      boundary: "read_only",
      approval: "deny_untrusted",
      ledger: "off",
      isSubAgent,
      autoAll: false,
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
      autoAll: false,
      label: "PLAN",
    };
  }

  if (executionContext.approval.preauthorized || executionContext.autonomy === "auto") {
    const autoAll = executionContext.approval.autoAll === true;
    return {
      intent: "work",
      boundary: "full_access",
      approval: "never_ask",
      ledger: executionContext.ledger,
      isSubAgent,
      autoAll,
      label: autoAll
        ? executionContext.ledger === "work_goal" ? "WORK+AUTO_ALL+AUDIT" : "WORK+AUTO_ALL"
        : executionContext.ledger === "work_goal" ? "WORK+AUTO+AUDIT" : "WORK+AUTO",
    };
  }

  return {
    intent: "work",
    boundary: "workspace_write",
    approval: "ask_risky",
    ledger: executionContext.ledger,
    isSubAgent,
    autoAll: false,
    label: executionContext.ledger === "work_goal" ? "WORK+AUDIT" : "WORK",
  };
}

export function formatProfileForPrompt(profile: ExecutionProfile): string {
  const rule =
    profile.intent === "chat"
      ? "CHAT is conversation-only; do not call tools."
      : profile.intent === "plan"
        ? "PLAN permits only recognized read-only discovery and structured requirement confirmation."
        : profile.approval === "never_ask"
          ? profile.autoAll
            ? "AUTO_ALL is explicit full consent for non-protected command calls; it does not invoke AI approval."
            : "AUTO sends command approval boundaries to the configured AUTO_FLASH model; missing or failed review blocks the command."
          : "Guarded Work allows routine scoped work and asks only at material risk boundaries.";
  return [
    `<pi_execution intent="${profile.intent}" boundary="${profile.boundary}" approval="${profile.approval}" ledger="${profile.ledger}">`,
    rule,
    profile.autoAll
      ? "To request full command authorization, include auto_all=true and a concise purpose in cmd/powershell calls."
      : "cmd/powershell auto_all=true is only a request; it cannot promote guarded authorization.",
    "</pi_execution>",
  ].join("\n");
}
