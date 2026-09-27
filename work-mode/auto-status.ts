/**
 * auto-status.ts — AUTO 模式运行状态管理、底栏指示器、防死循环熔断与任务终止控制
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExecutionContext } from "../lib/execution-context.js";
import { getSettingsSection } from "../lib/settings-io.js";
import { getActiveWorkGoal, onGoalLifecycle } from "../lib/work-goal-store.js";
import { getAutoFlashModel } from "./auto-flash.js";

export const MAX_AUTO_STEPS_DEFAULT = 100;
export const MAX_AUTO_STEPS_WITH_PLAN = 200;
export const DEFAULT_MAX_AUTO_STEPS = 100;
export const AUTO_MAX_STEPS_SETTINGS_KEY = "autoMaxSteps";

let autoStopped = false;
let autoCircuitBroken = false;
let consecutiveAutoSteps = 0;
let currentAutoAction: string | undefined;
let stopAbortController: AbortController | undefined;

type PlanChecker = () => boolean;
let activePlanChecker: PlanChecker | undefined;

type StatusChangeListener = () => void;
const statusListeners = new Set<StatusChangeListener>();

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
export function registerActivePlanChecker(checker: PlanChecker | undefined): void {
  activePlanChecker = checker;
}

export function hasActivePlan(): boolean {
  try {
    return activePlanChecker ? activePlanChecker() : false;
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

export function hasActivePlanOrGoal(): boolean {
  return hasActivePlan() || hasActiveGoal();
}

// 自动监听目标生命周期事件（创建、完成、终止、删除），触发步数计数清零
onGoalLifecycle((_event) => {
  resetAutoSteps();
});

export function getMaxAutoSteps(hasPlanOrGoal?: boolean): number {
  const custom = getSettingsSection(AUTO_MAX_STEPS_SETTINGS_KEY, undefined);
  if (typeof custom === "number" && custom > 0) {
    return Math.floor(custom);
  }
  const hasPlan = hasPlanOrGoal !== undefined ? hasPlanOrGoal : hasActivePlanOrGoal();
  return hasPlan ? MAX_AUTO_STEPS_WITH_PLAN : MAX_AUTO_STEPS_DEFAULT;
}

export function isAutoStopped(): boolean {
  return autoStopped;
}

export function setAutoStopped(stopped: boolean): void {
  autoStopped = stopped;
  if (stopped) {
    stopAbortController?.abort();
    stopAbortController = undefined;
  }
  notifyAutoStatusChange();
}

export function resetAutoStopped(): void {
  autoStopped = false;
  notifyAutoStatusChange();
}

export function isAutoCircuitBroken(): boolean {
  return autoCircuitBroken;
}

export function resetAutoCircuitBreaker(): void {
  autoCircuitBroken = false;
  notifyAutoStatusChange();
}

export function getAutoStepCount(): number {
  return consecutiveAutoSteps;
}

export function recordAutoStep(): number {
  consecutiveAutoSteps++;
  return consecutiveAutoSteps;
}

export function resetAutoSteps(): void {
  consecutiveAutoSteps = 0;
  notifyAutoStatusChange();
}

export function setAutoAction(action: string | undefined): void {
  currentAutoAction = action;
  notifyAutoStatusChange();
}

export function getAutoAction(): string | undefined {
  return currentAutoAction;
}

export function checkAutoCircuitBreaker(): { broken: boolean; reason?: string } {
  const maxSteps = getMaxAutoSteps();
  if (consecutiveAutoSteps >= maxSteps) {
    autoCircuitBroken = true;
    notifyAutoStatusChange();
    const hasContext = hasActivePlanOrGoal();
    const contextDesc = hasContext ? "（有计划/目标进行中，限额200步）" : "（无计划/目标，限额100步）";
    return {
      broken: true,
      reason: `AUTO 连续自动执行步数已达上限(${maxSteps})${contextDesc}，已触发防死循环熔断并自动回退到普通认证模式。`,
    };
  }
  return { broken: false };
}

export function getOrCreateAutoAbortSignal(parentSignal?: AbortSignal): AbortSignal {
  stopAbortController = new AbortController();
  if (parentSignal) {
    if (parentSignal.aborted) {
      stopAbortController.abort();
    } else {
      parentSignal.addEventListener("abort", () => {
        stopAbortController?.abort();
      }, { once: true });
    }
  }
  return stopAbortController.signal;
}

export function updateAutoStatusBar(ctx: ExtensionContext, action?: string): void {
  if (!ctx?.ui?.setStatus) return;
  const executionContext = getExecutionContext();
  if (executionContext.phase !== "work") {
    ctx.ui.setStatus("auto-status", undefined);
    currentAutoAction = undefined;
    return;
  }

  const isAuto = executionContext.autonomy === "auto";

  if (action !== undefined) {
    currentAutoAction = action;
  }

  if (autoStopped) {
    ctx.ui.setStatus("auto-status", "AUTO [已终止]");
    return;
  }

  if (autoCircuitBroken) {
    ctx.ui.setStatus("auto-status", `AUTO [已熔断: 超${getMaxAutoSteps()}步]`);
    return;
  }

  if (!isAuto) {
    ctx.ui.setStatus("auto-status", undefined);
    currentAutoAction = undefined;
    return;
  }

  if (currentAutoAction) {
    ctx.ui.setStatus("auto-status", `AUTO [${currentAutoAction}]`);
  } else {
    const model = getAutoFlashModel();
    const modelStr = model ? `${model.provider}/${model.model}` : "未配置模型";
    ctx.ui.setStatus("auto-status", `AUTO [就绪 | ${modelStr}]`);
  }
}

export function clearAutoStatusBar(ctx: ExtensionContext): void {
  currentAutoAction = undefined;
  ctx?.ui?.setStatus?.("auto-status", undefined);
}

export function resetAutoStateForTurn(): void {
  consecutiveAutoSteps = 0;
  currentAutoAction = undefined;
  autoStopped = false;
  autoCircuitBroken = false;
  if (stopAbortController) {
    stopAbortController = undefined;
  }
  notifyAutoStatusChange();
}

export function resetAutoSessionState(): void {
  autoStopped = false;
  autoCircuitBroken = false;
  consecutiveAutoSteps = 0;
  currentAutoAction = undefined;
  stopAbortController = undefined;
  notifyAutoStatusChange();
}

/**
 * 获取纯文本、无表情的 AUTO / 工作模式状态简述（用于紧凑二行底栏右侧展示）
 */
export function getAutoStatusSummary(): string | undefined {
  const executionContext = getExecutionContext();
  const phase = executionContext?.phase;

  if (phase && phase !== "work") {
    return phase.toUpperCase();
  }

  if (autoStopped) {
    return "WORK · AUTO [已终止]";
  }

  if (autoCircuitBroken) {
    return `WORK · AUTO [已熔断: 超${getMaxAutoSteps()}步]`;
  }

  const isAuto = executionContext?.autonomy === "auto";
  const isAutoAll = executionContext?.approval?.autoAll;

  if (currentAutoAction) {
    return `WORK · AUTO [${currentAutoAction}]`;
  }

  if (isAutoAll) {
    return "WORK · AUTO_ALL [就绪]";
  }

  if (isAuto) {
    return "WORK · AUTO [就绪]";
  }

  return "WORK · GUARDED";
}
