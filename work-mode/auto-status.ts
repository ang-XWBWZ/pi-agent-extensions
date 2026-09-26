/**
 * auto-status.ts — AUTO 模式运行状态管理、底栏指示器、防死循环熔断与任务终止控制
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExecutionContext } from "../lib/execution-context.js";
import { getSettingsSection } from "../lib/settings-io.js";
import { getAutoFlashModel } from "./auto-flash.js";

export const DEFAULT_MAX_AUTO_STEPS = 25;
export const AUTO_MAX_STEPS_SETTINGS_KEY = "autoMaxSteps";

let autoStopped = false;
let autoCircuitBroken = false;
let consecutiveAutoSteps = 0;
let currentAutoAction: string | undefined;
let stopAbortController: AbortController | undefined;

export function getMaxAutoSteps(): number {
  const custom = getSettingsSection(AUTO_MAX_STEPS_SETTINGS_KEY, undefined);
  if (typeof custom === "number" && custom > 0) {
    return Math.floor(custom);
  }
  return DEFAULT_MAX_AUTO_STEPS;
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
}

export function resetAutoStopped(): void {
  autoStopped = false;
}

export function isAutoCircuitBroken(): boolean {
  return autoCircuitBroken;
}

export function resetAutoCircuitBreaker(): void {
  autoCircuitBroken = false;
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
}

export function setAutoAction(action: string | undefined): void {
  currentAutoAction = action;
}

export function getAutoAction(): string | undefined {
  return currentAutoAction;
}

export function checkAutoCircuitBreaker(): { broken: boolean; reason?: string } {
  const maxSteps = getMaxAutoSteps();
  if (consecutiveAutoSteps >= maxSteps) {
    autoCircuitBroken = true;
    return {
      broken: true,
      reason: `AUTO 连续自动执行步数已达上限(${maxSteps})，已触发防死循环熔断并自动回退到 GUARDED 模式。请人工检查任务状态或手动确认后续操作。`,
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
    ctx.ui.setStatus("auto-status", "🛑 AUTO [已终止]");
    return;
  }

  if (autoCircuitBroken) {
    ctx.ui.setStatus("auto-status", `⚠️ AUTO [已熔断: 超${getMaxAutoSteps()}步]`);
    return;
  }

  if (!isAuto) {
    ctx.ui.setStatus("auto-status", undefined);
    currentAutoAction = undefined;
    return;
  }

  if (currentAutoAction) {
    ctx.ui.setStatus("auto-status", `🤖 AUTO [${currentAutoAction}]`);
  } else {
    const model = getAutoFlashModel();
    const modelStr = model ? `${model.provider}/${model.model}` : "未配置模型";
    ctx.ui.setStatus("auto-status", `🤖 AUTO [就绪 | ${modelStr}]`);
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
}

export function resetAutoSessionState(): void {
  autoStopped = false;
  autoCircuitBroken = false;
  consecutiveAutoSteps = 0;
  currentAutoAction = undefined;
  stopAbortController = undefined;
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
    return "AUTO [已终止]";
  }

  if (autoCircuitBroken) {
    return `AUTO [已熔断: 超${getMaxAutoSteps()}步]`;
  }

  const isAuto = executionContext?.autonomy === "auto";
  const isAutoAll = executionContext?.approval?.autoAll;

  if (currentAutoAction) {
    return `AUTO [${currentAutoAction}]`;
  }

  if (isAutoAll) {
    return "AUTO_ALL [就绪]";
  }

  if (isAuto) {
    return "AUTO [就绪]";
  }

  return "GUARDED";
}
