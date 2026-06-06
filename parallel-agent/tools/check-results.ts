/**
 * check-results.ts — check_agent_results 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getJob,
  listJobs,
  waitForJob,
  type AgentJob,
} from "../../lib/agent-bus.js";

// ---- 格式化输出 ----

function formatJobResult(job: AgentJob, elapsed: string) {
  const okCount = job.results.filter((r) => r.ok).length;
  const failCount = job.results.filter((r) => !r.ok).length;

  const statusText =
    job.status === "complete" ? "✅ 完成" :
    job.status === "killed" ? "💀 已杀死" :
    "❌ 错误";

  const header = [
    `${statusText} Job ${job.jobId.slice(0, 8)}`,
    `⏱ 耗时: ${elapsed}s | ✅ ${okCount} | ❌ ${failCount} | 📊 ${job.total}`,
    ``,
  ];

  const body = job.results.map((r) => {
    const icon = r.ok ? "✅" : "❌";
    const text = r.ok
      ? (r.output ?? "").slice(0, 500)
      : `错误: ${r.error ?? "未知"}`;
    return `${icon} [${r.order}/${job.total}] ${r.name}\n   ${text}\n`;
  });

  return {
    content: [{ type: "text", text: [...header, ...body].join("\n") }],
    details: {
      jobId: job.jobId,
      status: job.status,
      elapsed,
      okCount,
      failCount,
      total: job.total,
      results: job.results.map((r) => ({
        id: r.id,
        name: r.name,
        ok: r.ok,
        output: r.output?.slice(0, 500),
        error: r.error,
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
      "Use after spawn_agent to retrieve results.",
      "Pass wait=true to block until all sub-agents complete.",
      "Pass wait=false (default) for non-blocking poll — returns current progress.",
      "Call without jobId to list all pending/completed jobs.",
      "PREFER non-blocking poll (wait=false, the default). Results are auto-injected via steer when complete — no need to block.",
      "Use wait=true ONLY when you must synchronize before the next action, but know it blocks user interaction.",
      "Default to wait=false. Results auto-inject on completion — polling is rarely needed.",
      "FORBIDDEN: Do NOT use wait=true during interactive conversation. It freezes the UI and kills user experience.",
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
          return {
            content: [{ type: "text", text: `📋 Job ${params.jobId!.slice(0, 8)} 已完成，结果已自动推送到对话中。` }],
            details: { jobId: job.jobId, status: job.status, autoInjected: true },
          };
        }
        job._autoInjected = true;
        return formatJobResult(job, elapsed);
      }

      if (!params.wait) {
        ctx.ui.setStatus("sub-agent", undefined);
        const elapsed = ((Date.now() - job.createdAt) / 1000).toFixed(1);
        return {
          content: [
            {
              type: "text",
              text: [
                `🔄 Job ${params.jobId.slice(0, 8)} 进行中 — ${job.completed}/${job.total} 完成 (${elapsed}s)`,
                ``,
                `已完成:`,
                ...job.results.map(
                  (r) => `  ${r.ok ? "✅" : "❌"} ${r.name}: ${(r.output ?? r.error ?? "").slice(0, 120)}`,
                ),
                ``,
                `结果将在完成后自动推送。主动查询进度: check_agent_results("${params.jobId}")（非阻塞）。`,
              ].join("\n"),
            },
          ],
          details: { jobId: params.jobId, status: "running", completed: job.completed, total: job.total, results: job.results },
        };
      }

      const waitTimeout = (params.timeout ?? 300) * 1000;
      ctx.ui.notify(`⏳ 等待 Job ${params.jobId.slice(0, 8)} 完成...`, "info");

      const completedJob = await waitForJob(params.jobId, waitTimeout, signal);
      ctx.ui.setStatus("sub-agent", undefined);
      if (completedJob._autoInjected) {
        return {
          content: [{ type: "text", text: `📋 Job ${params.jobId!.slice(0, 8)} 已完成，结果已自动推送到对话中。` }],
          details: { jobId: completedJob.jobId, status: completedJob.status, autoInjected: true },
        };
      }
      completedJob._autoInjected = true;

      const elapsed = completedJob.finishedAt
        ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
        : "?";
      return formatJobResult(completedJob, elapsed);
    },
  });
}
