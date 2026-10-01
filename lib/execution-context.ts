import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  ConversationPhase,
  ExecutionContext,
  LedgerPolicy,
} from "./workflow-types.js";
import {
  createSessionAutoState,
  createSessionCapabilityActivation,
  currentSessionRuntime,
  getSessionRuntime,
  registerSessionRuntime,
  releaseSessionRuntime,
  runWithSessionRuntime,
  type SessionRuntime,
} from "./session-runtime.js";

const CONTEXT_KEY = "__pi_execution_context";

const PHASES: ReadonlySet<string> = new Set(["chat", "plan", "work"]);
const AUTONOMY_LEVELS: ReadonlySet<string> = new Set(["guarded", "auto"]);
const LEDGER_POLICIES: ReadonlySet<string> = new Set(["off", "work_goal"]);

function boolFromEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function phaseFromEnv(value: string | undefined): ConversationPhase {
  return PHASES.has(value ?? "") ? (value as ConversationPhase) : "work";
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
      autoAll: boolFromEnv(process.env.PI_AUTO_ALL),
    },
    runtime: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  };
}

/**
 * 显式会话缺少 runtime 时的安全默认上下文：guarded、无预授权、不可继承。
 * 绝不回退到别的会话或默认高授权。
 */
function createFallbackContext(): ExecutionContext {
  return {
    sessionId: randomUUID(),
    phase: "work",
    autonomy: "guarded",
    ledger: "off",
    goalId: undefined,
    approval: {
      interactive: true,
      preauthorized: false,
      inheritToChildren: false,
      autoAll: false,
    },
    runtime: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  };
}

function cloneContext(ctx: ExecutionContext): ExecutionContext {
  return {
    ...ctx,
    approval: { ...ctx.approval },
    runtime: { ...ctx.runtime },
  };
}

// ---- 全局兼容存储（仅服务无会话身份的根/UI 兼容调用） ----

function legacyGet(): ExecutionContext {
  const globals = globalThis as Record<string, unknown>;
  let ctx = globals[CONTEXT_KEY] as ExecutionContext | undefined;
  if (!ctx) {
    ctx = createDefaultContext();
    globals[CONTEXT_KEY] = ctx;
  }
  return ctx;
}

function legacySet(ctx: ExecutionContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = cloneContext(ctx);
}

function legacyClear(): void {
  delete (globalThis as Record<string, unknown>)[CONTEXT_KEY];
}

/** 解析会话 runtime：显式 SessionManager 优先，其次当前 ALS 作用域。 */
function resolveRuntime(sessionManager?: object): SessionRuntime | undefined {
  if (sessionManager) return getSessionRuntime(sessionManager);
  return currentSessionRuntime();
}

function createRuntime(ctx: ExecutionContext): SessionRuntime {
  return {
    sessionId: ctx.sessionId,
    executionContext: ctx,
    capabilityActivation: createSessionCapabilityActivation(),
    autoState: createSessionAutoState(),
    isSubAgent: false,
    createdAt: Date.now(),
  };
}

// ---- 会话作用域 ----

/**
 * 在已注册会话的 runtime 作用域内运行 fn。未注册的显式会话不回退到别的会话
 * 运行时，但为兼容无会话身份的测试/UI 调用保留全局兼容存储路径。
 */
const warnedMissingRuntime = new WeakSet<object>();

/** A10：会话 runtime 缺失可观测，且不静默借用其他会话身份。 */
function warnMissingRuntimeOnce(sessionManager: object): void {
  if (warnedMissingRuntime.has(sessionManager)) return;
  warnedMissingRuntime.add(sessionManager);
  try {
    console.warn(
      "[execution-context] 会话 runtime 缺失：该会话未完成初始化，本次仅按无会话作用域运行，未借用其他会话授权。",
    );
  } catch {
    // 日志失败不影响主流程
  }
}

export function withSessionScope<T>(
  sessionManager: object | undefined,
  fn: () => T,
): T {
  const runtime = resolveRuntime(sessionManager);
  if (sessionManager && !runtime) warnMissingRuntimeOnce(sessionManager);
  return runWithSessionRuntime(runtime ?? (sessionManager ? createRuntime(createFallbackContext()) : undefined), fn);
}

/**
 * 会话启动专用：确保该会话有自己的 runtime（缺失时为 guarded 默认），并在其
 * ALS 作用域内运行 fn。只有会话生命周期入口可以使用它创建 runtime。
 */
export function withSessionBootstrapScope<T>(
  sessionManager: object,
  fn: () => T,
): T {
  return runWithSessionRuntime(ensureSessionRuntime(sessionManager), fn);
}

/** 取得（必要时创建）显式会话的 runtime，缺失时使用 guarded 默认。 */
export function ensureSessionRuntime(sessionManager: object): SessionRuntime {
  const existing = getSessionRuntime(sessionManager);
  if (existing) return existing;
  return registerSessionRuntime(
    sessionManager,
    createRuntime(createFallbackContext()),
  );
}

/** 用给定上下文绑定/覆盖显式会话的 runtime（子会话派发时继承父上下文）。 */
export function bindSessionExecutionContext(
  sessionManager: object,
  ctx: ExecutionContext,
): SessionRuntime {
  const existing = getSessionRuntime(sessionManager);
  if (existing) {
    existing.executionContext = { ...cloneContext(ctx), sessionId: existing.sessionId };
    return existing;
  }
  return registerSessionRuntime(
    sessionManager,
    createRuntime(cloneContext(ctx)),
  );
}

export function getExecutionContext(sessionManager?: object): ExecutionContext {
  const runtime = resolveRuntime(sessionManager);
  return runtime ? runtime.executionContext : legacyGet();
}

export function setExecutionContext(
  ctx: ExecutionContext,
  sessionManager?: object,
): void {
  const runtime = resolveRuntime(sessionManager);
  if (runtime) {
    runtime.executionContext = cloneContext(ctx);
    return;
  }
  legacySet(ctx);
}

export function initializeExecutionContext(
  input: {
    phase: ConversationPhase;
    autonomy?: AutonomyLevel;
    cwd: string;
    ledger?: LedgerPolicy;
    goalId?: string;
    autoAll?: boolean;
  },
  sessionManager?: object,
): ExecutionContext {
  const autonomy = input.phase === "work" ? input.autonomy ?? "guarded" : "guarded";
  const preauthorized = autonomy === "auto";
  const ctx: ExecutionContext = {
    sessionId: randomUUID(),
    phase: input.phase,
    autonomy,
    ledger: input.ledger ?? "off",
    goalId: input.goalId,
    approval: {
      interactive: !preauthorized,
      preauthorized,
      inheritToChildren: preauthorized,
      autoAll: input.autoAll === true,
    },
    runtime: {
      cwd: input.cwd,
      startedAt: Date.now(),
    },
  };
  const runtime = resolveRuntime(sessionManager);
  if (runtime) {
    // 保留同一会话已有的能力激活对象，避免初始化打断激活中的能力。
    ctx.sessionId = runtime.sessionId;
    runtime.executionContext = ctx;
  } else if (sessionManager) {
    registerSessionRuntime(sessionManager, createRuntime(ctx));
  } else {
    legacySet(ctx);
  }
  return ctx;
}

export function clearExecutionContext(sessionManager?: object): void {
  if (sessionManager) {
    releaseSessionRuntime(sessionManager);
    return;
  }
  const runtime = currentSessionRuntime();
  if (runtime) {
    runtime.executionContext = createFallbackContext();
    return;
  }
  legacyClear();
}

export function isPreauthorizedContext(ctx = getExecutionContext()): boolean {
  return ctx.approval.preauthorized || ctx.autonomy === "auto";
}

export function autonomyForSessionStart(
  isSubAgent: boolean,
  inherited = getExecutionContext(),
): AutonomyLevel {
  return isSubAgent &&
    inherited.autonomy === "auto" &&
    inherited.approval.inheritToChildren
    ? "auto"
    : "guarded";
}

/** Full command authorization follows AUTO only when the parent explicitly
 * enabled inheritance; a root session never restores this from stale state. */
export function autoAllForSessionStart(
  isSubAgent: boolean,
  inherited = getExecutionContext(),
): boolean {
  return isSubAgent &&
    inherited.autonomy === "auto" &&
    inherited.approval.inheritToChildren &&
    inherited.approval.autoAll === true;
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
    PI_AUTO_ALL: ctx.approval.autoAll ? "true" : "false",
  };
}
