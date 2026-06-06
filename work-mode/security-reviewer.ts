/**
 * security-reviewer.ts — 计划文本安全审查
 *
 * 对 AI 输出的执行计划进行规则式安全检查，发现潜在风险。
 * 从 work-mode.ts 提取。
 */

import { PROTECTED_PATH_PATTERNS } from "./types.js";

// ============================================================
// Types
// ============================================================

export interface SecurityFinding {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  suggestion: string;
}

// ============================================================
// Security review engine
// ============================================================

/** 对计划文本执行安全审查 */
export function securityReview(text: string, steps: string[]): SecurityFinding[] {
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

// ============================================================
// Formatting
// ============================================================

/** 格式化安全审查结果 */
export function formatSecurityReview(findings: SecurityFinding[]): string {
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
