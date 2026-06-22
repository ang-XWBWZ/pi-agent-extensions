/**
 * widget.ts — 子 Agent 状态面板 Widget
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  listInstances,
  getAgentBus,
  Events,
  type AgentJob,
} from "../../lib/agent-bus.js";
import { truncateToWidth, fmtNum } from "./helpers.js";
import { formatJobNotificationLine } from "./spawner.js";

let widgetTui: { requestRender(): void } | null = null;
let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;
/** 已通知过的 Job ID，防止重复 */
const notifiedJobs = new Set<string>();

export function refreshWidget(): void {
  try { widgetTui?.requestRender(); } catch { /* */ }
}

export function clearWidget(): void {
  if (widgetRefreshTimer) {
    clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = null;
  }
  widgetTui = null;
}

export function setupWidget(pi: ExtensionAPI): void {
  // ---- Bus 监听器：扩展加载时注册一次，不随 session 重复 ----
  const bus = getAgentBus();

  const onEvent = () => refreshWidget();
  bus.on(Events.INSTANCE_REGISTERED, onEvent);
  bus.on(Events.INSTANCE_UNREGISTERED, onEvent);
  bus.on(Events.AGENT_PAUSED, onEvent);
  bus.on(Events.AGENT_RESUMED, onEvent);
  bus.on(Events.TASK_RESULT, onEvent);
  bus.on(Events.STATUS_CHANGED, onEvent);

  bus.on(Events.JOB_COMPLETE, (data: { jobId: string; job: AgentJob }) => {
    // 去重：同一 Job 只通知一次（防止 session_start 级联导致重复）
    if (notifiedJobs.has(data.jobId)) return;
    notifiedJobs.add(data.jobId);

    const completedJob = data.job;
    const elapsed = completedJob.finishedAt
      ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
      : "?";
    const line = formatJobNotificationLine(completedJob.jobId, completedJob.results, completedJob.total, elapsed);
    try {
      pi.sendUserMessage(line, { deliverAs: "steer", triggerTurn: true });
    } catch { /* */ }
    refreshWidget();
  });

  // ---- Widget：每次 session_start 更新 TUI 引用 ----
  pi.on("session_start", async (_event, ctx) => {
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = setInterval(refreshWidget, 1500);

    ctx.ui.setWidget("sub-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => {
          const insts = listInstances();
          if (insts.length === 0) return [];

          const lines: string[] = [];
          const hdr = theme.fg("accent", theme.bold(`🤖 子 Agent (${insts.length})`));
          lines.push(truncateToWidth(hdr, width));

          for (const inst of insts) {
            const statusIcon =
              inst.detailedStatus === "thinking" ? "🧠" :
              inst.detailedStatus === "tool_calling" ? "🔧" :
              inst.detailedStatus === "idle" ? "⏳" :
              inst.detailedStatus === "paused" ? "⏸️" :
              inst.detailedStatus === "done" ? "✅" :
              inst.status === "paused" ? "⏸️" : "🟢";
            const statusText =
              inst.detailedStatus === "tool_calling" && inst.currentTool
                ? inst.currentTool
                : inst.detailedStatus === "thinking" ? "思考中"
                : inst.detailedStatus === "idle" ? "空闲等待"
                : inst.detailedStatus === "done" ? "完成"
                : inst.detailedStatus === "paused" ? "已暂停"
                : "运行中";
            const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(0);
            const tokIn = fmtNum(inst.inputTokens);
            const tokOut = fmtNum(inst.outputTokens);
            const title = inst.name.length > 20
              ? inst.name.slice(0, 20) + "…"
              : inst.name;
            const modelShort = inst.model || "?";
            const tierPrefix = inst.tier ? `[${inst.tier}] ` : "";
            const thinkSuffix = inst.thinkingLevel && inst.thinkingLevel !== "off"
              ? ` 🧠${inst.thinkingLevel}`
              : "";
            const modelTag = (tierPrefix + modelShort + thinkSuffix).length > 35
              ? (tierPrefix + modelShort + thinkSuffix).slice(0, 35) + "…"
              : tierPrefix + modelShort + thinkSuffix;

            const metrics: string[] = [];
            metrics.push(`↑${tokIn}`);
            metrics.push(`↓${tokOut}`);
            if (inst.cacheTokens > 0) metrics.push(`R${fmtNum(inst.cacheTokens)}`);
            if (inst.cost > 0) metrics.push(`$${inst.cost < 0.001 ? inst.cost.toExponential(2) : inst.cost.toFixed(3)}`);
            if (inst.contextPercent !== null && inst.contextPercent !== undefined && inst.contextWindow > 0)
              metrics.push(`${inst.contextPercent.toFixed(1)}%/${fmtNum(inst.contextWindow)}`);
            metrics.push(`${elapsed}s`);
            metrics.push(statusText);

            const fullLine =
              `  ${statusIcon} ${theme.fg("accent", inst.taskId)} ${theme.fg("muted", title)}  ${theme.fg("dim", modelTag)}  ${theme.fg("dim", metrics.join(" "))}`;
            lines.push(
              visibleWidth(fullLine) > width
                ? truncateToWidth(fullLine, width - 1) + "…"
                : fullLine,
            );
          }

          return lines;
        },
        invalidate: () => tui.requestRender?.(),
      };
    });
  });

  pi.on("session_shutdown", () => {
    clearWidget();
  });
}
