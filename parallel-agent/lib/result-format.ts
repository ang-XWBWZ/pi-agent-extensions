/**
 * result-format.ts — 子 Agent Job 结果格式化
 */

import type { AgentJob, SubResult } from "../../lib/agent-bus.js";

const CHECK_PREVIEW_CHARS = 500;
const INJECT_OUTPUT_CHARS = 10_000;

export function jobElapsedSeconds(job: AgentJob): string {
  return job.finishedAt
    ? ((job.finishedAt - job.createdAt) / 1000).toFixed(1)
    : ((Date.now() - job.createdAt) / 1000).toFixed(1);
}

export function formatJobStatusLine(job: AgentJob, elapsed: string = jobElapsedSeconds(job)): string {
  const okCount = job.results.filter((r) => r.ok).length;
  const failCount = job.results.filter((r) => !r.ok).length;
  const statusText =
    job.status === "complete" ? "✅ 完成" :
    job.status === "killed" ? "💀 已杀死" :
    job.status === "running" ? "🔄 进行中" :
    job.status === "dispatched" ? "📋 已派发" :
    "❌ 错误";

  return `${statusText} Job ${job.jobId.slice(0, 8)} — ⏱ ${elapsed}s | ✅ ${okCount} | ❌ ${failCount} | 📊 ${job.total}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, maxChars - 240);
  return `${text.slice(0, head)}\n\n... [截断 ${text.length - head} 字符，避免一次性污染主上下文；如需更完整内容，请收窄子任务后重跑或查看子 Agent 存档] ...`;
}

function formatResultBody(result: SubResult, maxChars: number): string {
  if (!result.ok) return `错误: ${result.error ?? "未知"}`;
  return truncateText(result.output ?? "(无输出)", maxChars);
}

export function formatJobPreview(job: AgentJob, elapsed: string = jobElapsedSeconds(job)): string {
  const body = [...job.results]
    .sort((a, b) => a.order - b.order)
    .map((r) => {
      const icon = r.ok ? "✅" : "❌";
      return `${icon} [${r.order}/${job.total}] ${r.name}\n   ${formatResultBody(r, CHECK_PREVIEW_CHARS)}\n`;
    });

  return [formatJobStatusLine(job, elapsed), "", ...body].join("\n");
}

export function formatJobFullResult(job: AgentJob, elapsed: string = jobElapsedSeconds(job)): string {
  const body = [...job.results]
    .sort((a, b) => a.order - b.order)
    .map((r) => {
      const icon = r.ok ? "✅" : "❌";
      return [
        `${icon} [${r.order}/${job.total}] ${r.name}`,
        formatResultBody(r, INJECT_OUTPUT_CHARS),
      ].join("\n");
    });

  return [
    `[sub-agent-results]`,
    formatJobStatusLine(job, elapsed),
    `Job ID: ${job.jobId}`,
    "",
    ...body,
    "[/sub-agent-results]",
  ].join("\n\n");
}

export function formatJobAlreadyInjectedNotice(job: AgentJob, elapsed: string = jobElapsedSeconds(job)): string {
  return [
    `📋 Job ${job.jobId.slice(0, 8)} 已完成，完整结果已自动推送过；为避免重复注入主上下文，这里只显示摘要。`,
    formatJobPreview(job, elapsed),
  ].join("\n\n");
}
