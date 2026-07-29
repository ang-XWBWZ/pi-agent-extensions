import type { ConversationPhase } from "../lib/workflow-types.js";

export type { ConversationPhase };

export type StepStatus = "pending" | "current" | "done" | "error" | "skipped";

export interface PlanStep {
  id: number;
  text: string;
  status: StepStatus;
  evidence?: string;
  updatedAt?: number;
}

export interface PhaseEntry {
  type: "custom";
  customType: "work-phase-state";
  data: {
    phase: ConversationPhase;
    autonomy?: "guarded" | "auto";
  };
}

export const MAX_PLAN_STEPS = 10;
export const DEFAULT_VISIBLE_STEPS = 5;

export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(?:^|[/\\])node_modules(?:[/\\]|$)/,
  /(?:^|[/\\])\.git(?:[/\\]|$)/,
  /(?:^|[/\\])\.pi(?:[/\\]|$)/,
];

export const ADVISORY_PATH_PATTERNS: RegExp[] = [
  /(?:^|[/\\])\.agents(?:[/\\]|$)/,
  /(?:^|[/\\])\.claude(?:[/\\]|$)/,
];

export function workflowPromptForPhase(phase: ConversationPhase): string {
  const common = [
    "Pi workflow runtime:",
    "- Follow the newest user intent and keep routine work moving.",
    "- Runtime authorization is authoritative; tools must never elevate it.",
  ];

  if (phase === "chat") {
    return [
      ...common,
      "- CHAT is conversation-only: explain or clarify without repository side effects.",
    ].join("\n");
  }

  if (phase === "plan") {
    return [
      ...common,
      "- PLAN is read-only discovery and requirement confirmation.",
      "- Ask only blocking questions. Use assumptions for low-risk gaps.",
      "- When ready, call manage_requirements once with action=propose and a complete Work Contract.",
    ].join("\n");
  }

  return [
    ...common,
    "- WORK executes clear requests directly; do not add planning ceremony to small tasks.",
    "- If consequential ambiguity remains after inspection, propose one Work Contract before editing.",
    "- Use manage_plan only when progress has multiple meaningful steps.",
    "- Verify changed behavior before reporting completion.",
  ].join("\n");
}
