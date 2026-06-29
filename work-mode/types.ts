import type { ConversationPhase } from "../lib/workflow-types.js";

export type { ConversationPhase };
export type AppState = "idle" | "planning" | "awaiting_confirm" | "working" | "error";

export type StepStatus = "pending" | "current" | "done" | "error" | "skipped";

export interface PlanStep {
  id: number;
  text: string;
  status: StepStatus;
}

export interface PhaseEntry {
  type: "custom";
  customType: "work-phase-state";
  data: { phase: ConversationPhase };
}

export const MAX_PLAN_STEPS = 10;
export const DEFAULT_VISIBLE_STEPS = 5;

export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /[/\\]node_modules[/\\]/,
  /[/\\]\.git[/\\]/,
  /[/\\]\.pi[/\\]/,
  /[/\\]\.agents[/\\]/,
  /[/\\]\.claude[/\\]/,
];

export const SMART_PLAN_PROMPT = `

## Pi Work Profile

The user-facing mode is a collaboration phase. Permissions are handled by the
execution profile, not by the phase name.

### Phases and authorization
- /chat: pure conversation. Discuss, explain, and clarify without starting
  repository work.
- /plan: requirement confirmation. Read context, identify unknowns, ask focused
  questions, record assumptions, and produce a Work Contract.
- /work: execute the confirmed contract. Workspace edits are allowed; risky
  actions ask in guarded work.
- /auto: Work with autonomous authorization. This is an authorization level
  inside Work, not a separate phase.
- Work ledger: optional execution log for autonomous Work. It records what was
  done; it is not a separate mode.

### Plan phase protocol
Use manage_requirements when the request is ambiguous, cross-module, risky, or
has multiple incompatible interpretations. Track:
- objective, scope, out of scope
- blocking questions and resolved answers
- assumptions for low-risk gaps
- constraints and acceptance criteria
- risks and final Work Contract

Ask only questions that can change implementation, safety, scope, or acceptance.
If a gap is low-risk, state an assumption and record it. When objective, scope,
acceptance, and authorization are clear, mark requirements ready and move to Work.

### Work phase protocol
Use manage_plan for execution progress only. Do not use manage_plan to confirm
requirements; use manage_requirements for that.

If you decide a plan is needed, start with this exact heading:

## Execution Plan

### Execution guidance
- Prefer structured project tools when they exist.
- Use raw shell only when a structured tool does not fit.
- In Work guarded, expect confirmation for outside-workspace paths, deletion,
  dependency installation, git commit/push, and broad destructive commands.
- Protected paths (.git, .pi, .agents, .claude, node_modules) are guarded for
  direct write/edit in guarded Work.
- Never hardcode API keys, tokens, or passwords.
- Include rollback notes for risky file changes.`;
