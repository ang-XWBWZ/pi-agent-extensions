/**
 * update-task.ts — 子 Agent 专属任务面板与任务备注
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  getAgentTaskPanel,
  updateAgentTaskPanel,
  type AgentTaskPanel,
  type AgentTaskPanelStatus,
} from "../../lib/agent-bus.js";
import { subAgentIdentity } from "../lib/helpers.js";

const CHILD_SETTABLE_STATUSES = new Set<AgentTaskPanelStatus>([
  "running",
  "blocked",
  "completed",
  "failed",
]);

function formatPanel(panel: AgentTaskPanel): string {
  const latestReport = panel.stageReports.at(-1);
  const lastNote = panel.notes.at(-1);
  return [
    `📌 ${panel.name}`,
    `   Job: ${panel.jobId.slice(0, 8)} | Task: ${panel.taskId}`,
    `   状态: ${panel.status} | 进度: ${panel.progress}% | 修订: ${panel.revision}`,
    panel.currentStep ? `   当前步骤: ${panel.currentStep}` : undefined,
    latestReport
      ? `   结论控制面板（第 ${panel.stageReports.length} 阶段）: ${latestReport.conclusion}`
      : panel.summary
        ? `   最新结论（兼容字段）: ${panel.summary}`
        : undefined,
    latestReport?.detail
      ? `   详细控制面板: 已记录 ${latestReport.detail.length} 字；可通过 control_agent status 展开查看。`
      : undefined,
    lastNote ? `   最新备注: ${lastNote.text}` : undefined,
    panel.persistenceError
      ? `   ⚠️ 落盘失败（内存状态仍有效）: ${panel.persistenceError}`
      : `   💾 已增量落盘`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function registerUpdateAgentTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "update_agent_task",
    label: "Update Agent Task",
    description:
      "更新当前子 Agent 专属任务面板，可主动提交每个阶段的结论和可选详细说明，并记录状态、进度、当前步骤和任务备注。" +
      "每次更新都会写入 Pi 运行状态目录，不修改项目文件；PLAN/WORK 均可使用。" +
      "它不替代 send_agent_message、check_agent_results 或 control_agent。" +
      "子 Agent 身份优先于传入 ID；主 Agent 调用时需提供 jobId + taskId。" +
      "结论会追加为阶段记录并更新最新结论；详细说明只在提供时保存。省略字段保持原值，落盘失败会保留内存状态并返回 persistenceError。",
    promptSnippet:
      "Proactively persist sub-agent stage conclusions, optional details, progress, blockers, and partial findings",
    promptGuidelines: [
      "Use update_agent_task at start, after each meaningful stage, when blocked, and before the final answer.",
      "Use update_agent_task conclusion for a clear stage result, not a terse label; optional detail adds only needed evidence or boundaries, never full logs.",
      "Use update_agent_task note for brief durable observations outside stage conclusions; keep progress monotonic.",
      "Before final answer, use update_agent_task to set completed/100 and a final conclusion with result, verification, and blockers; summary is a legacy alias.",
    ],
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: "主 Agent 调用时的 Job ID；子 Agent 自动识别" }),
      ),
      taskId: Type.Optional(
        Type.String({ description: "主 Agent 调用时的 Task ID；子 Agent自动识别" }),
      ),
      status: Type.Optional(
        StringEnum([
          "queued",
          "running",
          "blocked",
          "paused",
          "completed",
          "failed",
          "timed_out",
          "killed",
          "interrupted",
        ] as const),
      ),
      progress: Type.Optional(
        Type.Number({ description: "0-100 的任务进度百分比" }),
      ),
      currentStep: Type.Optional(
        Type.String({ description: "当前正在执行或下一步要执行的动作" }),
      ),
      conclusion: Type.Optional(
        Type.String({ description: "本阶段主动提交的结论控制面板内容（最多 8,000 字）；应说明阶段结果、证据、影响或阻塞，而不是只写短标签" }),
      ),
      detail: Type.Optional(
        Type.String({ description: "本阶段详细控制面板的可选说明（最多 12,000 字）；仅在有助于理解结论时填写，必须与 conclusion 一起提供，不要粘贴完整日志" }),
      ),
      summary: Type.Optional(
        Type.String({ description: "兼容旧调用方的 conclusion 别名；新调用请使用 conclusion，二者不可填写不同内容" }),
      ),
      note: Type.Optional(
        Type.String({ description: "追加一条持久化任务备注，不覆盖旧备注" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("任务面板更新已取消");

      const identity = ctx?.sessionManager
        ? subAgentIdentity.get(ctx.sessionManager)
        : undefined;
      const jobId = identity?.jobId ?? params.jobId;
      const taskId = identity?.taskId ?? params.taskId;

      if (!jobId || !taskId) {
        return {
          content: [
            {
              type: "text",
              text: "更新任务面板需要子 Agent 身份，或显式提供 jobId 与 taskId。",
            },
          ],
          details: { error: "missing_target" },
        };
      }

      if (
        identity &&
        params.status &&
        !CHILD_SETTABLE_STATUSES.has(params.status as AgentTaskPanelStatus)
      ) {
        return {
          content: [
            {
              type: "text",
              text: `子 Agent 不能主动设置状态 ${params.status}；可用 running | blocked | completed | failed。`,
            },
          ],
          details: { error: "invalid_child_status", jobId, taskId },
        };
      }

      if (
        params.progress !== undefined &&
        (!Number.isFinite(params.progress) ||
          params.progress < 0 ||
          params.progress > 100)
      ) {
        return {
          content: [{ type: "text", text: "progress 必须是 0-100 的有限数字。" }],
          details: { error: "invalid_progress", jobId, taskId },
        };
      }

      const explicitConclusion = params.conclusion?.trim();
      const legacySummary = params.summary?.trim();
      if (
        explicitConclusion &&
        legacySummary &&
        explicitConclusion !== legacySummary
      ) {
        return {
          content: [{ type: "text", text: "conclusion 与 summary 同时提供时必须一致；请仅使用 conclusion。" }],
          details: { error: "conflicting_conclusion", jobId, taskId },
        };
      }
      const conclusion = explicitConclusion || legacySummary;
      if (params.detail?.trim() && !conclusion) {
        return {
          content: [{ type: "text", text: "detail 必须伴随本阶段的 conclusion；请先说明阶段结论。" }],
          details: { error: "detail_requires_conclusion", jobId, taskId },
        };
      }

      const existing = getAgentTaskPanel(jobId, taskId);
      if (!existing) {
        return {
          content: [
            {
              type: "text",
              text: `任务面板不存在: ${jobId}/${taskId}`,
            },
          ],
          details: { error: "not_found", jobId, taskId },
        };
      }

      const hasUpdate =
        params.status !== undefined ||
        params.progress !== undefined ||
        params.currentStep !== undefined ||
        params.conclusion !== undefined ||
        params.detail !== undefined ||
        params.summary !== undefined ||
        params.note !== undefined;
      const panel = hasUpdate
        ? updateAgentTaskPanel(jobId, taskId, {
            status: params.status as AgentTaskPanelStatus | undefined,
            progress: params.progress,
            currentStep: params.currentStep,
            // summary 仍能清空旧字段；有内容时统一转为结构化阶段结论。
            summary: conclusion === undefined ? params.summary : undefined,
            conclusion,
            detail: params.detail,
            reportSource: identity ? "agent" : "main",
            note: params.note,
            noteSource: identity ? "agent" : "main",
          })
        : existing;

      if (!panel) {
        throw new Error(`任务面板更新失败: ${jobId}/${taskId}`);
      }

      return {
        content: [{ type: "text", text: formatPanel(panel) }],
        details: {
          jobId,
          taskId,
          status: panel.status,
          progress: panel.progress,
          currentStep: panel.currentStep,
          summary: panel.summary,
          stageReportCount: panel.stageReports.length,
          latestStageReport: panel.stageReports.at(-1),
          noteCount: panel.notes.length,
          revision: panel.revision,
          persisted: !panel.persistenceError,
          persistenceError: panel.persistenceError,
        },
      };
    },
  });
}
