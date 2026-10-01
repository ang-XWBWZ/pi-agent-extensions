/**
 * result-classifier.ts — 集中式终态判定器（CP2 / B01）
 *
 * 会话结束（SDK agent_end）不等于任务成功。本模块把 SDK 终止原因、外部
 * 控制、子 Agent 面板报告和采集到的输出汇总为一个确定的终态结论。
 *
 * 设计约束：
 *   - 纯函数：无副作用、无 I/O、无全局状态，可独立单元测试。
 *   - 结果可信：只有 succeeded 映射为 ok=true；空结果、模型错误、主动
 *     failed/blocked、外部终止都不能被判为成功。
 *   - 结论分离：lastUsefulConclusion 保留最近有效工程结论，terminalReason
 *     单独描述终止原因，超时/取消原因不覆盖已有结论。
 */
import type {
  AgentTaskPanelStatus,
  SubResultErrorCode,
  TerminalOutcome,
} from "../../lib/agent-bus.js";

export type { SubResultErrorCode, TerminalOutcome };

/** 一次 agent_end 中最后一条 assistant 消息的终止信号。 */
export interface FinalAssistantSignal {
  stopReason?: string;
  errorMessage?: string;
}

/** 面板阶段报告的判定输入子集。 */
export interface ClassifierStageReport {
  status: AgentTaskPanelStatus;
  conclusion?: string;
  detail?: string;
}

/** 终态判定输入。所有字段可选，缺省表示“没有该信号”。 */
export interface TerminalSignals {
  /** 外部控制通道：超时/杀死/销毁，优先级最高。 */
  control?: "none" | "timeout" | "killed" | "disposed";
  /** 运行期抛出的异常消息。 */
  runtimeError?: string;
  /** 会话被外部中断，例如父会话撤销。 */
  abortedExternally?: boolean;
  /** SDK 最终 assistant 消息的终止原因。 */
  finalAssistant?: FinalAssistantSignal;
  /** 面板当前终态（子 Agent 主动提交的报告状态）。 */
  panelStatus?: AgentTaskPanelStatus;
  /** 面板阶段报告，按时间顺序；最后一条代表最新结论，不用旧中间摘要。 */
  stageReports?: readonly ClassifierStageReport[];
  /** 面板兼容字段 summary（无阶段报告时仅作为产出保留，不作为完成证据）。 */
  panelSummary?: string;
  /** 采集到的输出/最终回答。 */
  output?: string;
  /** 存档写入失败信息。 */
  checkpointError?: string;
  /** 清理阶段失败信息。 */
  cleanupErrors?: readonly string[];
}

export interface TerminalDecision {
  outcome: TerminalOutcome;
  ok: boolean;
  errorCode?: SubResultErrorCode;
  error?: string;
  /** 终止原因，始终与 lastUsefulConclusion 分开保存。 */
  terminalReason: string;
  /** 最近一次有效工程结论，即使任务失败也保留。 */
  lastUsefulConclusion?: string;
  /** 是否有完成证据：结构化完成报告，或非空最终回答。 */
  hasCompletionEvidence: boolean;
  /** 非致命告警：存档/清理失败始终进入结果，不因 ok=true 被隐藏。 */
  warnings: string[];
}

const MAX_CONCLUSION_CHARS = 8_000;

function normalizeConclusion(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= MAX_CONCLUSION_CHARS
    ? text
    : `${text.slice(0, MAX_CONCLUSION_CHARS)}…`;
}

function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content.trim();
  if (!Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const block of m.content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * 取最后一条有文本的 assistant 消息。
 *
 * 与拼接全部 assistant 消息不同，这里只取最终回答，避免把历史中间摘要
 * 误当作最终结论（B04）。
 */
export function extractFinalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

/** 读取最后一条 assistant 消息的终止信号（不要求该消息有文本）。 */
export function readFinalAssistantSignal(messages: unknown): FinalAssistantSignal {
  if (!Array.isArray(messages)) return {};
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: string;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (m?.role !== "assistant") continue;
    return {
      stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined,
      errorMessage:
        typeof m.errorMessage === "string" ? m.errorMessage : undefined,
    };
  }
  return {};
}

/** 终态到面板状态的唯一映射（B01：面板不再由多个模块任意覆盖）。 */
export function panelStatusForOutcome(
  outcome: TerminalOutcome,
): AgentTaskPanelStatus {
  switch (outcome) {
    case "succeeded":
      return "completed";
    case "blocked":
      return "blocked";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "interrupted";
    case "killed":
      return "killed";
    case "failed":
    case "incomplete":
      return "failed";
  }
}

function decision(
  outcome: TerminalOutcome,
  terminalReason: string,
  extra: Partial<TerminalDecision> = {},
): TerminalDecision {
  return {
    outcome,
    ok: outcome === "succeeded",
    terminalReason,
    hasCompletionEvidence: false,
    warnings: [],
    ...extra,
  };
}

/**
 * 判定一次会话结束的终态。
 *
 * 优先级（先到先判）：
 *   1. 外部控制 timeout/killed/disposed
 *   2. 运行期异常
 *   3. 外部中断
 *   4. SDK 最终 assistant 终止原因 error/aborted/length/pending/deferred/toolUse
 *   5. 子 Agent 面板主动报告的 failed/blocked/timed_out/killed/interrupted
 *   6. 没有完成证据且没有最终回答 -> incomplete/empty_result
 *   7. 其余 -> succeeded
 */
export function classifyTerminal(signals: TerminalSignals): TerminalDecision {
  const stageReports = signals.stageReports ?? [];
  const lastReport =
    stageReports.length > 0 ? stageReports[stageReports.length - 1] : undefined;
  const lastCompletedReport = [...stageReports]
    .reverse()
    .find((report) => report.status === "completed");
  const finalAnswer = normalizeConclusion(signals.output);
  // B04：优先最终完成报告，其次最新阶段报告，其次最终回答，最后才是旧的
  // panel summary。panel summary 只作为产出保留，不单独构成完成证据。
  const lastUsefulConclusion =
    normalizeConclusion(lastCompletedReport?.conclusion) ??
    normalizeConclusion(lastReport?.conclusion) ??
    finalAnswer ??
    normalizeConclusion(signals.panelSummary);
  const hasCompletionEvidence =
    lastCompletedReport !== undefined || signals.panelStatus === "completed";

  const warnings: string[] = [];
  if (signals.checkpointError) {
    warnings.push(`checkpoint: ${signals.checkpointError}`);
  }
  if (signals.cleanupErrors?.length) {
    warnings.push(`cleanup: ${signals.cleanupErrors.join("; ")}`);
  }
  const base: Partial<TerminalDecision> = {
    lastUsefulConclusion,
    hasCompletionEvidence,
    warnings,
  };

  const control = signals.control ?? "none";
  if (control === "timeout") {
    return decision("timed_out", "达到活跃执行预算上限", {
      ...base,
      errorCode: "timeout",
      error: "timeout",
    });
  }
  if (control === "killed") {
    return decision("killed", "被主 Agent 或调度器终止", {
      ...base,
      errorCode: "killed",
      error: "killed",
    });
  }
  if (control === "disposed") {
    return decision("cancelled", "会话被显式销毁", {
      ...base,
      errorCode: "disposed",
      error: "disposed",
    });
  }
  if (signals.runtimeError) {
    return decision("failed", `运行期异常: ${signals.runtimeError}`, {
      ...base,
      errorCode: "runtime",
      error: signals.runtimeError,
    });
  }
  if (signals.abortedExternally) {
    return decision("cancelled", "会话被外部中断", {
      ...base,
      errorCode: "cancelled",
      error: "aborted",
    });
  }

  const stopReason = signals.finalAssistant?.stopReason;
  if (stopReason === "error") {
    const error = signals.finalAssistant?.errorMessage ?? "模型返回错误";
    return decision("failed", `模型错误: ${error}`, {
      ...base,
      errorCode: "model_error",
      error,
    });
  }
  if (stopReason === "aborted") {
    return decision("cancelled", "模型响应被中断", {
      ...base,
      errorCode: "cancelled",
      error: "aborted",
    });
  }
  if (stopReason === "length") {
    return decision("incomplete", "模型输出因长度上限被截断", {
      ...base,
      errorCode: "incomplete",
      error: "length",
    });
  }
  if (
    stopReason === "pending" ||
    stopReason === "deferred" ||
    stopReason === "toolUse"
  ) {
    return decision("incomplete", `未完成的终止原因: ${stopReason}`, {
      ...base,
      errorCode: "incomplete",
      error: stopReason,
    });
  }

  const panelStatus = signals.panelStatus;
  if (panelStatus === "failed") {
    return decision("failed", "子 Agent 主动报告失败", {
      ...base,
      errorCode: "agent_failed",
      error: "agent reported failed",
    });
  }
  if (panelStatus === "blocked") {
    return decision("blocked", "子 Agent 报告阻塞", {
      ...base,
      errorCode: "blocked",
      error: "blocked",
    });
  }
  if (panelStatus === "timed_out") {
    return decision("timed_out", "面板记录超时", {
      ...base,
      errorCode: "timeout",
      error: "timeout",
    });
  }
  if (panelStatus === "killed") {
    return decision("killed", "面板记录被终止", {
      ...base,
      errorCode: "killed",
      error: "killed",
    });
  }
  if (panelStatus === "interrupted") {
    return decision("cancelled", "面板记录被中断", {
      ...base,
      errorCode: "cancelled",
      error: "interrupted",
    });
  }

  // B03：没有有效结论或完成证据时返回 incomplete；有结构化完成报告的
  // 静默任务仍可成功。
  if (!hasCompletionEvidence && !finalAnswer) {
    return decision("incomplete", "没有有效结论或完成证据", {
      ...base,
      errorCode: "empty_result",
      error: "empty result",
    });
  }

  return decision(
    "succeeded",
    hasCompletionEvidence ? "有结构化完成报告" : "有有效最终结论",
    base,
  );
}
