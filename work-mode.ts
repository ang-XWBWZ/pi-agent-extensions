/**
 * work-mode.ts — 工作模式扩展 v2
 *
 * 强制 Plan-First：AI 在回复前必须先进入 PLAN 模式、输出安全计划，
 * 产出计划后等待用户 /accept-plan 确认，确认后切换到 WORK 模式执行。
 * 编辑器上方显示 执行计划 面板，实时展示步骤完成进度。
 * 执行中出错时暂停等待用户决策（继续/重新规划/中止）。
 *
 * 状态机: idle → planning → awaiting_confirm → working ─→ error （出错时）
 *                                                   ↑_________| (继续)
 *                                                   ↓ (重新规划→plan)
 *
 * YOLO 仅限用户手动启用，子代理不可持有。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, isAbsolute } from "node:path";
import {
  requestConfirm,
  requestInput,
  registerBusUI,
  registerBusInput,
  type BusUI,
} from "./lib/confirm-bus.js";

// ============================================================
// Types
// ============================================================

type WorkMode = "plan" | "work" | "yolo";
type AppState = "idle" | "planning" | "awaiting_confirm" | "working" | "error";

interface ModeEntry {
  type: "custom";
  customType: "work-mode-state";
  data: { mode: WorkMode };
}

// ============================================================
// Protected paths (always blocked for write/edit/delete)
// ============================================================

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /[/\\]node_modules[/\\]/,
  /[/\\]\.git[/\\]/,
  /[/\\]\.pi[/\\]/,
  /[/\\]\.agents[/\\]/,
  /[/\\]\.claude[/\\]/,
];

function isProtectedPath(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(normalized));
}

// ============================================================
// Glob/pattern matching helpers
// ============================================================

function wildcardMatch(pattern: string, target: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(target.trim());
}

function isUnder(base: string, target: string): boolean {
  const b = base.endsWith("\\") || base.endsWith("/") ? base : base + "\\";
  const t = isAbsolute(target) ? target : resolve(base, target);
  return t.toLowerCase().startsWith(b.toLowerCase());
}

function resolvePath(base: string, p: string): string {
  const clean = p.replace(/^@/, "");
  return isAbsolute(clean) ? clean : resolve(base, clean);
}

function guessPathPattern(raw: string): string {
  const parts = raw.split(/[\\/]/);
  if (parts.length <= 2) return raw + "\\*";
  return parts.slice(0, -1).join("\\") + "\\*";
}

function guessCmdPattern(raw: string): string {
  return raw
    .replace(/"[^"]*"/g, "*")
    .replace(/'[^']*'/g, "*")
    .replace(/\S+/g, (w) =>
      /^[a-zA-Z0-9_./:-]+$/.test(w) ? w : "*",
    );
}

// ============================================================
// Confirm helpers
// ============================================================

async function showConfirm(
  ctx: ExtensionContext,
  label: string,
  options: string[],
  isSubAgent: boolean,
): Promise<string | undefined> {
  if (isSubAgent) return requestConfirm("path", label, "", options);
  return ctx.ui.select(label, options);
}

async function showBashConfirm(
  ctx: ExtensionContext,
  modeLabel: string,
  cmd: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no" | "edit"> {
  const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  const label = "Bash 确认 [" + modeLabel + "]  —  " + short;
  const options = ["允许本次", "始终允许此模式", "编辑后执行", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("bash", label, cmd, options);
    if (choice === "允许本次") return "yes";
    if (choice === "阻止" || choice === undefined) return "no";
    if (choice === "编辑后执行") return "edit";
    return "always";
  }

  const choice = await ctx.ui.select(label, options);
  if (choice === "允许本次") return "yes";
  if (choice === "阻止" || choice === undefined) return "no";
  if (choice === "编辑后执行") return "edit";
  return "always";
}

async function showPathConfirm(
  ctx: ExtensionContext,
  label: string,
  path: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no"> {
  const short = path.length > 80 ? "..." + path.slice(-77) : path;
  const title = label + " 确认  —  " + short;
  const options = ["允许本次", "始终允许此路径", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("path", title, path, options);
    if (choice === "允许本次") return "yes";
    if (choice === "始终允许此路径") return "always";
    return "no";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "允许本次") return "yes";
  if (choice === "始终允许此路径") return "always";
  return "no";
}

async function confirmAndRemember(
  ctx: ExtensionContext,
  allowlist: Set<string>,
  type: "path" | "bash",
  label: string,
  target: string,
  isSubAgent: boolean,
  onEdit?: (edited: string) => boolean,
): Promise<"dialog" | "silent" | false> {
  for (const pattern of allowlist) {
    if (wildcardMatch(pattern, target)) return "silent";
  }

  let action: "yes" | "always" | "no" | "edit";

  if (type === "bash") {
    action = await showBashConfirm(ctx, label, target, isSubAgent);
    if (action === "edit" && onEdit) {
      if (isSubAgent) {
        const edited = await requestInput("编辑后执行 (Enter确认/Esc取消)", target);
        if (edited && edited.trim()) {
          onEdit(edited.trim());
          return "dialog";
        }
        return false;
      }
      const edited = await ctx.ui.editor("编辑后执行 (Esc 取消)", target);
      if (edited && edited.trim()) {
        onEdit(edited.trim());
        return "dialog";
      }
      return false;
    }
  } else {
    action = await showPathConfirm(ctx, label, target, isSubAgent);
  }

  if (action === "yes") return "dialog";
  if (action === "no") return false;

  if (action === "always") {
    const pattern = type === "path" ? guessPathPattern(target) : guessCmdPattern(target);
    allowlist.add(pattern);
    ctx.ui.notify("已记住: " + pattern, "info");
    return "dialog";
  }

  return false;
}

// ============================================================
// Plan panel - 计划步骤解析 and Widget
// ============================================================

const MAX_PLAN_STEPS = 10;
const DEFAULT_VISIBLE_STEPS = 5;

/** 从 AI 输出的计划文本中提取步骤列表 —— 仅解析 ## Execution Plan 段落 */
function parsePlanSteps(text: string): string[] {
  // 只提取 ## Execution Plan 之后到下一个 ## 标题或文件末尾的内容
  const planMatch = text.match(/(?:^|\n)##\s+Execution\s+Plan\s*\n([\s\S]*?)(?:\n##\s|\n*$)/i);
  const section = planMatch ? planMatch[1] : "";
  if (!section.trim()) return [];

  const lines = section.split("\n");
  const steps: string[] = [];
  let inCodeBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-z][\.\)])\s+(.+)/i);
    if (numbered) {
      const desc = numbered[1].trim();
      if (desc.length > 3) { steps.push(desc); continue; }
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      const desc = bullet[1].trim();
      if (desc.length > 3) { steps.push(desc); continue; }
    }
  }

  return steps.slice(0, MAX_PLAN_STEPS);
}

/** 渲染计划面板行（含错误状态、折叠支持） */
function renderPlanPanel(
  steps: string[],
  currentIdx: number,
  errors: boolean[],
  theme: any,
  expanded: boolean,
): string[] {
  if (steps.length === 0) return [];

  const header = theme?.fg("accent", theme?.bold("执行计划")) ?? "执行计划";
  const lines: string[] = [header, ""];

  // 滑动窗口：展开模式显示全部，否则以 currentIdx 为中心显示 5 步
  let windowStart: number;
  let windowEnd: number;
  const collapsed = !expanded && steps.length > DEFAULT_VISIBLE_STEPS;

  if (expanded) {
    windowStart = 0;
    windowEnd = steps.length;
  } else if (currentIdx < 0) {
    // 计划阶段尚未开始执行，显示前 5 步
    windowStart = 0;
    windowEnd = Math.min(steps.length, DEFAULT_VISIBLE_STEPS);
  } else {
    // 以当前步骤为中心，前 2 后 2（共 5 步可见）
    const half = Math.floor(DEFAULT_VISIBLE_STEPS / 2);
    windowStart = Math.max(0, currentIdx - half);
    windowEnd = Math.min(steps.length, windowStart + DEFAULT_VISIBLE_STEPS);
    // 靠近末尾时，窗口起点往前移以保持 5 步可见
    if (windowEnd - windowStart < DEFAULT_VISIBLE_STEPS) {
      windowStart = Math.max(0, windowEnd - DEFAULT_VISIBLE_STEPS);
    }
  }

  // 窗口前省略提示
  if (windowStart > 0) {
    lines.push(theme?.fg("muted", `  ... 前 ${windowStart} 步已完成`) ?? `  ... 前 ${windowStart} 步已完成`);
  }

  for (let i = windowStart; i < windowEnd; i++) {
    let icon: string;
    let style: (s: string) => string;

    if (errors[i]) {
      icon = "❌";
      style = (s) => theme?.fg("error", s) ?? s;
    } else if (i < currentIdx) {
      icon = "✅";
      style = (s) => theme?.fg("success", s) ?? s;
    } else if (i === currentIdx) {
      icon = "▶";
      style = (s) => theme?.fg("accent", s) ?? s;
    } else {
      icon = "○";
      style = (s) => theme?.fg("muted", s) ?? s;
    }

    const label = steps[i].length > 70
      ? steps[i].slice(0, 67) + "..."
      : steps[i];
    lines.push(" " + icon + " " + style(label));
  }

  // 窗口后省略提示
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

// ============================================================
// 安全审查 - 计划文本的规则式安全检查
// ============================================================

interface SecurityFinding {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  suggestion: string;
}

/** 对计划文本执行安全审查 */
function securityReview(text: string, steps: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const fullText = text.toLowerCase();

  // ---- 受保护路径操作检查 ----
  if (PROTECTED_PATH_PATTERNS.some((re) => re.test(fullText))) {
    findings.push({
      severity: "high",
      category: "受保护路径",
      description: "计划涉及 node_modules/.git/.pi/.agents/.claude 等受保护路径的操作",
      suggestion: "确认这些操作是否必要；受保护路径在 WORK 模式下会被自动拦截",
    });
  }

  // ---- 目录越界检查 ----
  if (/\.\.\s*[\/]/.test(fullText) || /\.\.[\/]/.test(fullText)) {
    findings.push({
      severity: "high",
      category: "目录越界",
      description: "计划包含目录遍历操作（..），可能涉及当前工作目录以外的文件",
      suggestion: "明确操作的目标路径，确保在项目目录范围内",
    });
  }

  // ---- 破坏性命令检查 ----
  const destructivePatterns = [
    { cmd: /\brm\b.*-rf?\b|\brmdir\b.*\/s/i, label: "递归删除" },
    { cmd: /\bdel\b.*\/f/i, label: "强制删除" },
    { cmd: /\bformat\b|\bdiskpart\b/i, label: "格式化/磁盘操作" },
    { cmd: /\bicacls\b|\btakeown\b|\bcacls\b/i, label: "权限修改" },
    { cmd: /\breg\s+(delete|add|import)/i, label: "注册表修改" },
  ];
  for (const { cmd, label } of destructivePatterns) {
    if (cmd.test(fullText)) {
      findings.push({
        severity: "high",
        category: "破坏性操作",
        description: "计划包含" + label + "命令，可能造成不可逆的数据丢失",
        suggestion: "确保有完整的备份/回滚策略，考虑先用 --dry-run 或 /p 参数预览",
      });
    }
  }

  // ---- 备份/回滚检查 ----
  const hasWriteOps = /write|edit|修改|删除|覆盖|replace|update|delete|rename|move|copy/i.test(fullText);
  const hasBackup = /备份|backup|rollback|回滚|还原|restore|revert|暂存|stash|snapshot/i.test(fullText);
  if (hasWriteOps && !hasBackup && steps.length > 0) {
    findings.push({
      severity: "medium",
      category: "备份缺失",
      description: "计划包含修改/删除操作，但未明确提及备份或回滚策略",
      suggestion: "在涉及文件修改的步骤前添加备份（如 git stash / 复制副本）",
    });
  }

  // ---- 依赖/包管理检查 ----
  const hasInstall = /npm\s+install|pip\s+install|go\s+get|cargo\s+install|nuget\s+install|yarn\s+add/i.test(fullText);
  const hasPinned = /@\d+\.\d+\.\d+|==\d+\.\d+\.\d+|--save-exact|lockfile|lock\.json|yarn\.lock|package-lock\.json/i.test(fullText);
  if (hasInstall && !hasPinned) {
    findings.push({
      severity: "medium",
      category: "依赖管理",
      description: "计划包含安装依赖的命令但未指定版本锁定",
      suggestion: "使用精确版本号（如 npm install foo@1.2.3）或确保 lockfile 已提交",
    });
  }

  // ---- 硬编码配置/凭证检查 ----
  const secretPatterns = [/api.?key.?=|token.?=|password.?=|secret.?=|connection.?string/i];
  for (const pat of secretPatterns) {
    if (pat.test(fullText)) {
      findings.push({
        severity: "high",
        category: "凭证泄露风险",
        description: "计划文本中疑似包含 API Key / Token / 密码等敏感信息",
        suggestion: "使用环境变量或 .env 文件管理凭证，不要硬编码",
      });
    }
  }

  // ---- 大范围文件操作检查 ----
  if (/(\*|all|\.\/|global|全部|所有).*(replace|update|delete|rename|modify|修改|删除|替换)/i.test(fullText)) {
    findings.push({
      severity: "medium",
      category: "大范围操作",
      description: "计划包含大范围的文件操作（使用通配符或全局匹配）",
      suggestion: "明确文件列表，缩小操作范围；先用 ls 确认目标文件",
    });
  }

  // ---- 缺少步骤的风险评估 ----
  const hasRiskAssessment = /风险|risk|cautious|谨慎|注意|note|warn|⚠|❗/i.test(fullText);
  if (!hasRiskAssessment && steps.length > 2) {
    findings.push({
      severity: "low",
      category: "风险评估",
      description: "计划未明确标注各步骤的风险等级",
      suggestion: "为每个步骤标注风险：low（安全）/ medium（需注意）/ high（需确认）",
    });
  }

  return findings;
}

/** 格式化安全审查结果 */
function formatSecurityReview(findings: SecurityFinding[]): string {
  if (findings.length === 0) return "";

  const lines: string[] = ["安全审查结果:", ""];

  const severe = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");
  const low = findings.filter((f) => f.severity === "low");

  for (const [level, items] of [["高危", severe], ["中危", medium], ["低危", low]] as const) {
    if (items.length === 0) continue;
    lines.push(level + " - " + items.length + " 项");
    for (const f of items) {
      lines.push("  [" + f.category + "] " + f.description);
      lines.push("    建议: " + f.suggestion);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// Plan -> Work auto-switch system prompt snippet
// ============================================================

const SMART_PLAN_PROMPT = `

## Smart Mode: decide for yourself

You are in **WORK mode by default**. All tools including write/edit are available.
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
- Destructive bash commands require confirmation
- Working directory boundaries are enforced

### Key rules:
- For simple tasks: answer directly, no plan needed
- For complex tasks: output a plan WITH the ## Execution Plan marker
- Never hardcode API keys, tokens, or passwords
- Include backup/rollback strategy when modifying files`;

// ============================================================
// Extension entry
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- mode state ----
  let mode: WorkMode =
    ((globalThis as Record<string, unknown>).__pi_default_mode as WorkMode) ||
    "work";
  const isSubAgent = !!(
    (globalThis as Record<string, unknown>).__pi_is_sub_agent
  );
  delete (globalThis as Record<string, unknown>).__pi_default_mode;
  delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;

  // Internal state machine
  let appState: AppState = "idle";
  let planProduced = false;
  let needsPlan = false;
  let planAccepted = false;

  // Plan panel state
  let planSteps: string[] = [];
  let planFullText = "";
  let currentStepIndex = -1;
  let toolCallsInCurrentStep = 0;
  let stepErrors: boolean[] = [];
  let planPanelExpanded = false;

  // Error recovery
  let pendingErrorInfo: { stepIndex: number; message: string; isSevere: boolean } | null = null;

  const pathAllowlist = new Set<string>();
  const cmdAllowlist = new Set<string>();
  const confirmedCalls = new Map<string, string>();

  // ---- bus UI ----
  let unregBus: (() => void) | undefined;
  let unregInput: (() => void) | undefined;

  if (!isSubAgent) {
    pi.on("session_start", (_event, ctx) => {
      const busUI: BusUI = {
        select: (title, opts) => ctx.ui.select(title, opts),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        editor: (title, prefill) => ctx.ui.editor(title, prefill),
        notify: (msg, type) => ctx.ui.notify(msg, type as "info" | "warning" | "error"),
      };
      unregBus?.();
      unregInput?.();
      unregBus = registerBusUI(busUI);
      unregInput = registerBusInput(busUI);
    });
    pi.on("session_shutdown", () => {
      unregBus?.();
      unregInput?.();
    });
  }

  // ---- persistence and panel ----
  function persist(ctx: ExtensionContext) {
    pi.appendEntry("work-mode-state", { mode });
    ctx.ui.setStatus("work-mode", "MODE: " + mode.toUpperCase());
  }

  function setMode(m: WorkMode, ctx: ExtensionContext) {
    mode = m;
    persist(ctx);
  }

  function showModeNotification(ctx: ExtensionContext) {
    const labels: Record<string, string> = {
      plan: "PLAN mode - write/edit blocked",
      work: "WORK mode - cwd + protected path guard",
      yolo: "YOLO mode - unrestricted, user only",
    };
    ctx.ui.notify(labels[mode], "info");
  }

  /** 更新编辑器上方的计划面板 */
  function updatePlanPanel(ctx: ExtensionContext) {
    if (isSubAgent) return;
    if (planSteps.length === 0) {
      ctx.ui.setWidget("plan-panel", undefined);
      return;
    }
    ctx.ui.setWidget("plan-panel", (tui, theme) => ({
      render: () => renderPlanPanel(planSteps, currentStepIndex, stepErrors, theme, planPanelExpanded),
      invalidate: () => tui.requestRender?.(),
    }));
  }

  /** 关闭计划面板（完成时调用，清理状态防止重渲染） */
  function closePlanPanel(ctx: ExtensionContext) {
    if (isSubAgent) return;
    planSteps = [];
    planFullText = "";
    currentStepIndex = -1;
    toolCallsInCurrentStep = 0;
    stepErrors = [];
    ctx.ui.setWidget("plan-panel", undefined);
  }

  /** 清除计划面板 */
  function clearPlanPanel(ctx: ExtensionContext) {
    planSteps = [];
    planFullText = "";
    currentStepIndex = -1;
    toolCallsInCurrentStep = 0;
    stepErrors = [];
    planPanelExpanded = false;
    pendingErrorInfo = null;
    ctx.ui.setWidget("plan-panel", undefined);
  }

  // ---- restore state from session ----
  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as ModeEntry).customType === "work-mode-state"
      ) {
        mode = (entry as ModeEntry).data.mode;
      }
    }
    ctx.ui.setStatus("work-mode", "MODE: " + mode.toUpperCase());
    needsPlan = false;
    appState = "idle";
    clearPlanPanel(ctx);
  });

  // ============================================================
  // Commands (user-only)
  // ============================================================

  pi.registerCommand("plan", {
    description: "PLAN mode - read-only, write/edit blocked",
    handler: (_a, ctx) => {
      setMode("plan", ctx);
      needsPlan = true;
      planAccepted = false;
      appState = "planning";
      planProduced = false;
      clearPlanPanel(ctx);
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("work", {
    description: "WORK mode - cwd guard + protected path guard",
    handler: (_a, ctx) => {
      setMode("work", ctx);
      needsPlan = false;
      planAccepted = true;
      appState = "working";
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("yolo", {
    description: "YOLO mode - unrestricted, user only",
    handler: (_a, ctx) => {
      setMode("yolo", ctx);
      appState = "working";
      clearPlanPanel(ctx);
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("security-review", {
    description: "Run security review on the current plan text (manual trigger)",
    handler: (_a, ctx) => {
      if (!planFullText || planSteps.length === 0) {
        ctx.ui.notify("没有当前计划可审查。先使用 /plan 或让 AI 输出带 ## Execution Plan 标记的计划", "warning");
        return;
      }
      const findings = securityReview(planFullText, planSteps);
      if (findings.length === 0) {
        ctx.ui.notify("安全审查通过，未发现问题", "info");
      } else {
        ctx.ui.notify(formatSecurityReview(findings), "warning");
      }
    },
  });

  pi.registerCommand("plan-expand", {
    description: "展开计划面板显示全部步骤",
    handler: (_a, ctx) => {
      planPanelExpanded = true;
      updatePlanPanel(ctx);
      ctx.ui.notify("计划面板已展开", "info");
    },
  });

  pi.registerCommand("plan-collapse", {
    description: "折叠计划面板，以当前步骤为中心滚动显示 " + DEFAULT_VISIBLE_STEPS + " 步",
    handler: (_a, ctx) => {
      planPanelExpanded = false;
      updatePlanPanel(ctx);
      ctx.ui.notify("计划面板已折叠为滚动视图", "info");
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "终止当前计划，清除面板，回到空闲状态",
    handler: (_a, ctx) => {
      clearPlanPanel(ctx);
      appState = "idle";
      planAccepted = false;
      planProduced = false;
      needsPlan = false;
      ctx.ui.notify("计划已终止，面板已清除", "info");
    },
  });

  /**
   * 用户接受计划 - 切换到 WORK 模式执行
   */
  function acceptPlan(ctx: ExtensionContext) {
    planAccepted = true;
    needsPlan = false;
    currentStepIndex = planSteps.length > 0 ? 0 : -1;
    toolCallsInCurrentStep = 0;
    stepErrors = new Array(planSteps.length).fill(false);
    pendingErrorInfo = null;
    setMode("work", ctx);
    appState = "working";
    if (!isSubAgent && planSteps.length > 0) updatePlanPanel(ctx);
    ctx.ui.notify("计划已接受，切换到 WORK 模式执行", "info");
  }

  // ============================================================
  // before_agent_start: inject instructions
  // ============================================================

  pi.on("before_agent_start", (event, ctx) => {
    planProduced = false;
    confirmedCalls.clear();

    if (mode === "yolo") return;

    if (isSubAgent) return;

    // Respect manual /plan command; smart mode defaults to working
    if (mode === "plan") {
      appState = "planning";
    } else {
      appState = "working";
    }
    return { systemPrompt: event.systemPrompt + SMART_PLAN_PROMPT };
  });

  // ============================================================
  // message_end: detect plan produced + parse steps
  // ============================================================

  pi.on("message_end", (event, _ctx) => {
    const textParts = (event.message.content ?? []).filter(
      (c: { type: string }) => c.type === "text",
    );
    if (textParts.length === 0) return;
    if (!textParts.some((c: { text?: string }) => (c.text ?? "").trim().length > 50)) return;
    const fullText = textParts.map((c: { text?: string }) => c.text ?? "").join("\n");

    // PLAN mode: detect plan produced (only first time, don't re-parse if already have steps)
    if (appState === "planning" && mode === "plan" && planSteps.length === 0) {
      planProduced = true;
      planFullText = fullText;
      const parsed = parsePlanSteps(planFullText);
      if (parsed.length > 0) {
        planSteps = parsed;
        currentStepIndex = -1;
      }
      return;
    }

    // WORK mode: only detect when AI uses the explicit "## Execution Plan" marker
    // 已有活跃计划时不再重复解析（防止执行过程中被覆盖）
    if (appState === "working" && mode === "work" && !planProduced && planSteps.length === 0) {
      const hasExplicitPlan = /(?:^|\n)##\s+Execution\s+Plan\s*\n/i.test(fullText);

      if (hasExplicitPlan) {
        planProduced = true;
        planFullText = fullText;
        const parsed = parsePlanSteps(planFullText);
        if (parsed.length > 0) {
          planSteps = parsed;
          currentStepIndex = -1;
        }
        appState = "planning";
        mode = "plan";
      }
    }
  });

  // ============================================================
  // agent_end: confirmation dialog
  // ============================================================

  pi.on("agent_end", async (_event, ctx) => {

    // 仅在 plan 产出后进入弹窗 — 不自动运行安全审查（由 AI 自评或用户 /security-review 手动触发）
    if (appState === "planning" && mode === "plan" && planProduced) {
      if (isSubAgent) {
        const choice = await requestConfirm(
          "plan_confirm", "计划确认", planFullText.slice(0, 200),
          ["是", "否", "建议"],
        );
        if (choice === "是") {
          acceptPlan(ctx);
          pi.sendUserMessage("请按计划步骤逐步执行，使用 manage_plan(advance) 推进面板");
        }
        else if (choice === "建议") {
          const s = await requestInput("请输入修改建议", "");
          if (s?.trim()) {
            pi.sendUserMessage("用户对计划的建议:" + s, { deliverAs: "steer" });
            appState = "planning"; planProduced = false; planSteps = []; planFullText = "";
          } else { appState = "idle"; }
        } else { ctx.ui.notify("计划未被接受", "info"); appState = "idle"; }
      } else {
        const choice = await ctx.ui.select(
          "是否接受此计划并开始执行？",
          ["是，开始执行", "否，停止等待", "建议，修改计划"],
        );
        if (choice === "是，开始执行") {
          acceptPlan(ctx);
          pi.sendUserMessage("请按计划步骤逐步执行，使用 manage_plan(advance) 推进面板");
        } else if (choice === "建议，修改计划") {
          const s = await ctx.ui.editor("请输入修改建议（Esc 取消）", "");
          if (s?.trim()) {
            pi.sendUserMessage("用户对计划的建议:" + s, { deliverAs: "steer" });
            appState = "planning"; planProduced = false; planSteps = []; planFullText = "";
          } else { ctx.ui.notify("未输入建议", "info"); appState = "idle"; }
        } else { ctx.ui.notify("计划未被接受", "info"); appState = "idle"; }
      }
      return;
    }
    if (appState === "error" && pendingErrorInfo) return;
  });

  // ============================================================
  // tool_execution_end: refresh panel (auto-advance removed — use manage_plan)
  // ============================================================

  pi.on("tool_execution_end", (_event, ctx) => {
    if (mode !== "work" || planSteps.length === 0) return;
    // Panel progression is now controlled by LLM via manage_plan(advance).
    // This handler only refreshes the display; no auto-advance.
    updatePlanPanel(ctx);
  });

  // ============================================================
  // tool_result: detect errors
  // ============================================================

  pi.on("tool_result", async (event, ctx) => {
    if (mode !== "work" || planSteps.length === 0) return;
    if (appState === "error") return;
    if (currentStepIndex < 0 || currentStepIndex >= planSteps.length) return;

    // 仅框架级错误（isError=true）触发 error 状态；
    // 命令返回非零退出码（exitCode != 0）是正常结果，由 AI 自行判断处理
    if (!event.isError) return;

    const textContent = event.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");

    const isSevere =
      textContent.includes("protected path") ||
      textContent.includes("受保护路径") ||
      textContent.includes("blocked") ||
      textContent.includes("被阻止") ||
      textContent.includes("Permission denied") ||
      textContent.includes("Access denied") ||
      textContent.includes("权限");

    if (currentStepIndex < stepErrors.length) {
      stepErrors[currentStepIndex] = true;
    }
    appState = "error";
    updatePlanPanel(ctx);

    const stepLabel = currentStepIndex < planSteps.length
      ? planSteps[currentStepIndex]
      : "当前步骤";
    pendingErrorInfo = {
      stepIndex: currentStepIndex,
      message: "步骤" + stepLabel + "执行出错:\n" + textContent.slice(0, 300),
      isSevere,
    };

    if (isSevere) {
      ctx.ui.notify("严重错误已中止: " + textContent.slice(0, 100), "error");
      ctx.ui.setStatus("work-mode", "MODE: " + mode.toUpperCase() + " 已中止");
      return;
    }

    if (isSubAgent) {
      const choice = await requestConfirm(
        "error_recovery",
        pendingErrorInfo.message,
        "步骤出错，如何继续？",
        ["继续执行", "重新规划", "中止"],
      );
      await handleErrorChoice(choice, ctx);
    } else {
      const choice = await ctx.ui.select(
        "步骤出错\n\n" + pendingErrorInfo.message + "\n\n如何继续？",
        ["继续执行 (跳过该步)", "重新规划", "中止执行"],
      );
      await handleErrorChoice(choice, ctx);
    }
  });

  /** 处理用户对错误的选择 */
  async function handleErrorChoice(
    choice: string | undefined,
    ctx: ExtensionContext,
  ) {
    if (choice === "继续执行" || choice === "继续执行 (跳过该步)") {
      currentStepIndex++;
      toolCallsInCurrentStep = 0;
      if (currentStepIndex >= planSteps.length) {
        currentStepIndex = planSteps.length;
      }
      appState = "working";
      pendingErrorInfo = null;
      updatePlanPanel(ctx);
      ctx.ui.notify("已跳过错误，继续执行", "info");
    } else if (choice === "重新规划") {
      clearPlanPanel(ctx);
      setMode("plan", ctx);
      needsPlan = true;
      planAccepted = false;
      planProduced = false;
      appState = "planning";
      ctx.ui.notify("已切换到 PLAN 模式，请重新制定计划", "info");
    } else {
      appState = "error";
      ctx.ui.notify("执行已中止", "warning");
    }
  }

  // ============================================================
  // manage_plan: AI 可操控计划面板
  // ============================================================

  pi.registerTool({
    name: "manage_plan",
    label: "Manage Plan",
    description:
      "操控计划面板：设置步骤、推进进度、标记错误、清除面板。" +
      "让 AI 在执行过程中主动更新面板状态。",
    promptSnippet: "Update the plan panel (set steps, advance, mark errors, clear)",
    promptGuidelines: [
      "Use manage_plan to update the execution plan panel during task execution.",
      "Actions: 'set_steps' (replace all steps), 'advance' (move to next step), 'complete' (mark all done + close), 'mark_error' (flag a step as errored), 'clear' (remove panel).",
      "Call advance after completing each major step so the panel stays in sync.",
      "Use set_steps to replace the current plan with a refined one (max 10 steps).",
      "Use clear when the task is done or the plan is no longer relevant.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: set_steps | advance | complete | mark_error | clear" }),
      steps: Type.Optional(Type.Array(Type.String(), { description: "步骤列表 (set_steps 时使用，上限10)" })),
      stepIndex: Type.Optional(Type.Number({ description: "步骤索引 (mark_error 时使用，0-based)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "set_steps": {
          if (!params.steps || params.steps.length === 0) {
            return {
              content: [{ type: "text", text: "错误: set_steps 需要 steps 参数" }],
              details: { error: "missing_steps" },
            };
          }
          planSteps = params.steps.slice(0, MAX_PLAN_STEPS);
          currentStepIndex = planSteps.length > 0 ? 0 : -1;
          toolCallsInCurrentStep = 0;
          stepErrors = new Array(planSteps.length).fill(false);
          planPanelExpanded = planSteps.length <= DEFAULT_VISIBLE_STEPS;
          pendingErrorInfo = null;
          updatePlanPanel(ctx);
          return {
            content: [{ type: "text", text: `✅ 计划面板已更新: ${planSteps.length} 步` }],
            details: { action: "set_steps", count: planSteps.length },
          };
        }
        case "advance": {
          if (planSteps.length === 0 || currentStepIndex < 0) {
            return {
              content: [{ type: "text", text: "没有活跃的计划步骤" }],
              details: { error: "no_active_plan" },
            };
          }
          currentStepIndex++;
          toolCallsInCurrentStep = 0;
          if (currentStepIndex >= planSteps.length) {
            currentStepIndex = planSteps.length;
            closePlanPanel(ctx);
            return {
              content: [{ type: "text", text: "✅ 所有步骤已完成，面板已关闭" }],
              details: { action: "advance", completed: true },
            };
          }
          updatePlanPanel(ctx);
          return {
            content: [{
              type: "text",
              text: `➡️ 推进到步骤 ${currentStepIndex + 1}/${planSteps.length}: ${planSteps[currentStepIndex].slice(0, 60)}`,
            }],
            details: { action: "advance", stepIndex: currentStepIndex, total: planSteps.length },
          };
        }
        case "complete": {
          currentStepIndex = planSteps.length;
          closePlanPanel(ctx);
          appState = "working";
          return {
            content: [{ type: "text", text: "✅ 计划已全部完成，面板已关闭" }],
            details: { action: "complete" },
          };
        }
        case "mark_error": {
          const idx = params.stepIndex ?? currentStepIndex;
          if (idx < 0 || idx >= planSteps.length) {
            return {
              content: [{ type: "text", text: `错误: stepIndex ${idx} 超出范围 (0-${planSteps.length - 1})` }],
              details: { error: "invalid_index" },
            };
          }
          stepErrors[idx] = true;
          updatePlanPanel(ctx);
          return {
            content: [{ type: "text", text: `❌ 步骤 ${idx + 1} 已标记为错误: ${planSteps[idx].slice(0, 60)}` }],
            details: { action: "mark_error", stepIndex: idx },
          };
        }
        case "clear": {
          clearPlanPanel(ctx);
          return {
            content: [{ type: "text", text: "🧹 计划面板已清除" }],
            details: { action: "clear" },
          };
        }
        default:
          return {
            content: [{ type: "text", text: `未知操作: ${params.action}\n支持: set_steps | advance | complete | mark_error | clear` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });

  // ============================================================
  // tool_call: enforce mode rules
  // ============================================================

  pi.on("tool_call", async (event, ctx) => {
    if (appState === "error") {
      // 错误状态下仅放行只读和管理工具，允许 LLM 查看现状或调整计划
      const safeTools = ["read", "manage_plan", "check_agent_results", "context"];
      if (safeTools.includes(event.toolName)) return;
      return {
        block: true,
        reason: "执行因错误已暂停。请选择：继续执行、重新规划 或 中止",
      };
    }

    if (mode === "yolo") {
      if (isSubAgent) {
        return { block: true, reason: "YOLO mode not available for sub-agents" };
      }
      return;
    }

    if (mode === "plan") {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        return {
          block: true,
          reason: "write/edit 在 PLAN 模式下被阻止。请先输出计划，系统将自动切换到 WORK 模式。",
        };
      }

      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;
        const ok = await confirmAndRemember(
          ctx, cmdAllowlist, "bash", "PLAN", cmdStr, isSubAgent,
          (e) => { event.input.command = e; return true; },
        );
        if (!ok) return { block: true, reason: toolName + " blocked in PLAN mode" };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, "PLAN " + toolName + " ok");
      }
      return;
    }

    if (mode === "work") {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const targetPath = resolvePath(ctx.cwd, (event as any).input.path ?? "");
        if (isProtectedPath(targetPath)) {
          return { block: true, reason: "不允许操作受保护路径: " + targetPath };
        }
      }

      let path: string | undefined;

      if (isToolCallEventType("read", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Read", path, isSubAgent);
          if (!ok) return { block: true, reason: "read outside cwd: " + path };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK read ok");
        }
      }
      if (isToolCallEventType("write", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Write", path, isSubAgent);
          if (!ok) return { block: true, reason: "write outside cwd: " + path };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK write ok");
        }
      }
      if (isToolCallEventType("edit", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Edit", path, isSubAgent);
          if (!ok) return { block: true, reason: "edit outside cwd: " + path };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK edit ok");
        }
      }
      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;

        const destructiveCommands = /(rm|del|rd|rmdir|move|ren|copy|xcopy|robocopy|attrib|icacls|takeown|format|diskpart)/i;
        if (destructiveCommands.test(cmdStr) && cmdStr.includes("..")) {
          const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "WORK (destructive)", cmdStr, isSubAgent,
            (e) => { event.input.command = e; return true; });
          if (!ok) return { block: true, reason: toolName + " blocked: destructive command" };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK " + toolName + " ok");
          return;
        }

        const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "WORK", cmdStr, isSubAgent,
          (e) => { event.input.command = e; return true; });
        if (!ok) return { block: true, reason: toolName + " blocked" };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK " + toolName + " ok");
      }
      return;
    }
  });

  // ============================================================
  // tool_result: tag confirmed calls
  // ============================================================

  pi.on("tool_result", (event) => {
    if (mode === "yolo") return;

    const label = confirmedCalls.get(event.toolCallId);
    if (!label) return;
    confirmedCalls.delete(event.toolCallId);

    const idx = event.content.findIndex((b: { type: string }) => b.type === "text");
    if (idx >= 0) {
      event.content[idx] = {
        ...event.content[idx],
        text: "[" + label + "]\n" + event.content[idx].text,
      };
    }
  });
}
