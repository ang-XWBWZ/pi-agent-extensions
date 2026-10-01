/**
 * session-runtime.ts — 按会话隔离的运行状态注册表（A01）
 *
 * 每个 SDK 会话（根会话或子会话）拥有独立的执行上下文、能力激活状态和身份
 * 信息。注册表以 SessionManager 对象为键（WeakMap），并保留显式 sessionId
 * 映射用于消息与审计路由。
 *
 * AsyncLocalStorage 让同一会话事件处理链内的无参 getExecutionContext() /
 * getDefaultActivationState() 调用解析到正确会话，而不是共享的全局单份状态。
 *
 * 本模块不依赖 execution-context / capability-router，避免循环依赖。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "./workflow-types.js";

/** 单个会话的能力激活状态（与 capability-router 的结构兼容）。 */
export interface SessionCapabilityActivation {
  activated: Set<string>;
  activating: Map<string, Promise<void>>;
  /** Fixed native tool set initialized once per session. */
  mountedTools: Set<string>;
}

/** 单个会话的 AUTO 运行状态：停止标志、步数、熔断、AbortController、计划检查器。 */
export interface SessionAutoState {
  stopped: boolean;
  circuitBroken: boolean;
  steps: number;
  currentAction?: string;
  abortController?: AbortController;
  planChecker?: () => boolean;
}

export interface SessionRuntime {
  /** 稳定会话 ID，用于消息与审计路由。 */
  sessionId: string;
  executionContext: ExecutionContext;
  capabilityActivation: SessionCapabilityActivation;
  autoState: SessionAutoState;
  /** A08：子会话工具上限；工具投影必须与其求交集，不得重新打开被排除的工具。 */
  allowedTools?: ReadonlySet<string>;
  isSubAgent: boolean;
  parentSessionId?: string;
  jobId?: string;
  taskId?: string;
  createdAt: number;
}

/** SessionManager 只作为不透明键使用，因此用 object 而非具体类型。 */
export type SessionKey = object;

// Each extension can load a separate copy of this module through jiti. The
// identity maps and ALS must refer to the same container in every copy.
type RuntimeRegistry = {
  runtimeByManager: WeakMap<SessionKey, SessionRuntime>;
  runtimeById: Map<string, SessionRuntime>;
  store: AsyncLocalStorage<SessionRuntime | undefined>;
};
const globals = globalThis as Record<string, unknown>;
const key = "__pi_session_runtime_registry";
const shared = (globals[key] ??= {
  runtimeByManager: new WeakMap(), runtimeById: new Map(),
  store: new AsyncLocalStorage<SessionRuntime | undefined>(),
}) as RuntimeRegistry;
const { runtimeByManager, runtimeById, store } = shared;

export function currentSessionRuntime(): SessionRuntime | undefined {
  return store.getStore();
}

/** 在指定 runtime 的异步作用域内运行 fn；无 runtime 时清空继承的 ALS 作用域。 */
export function runWithSessionRuntime<T>(
  runtime: SessionRuntime | undefined,
  fn: () => T,
): T {
  return store.run(runtime, fn);
}

export function registerSessionRuntime(
  manager: SessionKey | undefined,
  runtime: SessionRuntime,
): SessionRuntime {
  if (manager) runtimeByManager.set(manager, runtime);
  runtimeById.set(runtime.sessionId, runtime);
  return runtime;
}

export function getSessionRuntime(
  manager: SessionKey | undefined,
): SessionRuntime | undefined {
  if (!manager) return undefined;
  return runtimeByManager.get(manager);
}

export function getSessionRuntimeById(
  sessionId: string,
): SessionRuntime | undefined {
  return runtimeById.get(sessionId);
}

/** 释放会话 runtime，避免长进程中的显式 sessionId 映射泄漏。 */
export function releaseSessionRuntime(manager: SessionKey | undefined): boolean {
  if (!manager) return false;
  const runtime = runtimeByManager.get(manager);
  if (!runtime) return false;
  runtimeByManager.delete(manager);
  runtimeById.delete(runtime.sessionId);
  return true;
}

export function listSessionRuntimes(): SessionRuntime[] {
  return Array.from(runtimeById.values());
}

export function createSessionCapabilityActivation(): SessionCapabilityActivation {
  return {
    activated: new Set<string>(),
    activating: new Map<string, Promise<void>>(),
    mountedTools: new Set<string>(),
  };
}

export function createSessionAutoState(): SessionAutoState {
  return { stopped: false, circuitBroken: false, steps: 0 };
}

export function newSessionId(): string {
  return randomUUID();
}
