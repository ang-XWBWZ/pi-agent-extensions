/**
 * work-mode.ts — 工作模式扩展 v2
 *
 * 强制 Plan-First：AI 在回复前必须先进入 PLAN 模式、输出安全计划，
 * 产出计划后等待用户 /accept-plan 确认，确认后切换到 WORK 模式执行。
 * 编辑器上方显示 📋 执行计划 面板，实时展示步骤完成进度。
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
  const label = `Bash 确认 [${modeLabel}]  —  ${short}`;
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
  const title = `${label} 确认  —  ${short}`;
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
    ctx.ui.notify(`✅ 已记住: ${pattern}`, "info");
    return "dialog";
  }

  return false;
}

// ============================================================
// Plan panel — 计划步骤解析 & Widget
// ============================================================

/** 从 AI 输出的计划文本中提取步骤列表 */
function parsePlanSteps(text: string): string[] {
  const lines = text.split("\n");
  const steps: string[] = [];
  let inCodeBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;

    const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-z][\.\)])\s+(.+)/i);
    if (numbered) {
      const desc = numbered[1].trim();
      if (desc.length > 8) { steps.push(desc); continue; }
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      const desc = bullet[1].trim();
      if (desc.length > 8) { steps.push(desc); continue; }
    }

    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) {
      const desc = heading[1].trim();
      if (desc.length > 5 && desc.length < 80 && !desc.match(/^plan|步骤|step|方案|概览|目录|计划/i)) {
        steps.push(desc);
      }
    }
  }

  return steps;
}

/** 渲染计划面板行（含错误状态） */
function renderPlanPanel(
  steps: string[],
  currentIdx: number,
  errors: boolean[],
  theme: any,
): string[] {
  if (steps.length === 0) return [];

  const header = theme?.fg("accent", theme?.bold("📋 执行计划")) ?? "📋 执行计划";
  const lines: string[] = [header, ""];

  for (let i = 0; i < steps.length; i++) {
    let icon: string;
    let style: (s: string) => string;

    if (errors[i]) {
      icon = "❌";
      style = (s) => theme?.fg("error", s) ?? s;
    } else if (i < currentIdx) {
      icon = "✅";
      style = (s) => theme?.fg("success", s) ?? s;
    } else if (i === currentIdx) {
      icon = "🔄";
      style = (s) => theme?.fg("accent", s) ?? s;
    } else {
      icon = "⏳";
      style = (s) => theme?.fg("muted", s) ?? s;
    }

    const label = steps[i].length > 70
      ? steps[i].slice(0, 67) + "..."
      : steps[i];
    lines.push(` ${icon} ${style(label)}`);
  }

  return lines;
}

// ============================================================
// 安全审查 — 计划文本的规则式安全检查
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
        description: `计划包含「${label}」命令，可能造成不可逆的数据丢失`,
        suggestion: "确保有完整的备份/回滚策略，考虑先用 --dry-run 或 /p 参数预览",
      });
    }
  }

  // ---- 备份/回滚检查 — 有写操作但没提及备份 ----
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

  const lines: string[] = ["🔍 安全审查结果:", ""];

  const severe = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");
  const low = findings.filter((f) => f.severity === "low");

  for (const [level, items] of [["🔴 高危", severe], ["🟡 中危", medium], ["🟢 低危", low]] as const) {
    if (items.length === 0) continue;
    lines.push(`${level} — ${items.length} 项`);
    for (const f of items) {
      lines.push(`  • [${f.category}] ${f.description}`);
      lines.push(`    建议: ${f.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// Plan → Work auto-switch system prompt snippet
// ============================================================

const PLAN_SYSTEM_PROMPT = `

## 🔒 PLAN-FIRST RULE（强制）

当前处于 **PLAN 模式**。你必须先制定完整的安全计划，然后**等待用户接受**后系统才会切换到 WORK 模式执行。

### 你必须做到的

**第一步：充分调研**
- 使用 read / ls / grep / find 工具了解项目结构、现有代码
- 使用 bash / cmd（需确认）查看目录、依赖、配置文件
- 考虑可用的工具链（如 build 脚本、测试框架、lint 规则）
- 不依赖假设，用工具验证

**第二步：制定详细计划（必须包含安全考量）**
覆盖以下内容：
- 涉及的文件路径和修改类型（新增/修改/删除）
- 需要执行的命令和顺序
- **每个步骤的风险评估（低/中/高）**
- **备份/回滚策略（涉及文件修改时必须包含）**
- **边界条件检查和异常处理**
- **凭证管理：绝对不要硬编码 API Key、Token、密码**
- **依赖管理：安装依赖需指定版本号**
- **子进程拆分：可并行化的任务应使用 spawn_agent 派发子进程**
  - 任务目标必须原子级明确（单文件读写、单次扫描、单个修复）
  - 子进程使用 mode: "plan" 确保安全边界
  - 善用 context 参数注入相关文件内容，减少子进程调研开销

**模型分配策略：**
- 调研/扫描/信息收集 → 🔹 高性价比模型（deepseek-v4-flash）
- 分析/设计/代码生成 → 🔸 高能力模型（deepseek-v4-pro）
- 子进程任务必须标注使用的模型

**第三步：逐条讲解并请用户确认**
- 向用户逐条解释你的计划
- 说明每步风险
- 系统会弹窗让用户选择：是 / 否 / 建议
- 如果用户选择「建议」，请根据建议修订计划

### 在 PLAN 模式下你不能做的
- write/edit/delete：**被强制阻止**
- 修改 .git、node_modules、.pi、.agents、.claude 等受保护路径：**被强制阻止**
- 执行未确认的 bash/cmd 命令

记住：用工具调研 → 制定计划 → 逐条讲解 → 等待用户确认`;

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
  let needsPlan = true;
  let planAccepted = false;

  // Plan panel state
  let planSteps: string[] = [];
  let planFullText = "";         // 完整的计划文本（含表格/风险评估），供安全审查用
  let currentStepIndex = -1;
  let toolCallsInCurrentStep = 0;
  let stepErrors: boolean[] = [];

  // Security review self-loop (在 turn_end 自动运行，不展示给用户)
  let reviewCount = 0;
  let pendingSecurityFeedback: SecurityFinding[] | null = null;
  const MAX_REVIEW_ATTEMPTS = 3;

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

  // ---- persistence & panel ----
  function persist(ctx: ExtensionContext) {
    pi.appendEntry("work-mode-state", { mode });
    ctx.ui.setStatus("work-mode", `MODE: ${mode.toUpperCase()}`);
  }

  function setMode(m: WorkMode, ctx: ExtensionContext) {
    mode = m;
    persist(ctx);
  }

  function showModeNotification(ctx: ExtensionContext) {
    const labels: Record<string, string> = {
      plan: "PLAN — safe planning (write/edit blocked)",
      work: "WORK — cwd + protected path guard",
      yolo: "YOLO — ⚠️ unrestricted, only user can switch",
    };
    ctx.ui.notify(labels[mode], "info");
  }

  /** 更新编辑器上方的计划面板（子进程不创建面板） */
  function updatePlanPanel(ctx: ExtensionContext) {
    if (isSubAgent) return;
    if (planSteps.length === 0) {
      ctx.ui.setWidget("plan-panel", undefined);
      return;
    }
    ctx.ui.setWidget("plan-panel", (tui, theme) => ({
      render: () => renderPlanPanel(planSteps, currentStepIndex, stepErrors, theme),
      invalidate: () => {},
    }));
  }

  /** 关闭计划面板（完成时调用） */
  function closePlanPanel(ctx: ExtensionContext) {
    if (isSubAgent) return;
    ctx.ui.setWidget("plan-panel", undefined);
  }

  /** 清除计划面板 */
  function clearPlanPanel(ctx: ExtensionContext) {
    planSteps = [];
    planFullText = "";
    currentStepIndex = -1;
    toolCallsInCurrentStep = 0;
    stepErrors = [];
    pendingErrorInfo = null;
    reviewCount = 0;
    pendingSecurityFeedback = null;
    ctx.ui.setWidget("plan-panel", undefined);
    ctx.ui.setWidget("security-review", undefined);
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
    ctx.ui.setStatus("work-mode", `MODE: ${mode.toUpperCase()}`);
    needsPlan = true;
    appState = "idle";
    clearPlanPanel(ctx);
  });

  // ============================================================
  // Commands (user-only)
  // ============================================================

  pi.registerCommand("plan", {
    description: "PLAN — safe planning (read-only, write/edit blocked)",
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
    description: "WORK — cwd guard + protected path guard",
    handler: (_a, ctx) => {
      setMode("work", ctx);
      needsPlan = false;
      planAccepted = true;
      appState = "working";
      showModeNotification(ctx);
    },
  });

  pi.registerCommand("yolo", {
    description: "YOLO — ⚠️ unrestricted (only user can enable)",
    handler: (_a, ctx) => {
      setMode("yolo", ctx);
      appState = "working";
      clearPlanPanel(ctx);
      showModeNotification(ctx);
    },
  });

  /**
   * 用户接受计划 — 切换到 WORK 模式执行（从弹窗或 /work 命令调用）
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
    ctx.ui.notify("✅ 计划已接受，切换到 WORK 模式执行", "info");
  }

  // ============================================================
  // before_agent_start: force plan mode + inject instructions
  // ============================================================

  pi.on("before_agent_start", (event, ctx) => {
    planProduced = false;
    confirmedCalls.clear();

    if (mode === "yolo") return;

    if (needsPlan && mode !== "plan") setMode("plan", ctx);

    if (mode === "plan") {
      if (appState === "awaiting_confirm") return;
      appState = "planning";
      return { systemPrompt: event.systemPrompt + PLAN_SYSTEM_PROMPT };
    }

    appState = "working";
  });

  // ============================================================
  // message_end: detect plan produced + parse steps
  // ============================================================

  pi.on("message_end", (event, _ctx) => {
    if (appState !== "planning" || mode !== "plan") return;

    const textParts = (event.message.content ?? []).filter(
      (c: { type: string }) => c.type === "text",
    );
    if (textParts.length === 0) return;
    if (!textParts.some((c: { text?: string }) => (c.text ?? "").trim().length > 50)) return;

    planProduced = true;

    // 提取完整文本供安全审查
    planFullText = textParts.map((c: { text?: string }) => c.text ?? "").join("\n");

    const parsed = parsePlanSteps(planFullText);
    if (parsed.length > 0) {
      planSteps = parsed;
      currentStepIndex = -1;
    }
  });

  // ============================================================
  // turn_end: 安全审查自循环（在 agent loop 内运行，真正自动）
  // ============================================================

  pi.on("turn_end", (_event, ctx) => {
    // 只在 planning 状态且有计划文本时运行审查
    if (appState !== "planning" || mode !== "plan" || !planProduced || !planFullText) return;
    if (reviewCount >= MAX_REVIEW_ATTEMPTS) return;

    const findings = securityReview(planFullText, planSteps);
    const severeCount = findings.filter((f) => f.severity === "high").length;

    if (findings.length > 0) {
      reviewCount++;
      const type = severeCount > 0 ? "error" : "warning";
      ctx.ui.notify(
        `🔄 安全审查 ${reviewCount}/${MAX_REVIEW_ATTEMPTS}: ${severeCount}🔴 ${findings.filter((f) => f.severity === "medium").length}🟡`,
        type,
      );

      // 注入 steer → agent loop 内循环自动拾取 → AI 修订 → 下一轮 turn_end 再审查
      pi.sendUserMessage(
        `⚠️ 安全审查反馈（第 ${reviewCount} 轮）：\n` +
          findings
            .map((f) => `[${f.severity === "high" ? "高危" : f.severity === "medium" ? "中危" : "低危"}] ${f.category}: ${f.description}\n建议: ${f.suggestion}`)
            .join("\n\n") +
          "\n\n请针对以上问题修订你的计划后再提交。",
        { deliverAs: "steer" },
      );

      // 重置 planProduced → AI 将重新输出计划 → MessageEnd 重新检测
      planProduced = false;
      planFullText = "";
    }
    // 审查通过 → 不做任何事，等 agent_end 弹窗
  });

  // ============================================================
  // agent_end: 弹窗让用户决策（是/否/建议）
  // ============================================================

  pi.on("agent_end", async (_event, ctx) => {
    // 清理审查状态
    reviewCount = 0;
    pendingSecurityFeedback = null;
    ctx.ui.setWidget("security-review", undefined);

    // 仅在 plan 产出后进入弹窗
    if (appState === "planning" && mode === "plan" && planProduced) {
      const findings = securityReview(planFullText, planSteps);
      const severeCount = findings.filter((f) => f.severity === "high").length;
      const summary =
        findings.length > 0
          ? `安全审查: ${severeCount}🔴 ${findings.filter((f) => f.severity === "medium").length}🟡 ${findings.filter((f) => f.severity === "low").length}🟢`
          : "安全审查通过";

      if (isSubAgent) {
        const choice = await requestConfirm(
          "plan_confirm", summary, planFullText.slice(0, 200),
          ["是", "否", "建议"],
        );
        if (choice === "是") {
          acceptPlan(ctx);
          // agent_end 时 activeRun 还在，推迟到 finishRun 后启动执行
          setTimeout(() => pi.sendUserMessage("请按计划步骤逐步执行"), 0);
        }
        else if (choice === "建议") {
          const s = await requestInput("请输入修改建议", "");
          if (s?.trim()) {
            pi.sendUserMessage(`用户对计划的建议:\n${s}`, { deliverAs: "steer" });
            appState = "planning"; planProduced = false;
          } else { appState = "idle"; }
        } else { ctx.ui.notify("⏸ 计划未被接受", "info"); appState = "idle"; }
      } else {
        const choice = await ctx.ui.select(
          `${summary}\n\n是否接受此计划并开始执行？`,
          ["✅ 是，开始执行", "❌ 否，停止等待", "💬 建议，修改计划"],
        );
        if (choice === "✅ 是，开始执行") {
          acceptPlan(ctx);
          setTimeout(() => pi.sendUserMessage("请按计划步骤逐步执行，每个步骤完成后自动推进面板"), 0);
        } else if (choice === "💬 建议，修改计划") {
          const s = await ctx.ui.editor("请输入修改建议（Esc 取消）", "");
          if (s?.trim()) {
            pi.sendUserMessage(`用户对计划的建议:\n${s}`, { deliverAs: "steer" });
            appState = "planning"; planProduced = false;
          } else { ctx.ui.notify("⏸ 未输入建议", "info"); appState = "idle"; }
        } else { ctx.ui.notify("⏸ 计划未被接受", "info"); appState = "idle"; }
      }
      return;
    }

    if (appState === "error" && pendingErrorInfo) return;
  });

  // ============================================================
  // tool_execution_end: advance plan panel + detect errors
  // ============================================================

  pi.on("tool_execution_end", (_event, ctx) => {
    if (mode !== "work" || planSteps.length === 0) return;
    if (currentStepIndex < 0 || currentStepIndex >= planSteps.length) return;

    toolCallsInCurrentStep++;
    const threshold = planSteps.length <= 3 ? 1 : 2;
    if (toolCallsInCurrentStep >= threshold) {
      currentStepIndex++;
      toolCallsInCurrentStep = 0;
      if (currentStepIndex >= planSteps.length) {
        currentStepIndex = planSteps.length;
        closePlanPanel(ctx);
        ctx.ui.notify("✅ 计划所有步骤执行完成", "success");
        return;
      }
      updatePlanPanel(ctx);
    }
  });

  // ============================================================
  // tool_result: detect errors → show recovery dialog
  // ============================================================

  pi.on("tool_result", async (event, ctx) => {
    // Only in WORK mode with an active plan
    if (mode !== "work" || planSteps.length === 0) return;
    if (appState === "error") return; // already in recovery
    if (currentStepIndex < 0 || currentStepIndex >= planSteps.length) return;

    // Check if this tool result is an error
    const isError = event.isError;
    if (!isError && event.details?.exitCode === 0) return;
    if (!isError && event.details?.exitCode === undefined) return; // non-bash non-error

    // It's an error — determine severity
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

    // Mark step as errored in the panel
    if (currentStepIndex < stepErrors.length) {
      stepErrors[currentStepIndex] = true;
    }
    appState = "error";
    updatePlanPanel(ctx);

    // Save the error info
    const stepLabel = currentStepIndex < planSteps.length
      ? planSteps[currentStepIndex]
      : "当前步骤";
    pendingErrorInfo = {
      stepIndex: currentStepIndex,
      message: `步骤「${stepLabel}」执行出错:\n${textContent.slice(0, 300)}`,
      isSevere,
    };

    if (isSevere) {
      // 严重错误 — 自动中止，不需要用户选择
      ctx.ui.notify(`🚨 严重错误已中止: ${textContent.slice(0, 100)}`, "error");
      ctx.ui.setStatus("work-mode", `MODE: ${mode.toUpperCase()} ⛔ 已中止`);
      return;
    }

    // 一般错误 — 弹窗问用户
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
        `⚠️ 步骤出错\n\n${pendingErrorInfo.message}\n\n如何继续？`,
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
      // 标记当前步已完成（带错误标记），继续下一步
      currentStepIndex++;
      toolCallsInCurrentStep = 0;
      if (currentStepIndex >= planSteps.length) {
        currentStepIndex = planSteps.length;
      }
      appState = "working";
      pendingErrorInfo = null;
      updatePlanPanel(ctx);
      ctx.ui.notify("▶️ 已跳过错误，继续执行", "info");
    } else if (choice === "重新规划") {
      // 切换回 PLAN 模式，保留已有步骤作为参考
      clearPlanPanel(ctx);
      setMode("plan", ctx);
      needsPlan = true;
      planAccepted = false;
      planProduced = false;
      appState = "planning";
      ctx.ui.notify("🔄 已切换到 PLAN 模式，请重新制定计划", "info");
    } else {
      // 中止 — 保持 error 状态，阻止进一步操作
      appState = "error";
      ctx.ui.notify("⏹ 执行已中止", "warning");
    }
  }

  // ============================================================
  // tool_call: block tools in error state + enforce mode rules
  // ============================================================

  pi.on("tool_call", async (event, ctx) => {
    // ---- Error state: all tools blocked ----
    if (appState === "error") {
      return {
        block: true,
        reason: "⛔ 执行因错误已暂停。请选择：继续执行、重新规划 或 中止",
      };
    }

    // ---- YOLO: no restrictions ----
    if (mode === "yolo") {
      if (isSubAgent) {
        return { block: true, reason: "YOLO mode not available for sub-agents" };
      }
      return;
    }

    // ---- PLAN mode: strict ----
    if (mode === "plan") {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        return {
          block: true,
          reason:
            "❌ write/edit 在 PLAN 模式下被阻止。请先输出计划，系统将自动切换到 WORK 模式。",
        };
      }

      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const targetPath = resolvePath(ctx.cwd, (event as any).input.path ?? "");
        if (isProtectedPath(targetPath)) {
          return { block: true, reason: `❌ 不允许操作受保护路径: ${targetPath}` };
        }
      }

      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;
        const ok = await confirmAndRemember(
          ctx, cmdAllowlist, "bash", "PLAN", cmdStr, isSubAgent,
          (e) => { event.input.command = e; return true; },
        );
        if (!ok) return { block: true, reason: `${toolName} blocked in PLAN mode` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, `PLAN ${toolName} ✅`);
      }
      return;
    }

    // ---- WORK mode: safety checks ----
    if (mode === "work") {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const targetPath = resolvePath(ctx.cwd, (event as any).input.path ?? "");
        if (isProtectedPath(targetPath)) {
          return { block: true, reason: `❌ 不允许操作受保护路径: ${targetPath}` };
        }
      }

      let path: string | undefined;

      if (isToolCallEventType("read", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Read", path, isSubAgent);
          if (!ok) return { block: true, reason: `read outside cwd: ${path}` };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK read ✅");
        }
      }
      if (isToolCallEventType("write", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Write", path, isSubAgent);
          if (!ok) return { block: true, reason: `write outside cwd: ${path}` };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK write ✅");
        }
      }
      if (isToolCallEventType("edit", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Edit", path, isSubAgent);
          if (!ok) return { block: true, reason: `edit outside cwd: ${path}` };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK edit ✅");
        }
      }
      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;

        const destructiveCommands = /(rm|del|rd|rmdir|move|ren|copy|xcopy|robocopy|attrib|icacls|takeown|format|diskpart)/i;
        if (destructiveCommands.test(cmdStr) && cmdStr.includes("..")) {
          const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "WORK (destructive)", cmdStr, isSubAgent,
            (e) => { event.input.command = e; return true; });
          if (!ok) return { block: true, reason: `${toolName} blocked: destructive command` };
          if (ok === "dialog") confirmedCalls.set(event.toolCallId, `WORK ${toolName} ✅`);
          return;
        }

        const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "WORK", cmdStr, isSubAgent,
          (e) => { event.input.command = e; return true; });
        if (!ok) return { block: true, reason: `${toolName} blocked` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, `WORK ${toolName} ✅`);
      }
      return;
    }
  });

  // ============================================================
  // tool_result: tag confirmed calls (controlled tagging)
  // 注：该 handler 与上面的错误检测 handler 并存，两者顺序无关
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
        text: `[${label}]\n${event.content[idx].text}`,
      };
    }
  });
}
