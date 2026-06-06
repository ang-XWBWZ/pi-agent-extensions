/**
 * types.ts — work-mode 共享类型、常量、系统提示
 */

// ============================================================
// Types
// ============================================================

export type WorkMode = "plan" | "work" | "yolo";
export type AppState = "idle" | "planning" | "awaiting_confirm" | "working" | "error";

export type StepStatus = "pending" | "current" | "done" | "error" | "skipped";

export interface PlanStep {
  id: number;
  text: string;
  status: StepStatus;
}

export interface ModeEntry {
  type: "custom";
  customType: "work-mode-state";
  data: { mode: WorkMode };
}

// ============================================================
// Constants
// ============================================================

export const MAX_PLAN_STEPS = 10;
export const DEFAULT_VISIBLE_STEPS = 5;

export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /[/\\]node_modules[/\\]/,
  /[/\\]\.git[/\\]/,
  /[/\\]\.pi[/\\]/,
  /[/\\]\.agents[/\\]/,
  /[/\\]\.claude[/\\]/,
];

// ============================================================
// System prompt
// ============================================================

export const SMART_PLAN_PROMPT = `

## Smart Mode: decide for yourself

You are in **PLAN mode by default** (read-only, write/edit/terminal blocked).
Output ## Execution Plan for complex tasks → auto-switches to WORK mode.
After switching, immediately execute the plan using manage_plan(set_step_status).
Do NOT wait for user confirmation — the plan is auto-accepted.
Use /work to manually switch to WORK mode.
Protected paths (.git, .pi, .agents, .claude, node_modules) are still guarded.

### Before you act, assess the user request:

**No plan needed - just do it:**
- Pure Q&A, explaining concepts, reading/analyzing code
- Simple one-shot operations (check encoding, list files, search patterns)

**Plan needed - output a structured plan first:**
- Tasks involving file creation, modification, or deletion
- Multi-step operations with step dependencies
- Risky operations (destructive commands, mass modifications)
- Unfamiliar codebase - research needed before acting

### If you decide to plan:
You MUST start the plan section with this exact heading:

## Execution Plan

This marker is required for the system to detect your plan. Without it, your entire response will be treated as a normal reply and executed directly — no confirmation dialog will appear.

When you use the marker, the system will:
1. Detect your plan
2. Pop up a confirmation dialog for the user
3. After user confirms, switch to planned execution mode with progress panel

You should also self-assess security risks in your plan:
- Mark protected path operations
- Flag destructive commands
- Note credential handling
- Include backup/rollback strategies

### Safety nets (always active regardless of mode):
- Protected paths are blocked for write/edit
- In PLAN mode: write, edit, and all terminal commands (bash/cmd/powershell) are **blocked** entirely
- In WORK mode: destructive terminal commands require confirmation
- Working directory boundaries are enforced

### Key rules:
- For simple tasks: answer directly, no plan needed
- For complex tasks: output a plan WITH the ## Execution Plan marker
- Never hardcode API keys, tokens, or passwords
- Include backup/rollback strategy when modifying files`;
