/**
 * plan-parser.ts — 计划步骤解析 & 面板渲染
 *
 * 从 AI 输出的 ## Execution Plan 段落中提取步骤列表，
 * 并渲染为终端计划面板。
 * 从 work-mode.ts 提取。
 */

import type { PlanStep } from "./types.js";
import { MAX_PLAN_STEPS, DEFAULT_VISIBLE_STEPS } from "./types.js";

// ============================================================
// Shared step ID counter (used by parsePlanSteps and manage_plan)
// ============================================================

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
// Plan step parsing
// ============================================================

/** 从 AI 输出的计划文本中提取步骤列表 —— 仅解析 ## Execution Plan 段落 */
export function parsePlanSteps(text: string): PlanStep[] {
  // 只提取 ## Execution Plan 之后到下一个 ## 标题或文件末尾的内容
  const planMatch = text.match(/(?:^|\n)#{2,}\s*Execution\s+Plan\s*\n([\s\S]*?)(?:\n#{2,}\s|\n*$)/i);
  const section = planMatch ? planMatch[1] : "";
  if (!section.trim()) return [];

  const lines = section.split("\n");
  const steps: PlanStep[] = [];
  let inCodeBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-z][\.\)])\s+(.+)/i);
    if (numbered) {
      const desc = numbered[1].trim();
      if (desc.length > 3) { steps.push({ id: nextStepId(), text: desc, status: "pending" }); continue; }
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      const desc = bullet[1].trim();
      if (desc.length > 3) { steps.push({ id: nextStepId(), text: desc, status: "pending" }); continue; }
    }
  }

  const result = steps.slice(0, MAX_PLAN_STEPS);
  // 第一个步骤自动标记为 current
  if (result.length > 0) result[0].status = "current";
  return result;
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
