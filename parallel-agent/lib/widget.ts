/**
 * widget.ts — 子 Agent 状态面板 Widget
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  listInstances,
  listAgentTaskPanels,
  getAgentBus,
  Events,
  type AgentJob,
} from "../../lib/agent-bus.js";
import { truncateToWidth, fmtNum } from "./helpers.js";
import { formatJobNotificationLine } from "./spawner.js";

let widgetTui: { requestRender(): void } | null = null;
let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;
const WIDGET_BUS_CLEANUP_KEY = "__pi_parallel_agent_widget_bus_cleanup";
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
  const onJobComplete = (data: { jobId: string; job: AgentJob }) => {
    if (notifiedJobs.has(data.jobId)) return;
    notifiedJobs.add(data.jobId);
    const completedJob = data.job;
    const elapsed = completedJob.finishedAt
      ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
      : "?";
    const line = formatJobNotificationLine(
      completedJob.jobId,
      completedJob.results,
      completedJob.total,
      elapsed,
    );
    try {
      pi.sendUserMessage(line, { deliverAs: "steer", triggerTurn: true });
    } catch { /* 旧版运行时完成通知失败不影响结果查询 */ }
    refreshWidget();
  };
  const watchedEvents = [
    Events.INSTANCE_REGISTERED,
    Events.INSTANCE_UNREGISTERED,
    Events.AGENT_PAUSED,
    Events.AGENT_RESUMED,
    Events.TASK_RESULT,
    Events.STATUS_CHANGED,
    Events.TASK_PANEL_UPDATED,
    Events.JOB_COMPLETE,
  ];
  const globalState = globalThis as Record<string, unknown>;
  const previousCleanup = globalState[WIDGET_BUS_CLEANUP_KEY];
  if (typeof previousCleanup === "function") {
    try { previousCleanup(); } catch { /* 旧监听器清理失败不阻塞 reload */ }
  }
  bus.on(Events.INSTANCE_REGISTERED, onEvent);
  bus.on(Events.INSTANCE_UNREGISTERED, onEvent);
  bus.on(Events.AGENT_PAUSED, onEvent);
  bus.on(Events.AGENT_RESUMED, onEvent);
  bus.on(Events.TASK_RESULT, onEvent);
  bus.on(Events.STATUS_CHANGED, onEvent);
  bus.on(Events.TASK_PANEL_UPDATED, onEvent);
  bus.on(Events.JOB_COMPLETE, onEvent);
  bus.on(Events.JOB_COMPLETE, onJobComplete);
  globalState[WIDGET_BUS_CLEANUP_KEY] = () => {
    for (const eventName of watchedEvents) bus.off(eventName, onEvent);
    bus.off(Events.JOB_COMPLETE, onJobComplete);
  };

  // ---- Widget：每次 session_start 更新 TUI 引用 ----
  pi.on("session_start", async (_event, ctx) => {
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = setInterval(refreshWidget, 1500);

    ctx.ui.setWidget("sub-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => {
          const insts = listInstances();
          const instByTask = new Map(
            insts.map((inst) => [`${inst.jobId}:${inst.taskId}`, inst]),
          );
          const now = Date.now();
          const panels = listAgentTaskPanels().filter((panel) => {
            const isActive =
              panel.status === "queued" ||
              panel.status === "running" ||
              panel.status === "blocked" ||
              panel.status === "paused";
            return isActive || now - panel.updatedAt < 15_000;
          });
          if (panels.length === 0) return [];

          const lines: string[] = [];
          const hdr = theme.fg(
            "accent",
            theme.bold(`🤖 子 Agent 任务面板 (${panels.length})`),
          );
          lines.push(truncateToWidth(hdr, width));

          for (const panel of panels) {
            const inst = instByTask.get(`${panel.jobId}:${panel.taskId}`);
            const statusIcon =
              panel.status === "completed" ? "✅" :
              panel.status === "failed" ? "❌" :
              panel.status === "timed_out" ? "⏱️" :
              panel.status === "killed" ? "💀" :
              panel.status === "interrupted" ? "⚠️" :
              panel.status === "blocked" ? "🚧" :
              panel.status === "paused" ? "⏸️" :
              inst?.detailedStatus === "thinking" ? "🧠" :
              inst?.detailedStatus === "tool_calling" ? "🔧" :
              inst?.detailedStatus === "idle" ? "⏳" : "🟢";
            const statusText =
              inst?.detailedStatus === "tool_calling" && inst.currentTool
                ? inst.currentTool
                : inst?.detailedStatus === "thinking" ? "思考中"
                : inst?.detailedStatus === "idle" ? "空闲等待"
                : panel.status;
            const elapsed = (
              ((panel.finishedAt ?? Date.now()) - panel.createdAt) /
              1000
            ).toFixed(0);
            const title = panel.name.length > 20
              ? panel.name.slice(0, 20) + "…"
              : panel.name;
            const modelShort = inst?.model || "?";
            const tierPrefix = inst?.tier ? `[${inst.tier}] ` : "";
            const thinkSuffix = inst?.thinkingLevel && inst.thinkingLevel !== "off"
              ? ` 🧠${inst.thinkingLevel}`
              : "";
            const modelTag = (tierPrefix + modelShort + thinkSuffix).length > 35
              ? (tierPrefix + modelShort + thinkSuffix).slice(0, 35) + "…"
              : tierPrefix + modelShort + thinkSuffix;

            const metrics: string[] = [];
            metrics.push(`${panel.progress}%`);
            if (inst) {
              metrics.push(`↑${fmtNum(inst.inputTokens)}`);
              metrics.push(`↓${fmtNum(inst.outputTokens)}`);
              if (inst.cacheTokens > 0) metrics.push(`R${fmtNum(inst.cacheTokens)}`);
              if (inst.cost > 0) metrics.push(`$${inst.cost < 0.001 ? inst.cost.toExponential(2) : inst.cost.toFixed(3)}`);
              if (inst.contextPercent !== null && inst.contextPercent !== undefined && inst.contextWindow > 0)
                metrics.push(`${inst.contextPercent.toFixed(1)}%/${fmtNum(inst.contextWindow)}`);
            }
            metrics.push(`${elapsed}s`);
            metrics.push(statusText);

            const fullLine =
              `  ${statusIcon} ${theme.fg("accent", panel.taskId)} ${theme.fg("muted", title)}  ${theme.fg("dim", modelTag)}  ${theme.fg("dim", metrics.join(" "))}`;
            lines.push(
              visibleWidth(fullLine) > width
                ? truncateToWidth(fullLine, width - 1) + "…"
                : fullLine,
            );

            const lastNote = panel.notes.at(-1)?.text;
            const detail = panel.currentStep || panel.summary || lastNote;
            if (detail) {
              const noteSuffix =
                lastNote && lastNote !== detail ? ` | 📝 ${lastNote}` : "";
              const detailLine = theme.fg(
                "dim",
                `     ↳ ${detail}${noteSuffix}${
                  panel.persistenceError ? " | ⚠️ 未落盘" : ""
                }`,
              );
              lines.push(
                visibleWidth(detailLine) > width
                  ? truncateToWidth(detailLine, width - 1) + "…"
                  : detailLine,
              );
            }
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
