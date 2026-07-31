/**
 * check-results.ts — check_agent_results 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getJob,
  listJobs,
  listAgentTaskPanels,
  getAgentTaskOutputInfo,
  waitForJob,
  type AgentJob,
  type AgentTaskPanel,
} from "../../lib/agent-bus.js";
import { formatJobAlreadyInjectedNotice, formatJobPreview } from "../lib/result-format.js";

// ---- 格式化输出 ----

function formatPanelLine(panel: AgentTaskPanel): string {
  const lastNote = panel.notes.at(-1)?.text;
  const detail =
    panel.summary || panel.currentStep || lastNote || "尚无阶段性更新";
  const save = panel.saveId ? ` | 💾 ${panel.saveId}` : "";
  const reports = panel.stageReports.length > 0
    ? ` | 阶段 ${panel.stageReports.length}`
    : "";
  return `  📌 ${panel.taskId} — ${panel.status} ${panel.progress}%${reports} — ${detail.slice(0, 180)}${save}`;
}

function panelOutputPreview(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const headChars = 1_500;
  const tailChars = 500;
  if (output.length <= headChars + tailChars) return output;
  return `${output.slice(0, headChars)}\n… [面板预览省略] …\n${output.slice(-tailChars)}`;
}

function panelDetails(panel: AgentTaskPanel) {
  const outputInfo = getAgentTaskOutputInfo(panel.jobId, panel.taskId);
  const latestStageReport = panel.stageReports.at(-1);
  return {
    jobId: panel.jobId,
    taskId: panel.taskId,
    status: panel.status,
    progress: panel.progress,
    currentStep: panel.currentStep,
    summary: panel.summary,
    latestConclusion: latestStageReport?.conclusion ?? panel.summary,
    stageReportCount: panel.stageReports.length,
    latestStageReport,
    latestNotes: panel.notes.slice(-5),
    outputPreview: panelOutputPreview(panel.outputSnapshot),
    outputLength:
      outputInfo.characterLength ??
      panel.outputLength ??
      panel.outputSnapshot?.length ??
      0,
    outputBytes: outputInfo.byteLength,
    outputSource: outputInfo.source,
    outputReadable: outputInfo.available,
    saveId: panel.saveId,
    updatedAt: panel.updatedAt,
    persisted: !panel.persistenceError,
    persistenceError: panel.persistenceError,
  };
}

function formatJobResult(job: AgentJob, elapsed: string, alreadyInjected = false) {
  const okCount = job.results.filter((r) => r.ok).length;
  const failCount = job.results.filter((r) => !r.ok).length;
  const baseText = alreadyInjected
    ? formatJobAlreadyInjectedNotice(job, elapsed)
    : formatJobPreview(job, elapsed);
  const panels = listAgentTaskPanels(job.jobId);
  const text = panels.length > 0
    ? `${baseText}\n\n任务面板:\n${panels.map(formatPanelLine).join("\n")}`
    : baseText;

  return {
    content: [{ type: "text", text }],
    details: {
      jobId: job.jobId,
      status: job.status,
      elapsed,
      okCount,
      failCount,
      total: job.total,
      autoInjected: job._autoInjected === true,
      taskPanels: panels.map(panelDetails),
      results: job.results.map((r) => ({
          id: r.id,
          name: r.name,
          ok: r.ok,
          summary: r.summary,
          outputPreview: r.output?.slice(0, 500),
          outputLength: r.outputLength ?? r.output?.length ?? 0,
        error: r.error,
        errorCode: r.errorCode,
        saveId: r.saveId,
        checkpointError: r.checkpointError,
      })),
    },
  };
}

export function registerCheckResults(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "check_agent_results",
    label: "Check Agent Results",
    description:
      "查询子 Agent 执行结果。可轮询（不阻塞）或等待（阻塞直到完成）。" +
      "不传 jobId 时列出所有 Job。",
    promptSnippet: "Check or wait for sub-agent results",
    promptGuidelines: [
      "Use check_agent_results after spawn_agent; prefer the default non-blocking check because completed results auto-inject.",
      "Use check_agent_results wait=true only when the next action strictly depends on every child result.",
    ],
    parameters: Type.Object({
      jobId: Type.Optional(Type.String({ description: "Job ID（不传则列出所有）" })),
      wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待完成（默认 false）" })),
      timeout: Type.Optional(Type.Number({ description: "等待超时秒（默认 300）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");

      if (!params.jobId) {
        const allJobs = listJobs();
        if (allJobs.length === 0) {
          return {
            content: [{ type: "text", text: "没有进行中或已完成的 Job。" }],
            details: { jobs: [] },
          };
        }

        const lines = allJobs.map((j) => {
          const statusIcon =
            j.status === "complete" ? "✅" :
            j.status === "error" ? "❌" :
            j.status === "killed" ? "💀" :
            j.status === "running" ? "🔄" : "📋";
          const elapsed = j.finishedAt
            ? `${((j.finishedAt - j.createdAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - j.createdAt) / 1000).toFixed(1)}s`;
          const suffix = j.finishedAt ? "" : " (进行中)";
          return `${statusIcon} ${j.jobId.slice(0, 8)} — ${j.completed}/${j.total} 完成 — ${elapsed}${suffix} — ${j.status}`;
        });

        return {
          content: [{ type: "text", text: `所有 Job:\n${lines.join("\n")}` }],
          details: { jobs: allJobs.map((j) => ({ jobId: j.jobId, status: j.status, completed: j.completed, total: j.total })) },
        };
      }

      const job = getJob(params.jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `Job 不存在: ${params.jobId}（可能已过期被清理）` }],
          details: { jobId: params.jobId, error: "not_found" },
        };
      }

      ctx.ui.setStatus("sub-agent", `查询 ${params.jobId.slice(0, 8)}...`);

      if (job.status === "complete" || job.status === "error" || job.status === "killed") {
        ctx.ui.setStatus("sub-agent", undefined);
        const elapsed = job.finishedAt
          ? ((job.finishedAt - job.createdAt) / 1000).toFixed(1)
          : "?";
        if (job._autoInjected) {
          return formatJobResult(job, elapsed, true);
        }
        return formatJobResult(job, elapsed);
      }

      if (!params.wait) {
        ctx.ui.setStatus("sub-agent", undefined);
        const elapsed = ((Date.now() - job.createdAt) / 1000).toFixed(1);
        const panels = listAgentTaskPanels(job.jobId);
        return {
          content: [
            {
              type: "text",
              text: [
                `🔄 Job ${params.jobId.slice(0, 8)} 进行中 — ${job.completed}/${job.total} 完成 (${elapsed}s)`,
                ``,
                `已完成:`,
                ...job.results.map(
                  (r) => `  ${r.ok ? "✅" : "❌"} ${r.name}: ${(r.summary ?? r.output ?? r.error ?? "").slice(0, 120)}`,
                ),
                ``,
                `任务面板:`,
                ...(panels.length > 0
                  ? panels.map(formatPanelLine)
                  : ["  （尚无面板更新）"]),
                ``,
                `结果将在完成后自动推送。主动查询进度: check_agent_results("${params.jobId}")（非阻塞）。`,
              ].join("\n"),
            },
          ],
          details: {
            jobId: params.jobId,
            status: "running",
            completed: job.completed,
            total: job.total,
            results: job.results,
            taskPanels: panels.map(panelDetails),
          },
        };
      }

      const waitTimeout = (params.timeout ?? 300) * 1000;
      ctx.ui.notify(`⏳ 等待 Job ${params.jobId.slice(0, 8)} 完成...`, "info");

      const completedJob = await waitForJob(params.jobId, waitTimeout, signal);
      ctx.ui.setStatus("sub-agent", undefined);
      const alreadyInjected = completedJob._autoInjected === true;
      const elapsed = completedJob.finishedAt
        ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
        : "?";
      return formatJobResult(completedJob, elapsed, alreadyInjected);
    },
  });
}
