import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  ConversationPhase,
  ExecutionContext,
  LedgerPolicy,
} from "./workflow-types.js";

const CONTEXT_KEY = "__pi_execution_context";

const PHASES: ReadonlySet<string> = new Set(["chat", "plan", "work"]);
const AUTONOMY_LEVELS: ReadonlySet<string> = new Set(["guarded", "auto"]);
const LEDGER_POLICIES: ReadonlySet<string> = new Set(["off", "work_goal"]);

function boolFromEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function phaseFromEnv(value: string | undefined): ConversationPhase {
  return PHASES.has(value ?? "") ? (value as ConversationPhase) : "chat";
}

function autonomyFromEnv(value: string | undefined): AutonomyLevel {
  return AUTONOMY_LEVELS.has(value ?? "")
    ? (value as AutonomyLevel)
    : "guarded";
}

function ledgerFromEnv(value: string | undefined): LedgerPolicy {
  return LEDGER_POLICIES.has(value ?? "")
    ? (value as LedgerPolicy)
    : "off";
}

function createDefaultContext(): ExecutionContext {
  const autonomy = autonomyFromEnv(process.env.PI_AUTONOMY);
  const preauthorized = boolFromEnv(process.env.PI_PREAUTHORIZED) || autonomy === "auto";
  return {
    sessionId: randomUUID(),
    phase: phaseFromEnv(process.env.PI_PHASE),
    autonomy,
    ledger: ledgerFromEnv(process.env.PI_LEDGER),
    goalId: process.env.PI_GOAL_ID || undefined,
    approval: {
      interactive: !preauthorized,
      preauthorized,
      inheritToChildren: boolFromEnv(process.env.PI_INHERIT_APPROVAL),
    },
    runtime: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  };
}

export function getExecutionContext(): ExecutionContext {
  let ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as
    | ExecutionContext
    | undefined;
  if (!ctx) {
    ctx = createDefaultContext();
    (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
  }
  return ctx;
}

export function setExecutionContext(ctx: ExecutionContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = {
    ...ctx,
    approval: { ...ctx.approval },
    runtime: { ...ctx.runtime },
  };
}

export function clearExecutionContext(): void {
  delete (globalThis as Record<string, unknown>)[CONTEXT_KEY];
}

export function isPreauthorizedContext(ctx = getExecutionContext()): boolean {
  return ctx.approval.preauthorized || ctx.autonomy === "auto";
}

export function withPiExecutionEnv(
  env: NodeJS.ProcessEnv,
  ctx = getExecutionContext(),
): NodeJS.ProcessEnv {
  return {
    ...env,
    PI_PHASE: ctx.phase,
    PI_AUTONOMY: ctx.autonomy,
    PI_LEDGER: ctx.ledger,
    PI_GOAL_ID: ctx.goalId ?? "",
    PI_PREAUTHORIZED: ctx.approval.preauthorized ? "true" : "false",
    PI_INHERIT_APPROVAL: ctx.approval.inheritToChildren ? "true" : "false",
  };
}
