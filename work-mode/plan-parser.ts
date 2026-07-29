/** plan-parser.ts — step IDs and terminal plan-panel rendering. */

import type { PlanStep } from "./types.js";
import { DEFAULT_VISIBLE_STEPS } from "./types.js";

// Shared step IDs are assigned only by structured workflow tools.

let _stepIdCounter = 0;

/** Get next unique step ID */
export function nextStepId(): number {
  return ++_stepIdCounter;
}

/** Reset to 0 or given value */
export function resetStepIdCounter(value = 0): void {
  _stepIdCounter = value;
}

// ============================================================
// Plan panel rendering
// ============================================================

/** 渲染计划面板行（逻辑顺序模型 —— 每步独立状态） */
export function renderPlanPanel(
  steps: PlanStep[],
  theme: any,
  expanded: boolean,
): string[] {
  if (steps.length === 0) return [];

  const currentIdx = steps.findIndex(s => s.status === "current");
  const header = theme?.fg("accent", theme?.bold("执行计划")) ?? "执行计划";
  const lines: string[] = [header, ""];

  // 滑动窗口
  let windowStart: number;
  let windowEnd: number;
  const collapsed = !expanded && steps.length > DEFAULT_VISIBLE_STEPS;

  if (expanded) {
    windowStart = 0;
    windowEnd = steps.length;
  } else if (currentIdx < 0) {
    windowStart = 0;
    windowEnd = Math.min(steps.length, DEFAULT_VISIBLE_STEPS);
  } else {
    const half = Math.floor(DEFAULT_VISIBLE_STEPS / 2);
    windowStart = Math.max(0, currentIdx - half);
    windowEnd = Math.min(steps.length, windowStart + DEFAULT_VISIBLE_STEPS);
    if (windowEnd - windowStart < DEFAULT_VISIBLE_STEPS) {
      windowStart = Math.max(0, windowEnd - DEFAULT_VISIBLE_STEPS);
    }
  }

  if (windowStart > 0) {
    lines.push(theme?.fg("muted", `  ... 前 ${windowStart} 步`) ?? `  ... 前 ${windowStart} 步`);
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const step = steps[i];
    let icon: string;
    let style: (s: string) => string;

    switch (step.status) {
      case "error":
        icon = "❌";
        style = (s) => theme?.fg("error", s) ?? s;
        break;
      case "skipped":
        icon = "⏭";
        style = (s) => theme?.fg("muted", s) ?? s;
        break;
      case "done":
        icon = "✅";
        style = (s) => theme?.fg("success", s) ?? s;
        break;
      case "current":
        icon = "▶";
        style = (s) => theme?.fg("accent", s) ?? s;
        break;
      default: // pending
        icon = "○";
        style = (s) => theme?.fg("muted", s) ?? s;
    }

    const label = step.text.length > 70
      ? step.text.slice(0, 67) + "..."
      : step.text;
    lines.push(" " + icon + " " + style(label));
  }

  if (windowEnd < steps.length) {
    const remaining = steps.length - windowEnd;
    lines.push(theme?.fg("muted", `  ... 后 ${remaining} 步待执行`) ?? `  ... 后 ${remaining} 步待执行`);
  }

  if (expanded && steps.length > DEFAULT_VISIBLE_STEPS) {
    lines.push("");
    lines.push(theme?.fg("muted", `(共 ${steps.length} 步, /plan-collapse 折叠)`) ?? `(共 ${steps.length} 步)`);
  }

  return lines;
}
