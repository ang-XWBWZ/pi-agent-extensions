/**
 * auto-status.ts — AUTO 模式运行状态管理、底栏指示器、防死循环熔断与任务终止控制
 *
 * A05：停止标志、步数、熔断、AbortController 与计划检查器按会话独立。状态存放
 * 在会话 runtime 上（见 lib/session-runtime.ts）；无会话作用域的调用回退到全局
 * 兼容状态，保证测试与根 UI 行为不变。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExecutionContext } from "../lib/execution-context.js";
import {
  createSessionAutoState,
  currentSessionRuntime,
  getSessionRuntime,
  type SessionAutoState,
} from "../lib/session-runtime.js";
import { getSettingsSection } from "../lib/settings-io.js";
import { getActiveWorkGoal, onGoalLifecycle } from "../lib/work-goal-store.js";
import { getAutoFlashModel } from "./auto-flash.js";

export const MAX_AUTO_STEPS_DEFAULT = 100;
export const MAX_AUTO_STEPS_WITH_PLAN = 200;
export const DEFAULT_MAX_AUTO_STEPS = 100;
export const AUTO_MAX_STEPS_SETTINGS_KEY = "autoMaxSteps";

/** 无会话作用域时的兼容状态（测试 / 无身份的根 UI 调用）。 */
const legacyAutoState = createSessionAutoState();

type PlanChecker = () => boolean;

type StatusChangeListener = () => void;
const statusListeners = new Set<StatusChangeListener>();

/** 解析调用会话的 AUTO 状态。显式 manager 未注册时回退全局兼容状态。 */
function autoState(sessionManager?: object): SessionAutoState {
  if (sessionManager) {
    return getSessionRuntime(sessionManager)?.autoState ?? legacyAutoState;
  }
  return currentSessionRuntime()?.autoState ?? legacyAutoState;
}

/** 计划检查器优先用会话自己的；会话未注册时回退全局兼容检查器。 */
function resolvePlanChecker(sessionManager?: object): PlanChecker | undefined {
  const state = autoState(sessionManager);
  return state.planChecker ?? legacyAutoState.planChecker;
}

// 目标生命周期（创建/完成/终止/删除）重置当前作用域的步数计数：在有会话
// 作用域时只影响该会话，无作用域时回退全局兼容状态。
onGoalLifecycle(() => {
  resetAutoSteps();
});

/**
 * 订阅 AUTO / 工作模式状态变更事件（供底栏或 UI 实时重绘）
 */
export function onAutoStatusChange(listener: StatusChangeListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * 触发状态变更通知
 */
export function notifyAutoStatusChange(): void {
  for (const listener of statusListeners) {
    try {
      listener();
    } catch {
      // 忽略单个监听器异常
    }
  }
}

/**
 * 注册未完成计划检查器
 */
export function registerActivePlanChecker(
  checker: PlanChecker | undefined,
  sessionManager?: object,
): void {
  autoState(sessionManager).planChecker = checker;
}

export function hasActivePlan(sessionManager?: object): boolean {
  try {
    const checker = resolvePlanChecker(sessionManager);
    return checker ? checker() : false;
  } catch {
    return false;
  }
}

export function hasActiveGoal(): boolean {
  try {
    const goal = getActiveWorkGoal();
    return goal !== null && goal.status === "active";
  } catch {
    return false;
  }
}

export function hasActivePlanOrGoal(sessionManager?: object): boolean {
  return hasActivePlan(sessionManager) || hasActiveGoal();
}

export function getMaxAutoSteps(
  hasPlanOrGoal?: boolean,
  sessionManager?: object,
): number {
  const custom = getSettingsSection(AUTO_MAX_STEPS_SETTINGS_KEY, undefined);
  if (typeof custom === "number" && custom > 0) {
    return Math.floor(custom);
  }
  const hasPlan =
    hasPlanOrGoal !== undefined
      ? hasPlanOrGoal
      : hasActivePlanOrGoal(sessionManager);
  return hasPlan ? MAX_AUTO_STEPS_WITH_PLAN : MAX_AUTO_STEPS_DEFAULT;
}

export function isAutoStopped(sessionManager?: object): boolean {
  return autoState(sessionManager).stopped;
}

export function setAutoStopped(
  stopped: boolean,
  sessionManager?: object,
): void {
  const state = autoState(sessionManager);
  state.stopped = stopped;
  if (stopped) {
    state.abortController?.abort();
    state.abortController = undefined;
  }
  notifyAutoStatusChange();
}

export function resetAutoStopped(sessionManager?: object): void {
  autoState(sessionManager).stopped = false;
  notifyAutoStatusChange();
}

export function isAutoCircuitBroken(sessionManager?: object): boolean {
  return autoState(sessionManager).circuitBroken;
}

export function resetAutoCircuitBreaker(sessionManager?: object): void {
  autoState(sessionManager).circuitBroken = false;
  notifyAutoStatusChange();
}

export function getAutoStepCount(sessionManager?: object): number {
  return autoState(sessionManager).steps;
}

export function recordAutoStep(sessionManager?: object): number {
  const state = autoState(sessionManager);
  state.steps++;
  return state.steps;
}

export function resetAutoSteps(sessionManager?: object): void {
  autoState(sessionManager).steps = 0;
  notifyAutoStatusChange();
}

export function setAutoAction(
  action: string | undefined,
  sessionManager?: object,
): void {
  autoState(sessionManager).currentAction = action;
  notifyAutoStatusChange();
}

export function getAutoAction(sessionManager?: object): string | undefined {
  return autoState(sessionManager).currentAction;
}

export function checkAutoCircuitBreaker(sessionManager?: object): {
  broken: boolean;
  reason?: string;
} {
  const state = autoState(sessionManager);
  const maxSteps = getMaxAutoSteps(undefined, sessionManager);
  if (state.steps >= maxSteps) {
    state.circuitBroken = true;
    notifyAutoStatusChange();
    const hasContext = hasActivePlanOrGoal(sessionManager);
    const contextDesc = hasContext ? "（有计划/目标进行中，限额200步）" : "（无计划/目标，限额100步）";
    return {
      broken: true,
      reason: `AUTO 连续自动执行步数已达上限(${maxSteps})${contextDesc}，已触发防死循环熔断并自动回退到普通认证模式。`,
    };
  }
  return { broken: false };
}

export function getOrCreateAutoAbortSignal(
  parentSignal?: AbortSignal,
  sessionManager?: object,
): AbortSignal {
  const state = autoState(sessionManager);
  state.abortController = new AbortController();
  if (parentSignal) {
    if (parentSignal.aborted) {
      state.abortController.abort();
    } else {
      parentSignal.addEventListener("abort", () => {
        state.abortController?.abort();
      }, { once: true });
    }
  }
  return state.abortController.signal;
}

export function updateAutoStatusBar(ctx: ExtensionContext, action?: string): void {
  if (!ctx?.ui?.setStatus) return;
  const sessionManager = ctx?.sessionManager;
  const state = autoState(sessionManager);
  const executionContext = getExecutionContext(sessionManager);
  if (executionContext.phase !== "work") {
    ctx.ui.setStatus("auto-status", undefined);
    state.currentAction = undefined;
    return;
  }

  const isAuto = executionContext.autonomy === "auto";

  if (action !== undefined) {
    state.currentAction = action;
  }

  if (state.stopped) {
    ctx.ui.setStatus("auto-status", "AUTO [已终止]");
    return;
  }

  if (state.circuitBroken) {
    ctx.ui.setStatus("auto-status", `AUTO [已熔断: 超${getMaxAutoSteps(undefined, sessionManager)}步]`);
    return;
  }

  if (!isAuto) {
    ctx.ui.setStatus("auto-status", undefined);
    state.currentAction = undefined;
    return;
  }

  if (state.currentAction) {
    ctx.ui.setStatus("auto-status", `AUTO [${state.currentAction}]`);
  } else {
    const model = getAutoFlashModel();
    const modelStr = model ? `${model.provider}/${model.model}` : "未配置模型";
    ctx.ui.setStatus("auto-status", `AUTO [就绪 | ${modelStr}]`);
  }
}

export function clearAutoStatusBar(ctx: ExtensionContext): void {
  autoState(ctx?.sessionManager).currentAction = undefined;
  ctx?.ui?.setStatus?.("auto-status", undefined);
}

export function resetAutoStateForTurn(sessionManager?: object): void {
  const state = autoState(sessionManager);
  state.steps = 0;
  state.currentAction = undefined;
  state.stopped = false;
  state.circuitBroken = false;
  state.abortController = undefined;
  notifyAutoStatusChange();
}

export function resetAutoSessionState(sessionManager?: object): void {
  const state = autoState(sessionManager);
  state.stopped = false;
  state.circuitBroken = false;
  state.steps = 0;
  state.currentAction = undefined;
  state.abortController = undefined;
  notifyAutoStatusChange();
}

/**
 * 获取纯文本、无表情的 AUTO / 工作模式状态简述（用于紧凑二行底栏右侧展示）
 */
export function getAutoStatusSummary(sessionManager?: object): string | undefined {
  const state = autoState(sessionManager);
  const executionContext = getExecutionContext(sessionManager);
  const phase = executionContext?.phase;

  if (phase && phase !== "work") {
    return phase.toUpperCase();
  }

  if (state.stopped) {
    return "WORK · AUTO [已终止]";
  }

  if (state.circuitBroken) {
    return `WORK · AUTO [已熔断: 超${getMaxAutoSteps(undefined, sessionManager)}步]`;
  }

  const isAuto = executionContext?.autonomy === "auto";
  const isAutoAll = executionContext?.approval?.autoAll;

  if (state.currentAction) {
    return `WORK · AUTO [${state.currentAction}]`;
  }

  if (isAutoAll) {
    return "WORK · AUTO_ALL [就绪]";
  }

  if (isAuto) {
    return "WORK · AUTO [就绪]";
  }

  return "WORK · GUARDED";
}
