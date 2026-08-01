/**
 * widget.ts — 子 Agent 状态面板 Widget
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactToolValue } from "../../lib/tui-format.js";
import { getToolsExpandedState, toolExpandHint } from "../../lib/tui-render.js";
import {
  listInstances,
  listAgentTaskPanels,
  getAgentBus,
  Events,
} from "../../lib/agent-bus.js";
import { truncateToWidth, fmtNum } from "./helpers.js";

let widgetTui: { requestRender(): void } | null = null;
let widgetExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let widgetRenderNow = 0;
const WIDGET_BUS_CLEANUP_KEY = "__pi_parallel_agent_widget_bus_cleanup";
const RECENT_FINISHED_PANEL_MS = 15_000;
const visibleStatusSignatures = new Map<string, string>();
const visiblePanelSignatures = new Map<string, string>();

type StatusChangedEvent = {
  jobId: string;
  taskId: string;
  detailedStatus?: string;
  currentTool?: string;
};

type TaskPanelUpdatedEvent = {
  jobId: string;
  taskId: string;
  panel: {
    status: string;
    progress: number;
    currentStep?: string;
    summary?: string;
    persistenceError?: string;
    notes: Array<{ text: string }>;
    stageReports: Array<{ conclusion?: string }>;
  };
};

function taskKey(jobId: string, taskId: string): string {
  return `${jobId}:${taskId}`;
}

function isActivePanelStatus(status: string): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "blocked" ||
    status === "paused"
  );
}

function refreshVisibleWidget(): void {
  if (!widgetTui) return;
  widgetRenderNow = Date.now();
  scheduleWidgetExpiry();
  refreshWidget();
}

function statusSignature(event: StatusChangedEvent): string {
  return JSON.stringify([event.detailedStatus, event.currentTool]);
}

function panelSignature(panel: TaskPanelUpdatedEvent["panel"]): string {
  return JSON.stringify([
    panel.status,
    panel.progress,
    panel.currentStep,
    panel.summary,
    panel.stageReports.length,
    panel.stageReports.at(-1)?.conclusion,
    panel.notes.at(-1)?.text,
    panel.persistenceError,
  ]);
}

/**
 * Keep completed task cards visible briefly without a permanent heartbeat.
 * A repeating requestRender() changes the elapsed field even when no task state
 * changed; if this multi-line widget is above the viewport, pi-tui must redraw
 * the whole terminal to update it.
 */
function scheduleWidgetExpiry(): void {
  if (widgetExpiryTimer) {
    clearTimeout(widgetExpiryTimer);
    widgetExpiryTimer = null;
  }

  const now = Date.now();
  const nextExpiryAt = listAgentTaskPanels()
    .filter((panel) => !isActivePanelStatus(panel.status))
    .map((panel) => panel.updatedAt + RECENT_FINISHED_PANEL_MS)
    .filter((expiresAt) => expiresAt > now)
    .reduce<number | undefined>(
      (earliest, expiresAt) =>
        earliest === undefined || expiresAt < earliest ? expiresAt : earliest,
      undefined,
    );

  if (nextExpiryAt === undefined) return;

  widgetExpiryTimer = setTimeout(() => {
    widgetExpiryTimer = null;
    if (!widgetTui) return;
    widgetRenderNow = Date.now();
    refreshWidget();
    scheduleWidgetExpiry();
  }, Math.max(1, nextExpiryAt - now));
}

export function refreshWidget(): void {
  try { widgetTui?.requestRender(); } catch { /* */ }
}

export function clearWidget(): void {
  if (widgetExpiryTimer) {
    clearTimeout(widgetExpiryTimer);
    widgetExpiryTimer = null;
  }
  widgetTui = null;
  widgetRenderNow = 0;
  visibleStatusSignatures.clear();
  visiblePanelSignatures.clear();
}

export function setupWidget(pi: ExtensionAPI): void {
  // ---- Bus 监听器：扩展加载时注册一次，不随 session 重复 ----
  const bus = getAgentBus();

  const onVisibleEvent = () => refreshVisibleWidget();
  const onStatusChanged = (event: StatusChangedEvent) => {
    const key = taskKey(event.jobId, event.taskId);
    const signature = statusSignature(event);
    if (visibleStatusSignatures.get(key) === signature) return;
    visibleStatusSignatures.set(key, signature);
    refreshVisibleWidget();
  };
  const onTaskPanelUpdated = (event: TaskPanelUpdatedEvent) => {
    const key = taskKey(event.jobId, event.taskId);
    const signature = panelSignature(event.panel);
    if (visiblePanelSignatures.get(key) === signature) return;
    visiblePanelSignatures.set(key, signature);
    refreshVisibleWidget();
  };
  const genericEvents = [
    Events.INSTANCE_REGISTERED,
    Events.INSTANCE_UNREGISTERED,
    Events.AGENT_PAUSED,
    Events.AGENT_RESUMED,
    Events.TASK_RESULT,
    Events.JOB_COMPLETE,
  ];
  const globalState = globalThis as Record<string, unknown>;
  const previousCleanup = globalState[WIDGET_BUS_CLEANUP_KEY];
  if (typeof previousCleanup === "function") {
    try { previousCleanup(); } catch { /* 旧监听器清理失败不阻塞 reload */ }
  }
  for (const eventName of genericEvents) bus.on(eventName, onVisibleEvent);
  bus.on(Events.STATUS_CHANGED, onStatusChanged);
  bus.on(Events.TASK_PANEL_UPDATED, onTaskPanelUpdated);
  globalState[WIDGET_BUS_CLEANUP_KEY] = () => {
    for (const eventName of genericEvents) bus.off(eventName, onVisibleEvent);
    bus.off(Events.STATUS_CHANGED, onStatusChanged);
    bus.off(Events.TASK_PANEL_UPDATED, onTaskPanelUpdated);
  };

  // ---- Widget：每次 session_start 更新 TUI 引用 ----
  pi.on("session_start", async (_event, ctx) => {
    widgetRenderNow = Date.now();
    ctx.ui.setWidget("sub-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => {
          const insts = listInstances();
          const instByTask = new Map(
            insts.map((inst) => [`${inst.jobId}:${inst.taskId}`, inst]),
          );
          const now = widgetRenderNow;
          const panels = listAgentTaskPanels().filter((panel) => {
            return (
              isActivePanelStatus(panel.status) ||
              now - panel.updatedAt < RECENT_FINISHED_PANEL_MS
            );
          });
          if (panels.length === 0) return [];
          const expanded = getToolsExpandedState(pi);

          const lines: string[] = [];
          const hdr = theme.fg(
            "accent",
            theme.bold(`🤖 子 Agent 任务面板 (${panels.length})`),
          ) + (expanded ? "" : ` ${toolExpandHint(theme, "to expand details")}`);
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
            const safeStatusText = compactToolValue(statusText, 80);
            const elapsed = (
              ((panel.finishedAt ?? now) - panel.createdAt) /
              1000
            ).toFixed(0);
            const title = compactToolValue(panel.name, 20);
            const modelShort = compactToolValue(inst?.model || "?", 24);
            const tierPrefix = inst?.tier ? `[${compactToolValue(inst.tier, 8)}] ` : "";
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
            metrics.push(safeStatusText);
            if (panel.stageReports.length > 0) {
              metrics.push(`结论${panel.stageReports.length}`);
            }

            const taskLabel = compactToolValue(panel.taskId, 32);
            const fullLine =
              `  ${statusIcon} ${theme.fg("accent", taskLabel)} ${theme.fg("muted", title)}  ${theme.fg("dim", modelTag)}  ${theme.fg("dim", metrics.join(" "))}`;
            lines.push(
              visibleWidth(fullLine) > width
                ? truncateToWidth(fullLine, width - 1) + "…"
                : fullLine,
            );

            const lastNote = panel.notes.at(-1)?.text;
            const latestConclusion = panel.stageReports.at(-1)?.conclusion;
            const detail = latestConclusion || panel.summary || panel.currentStep || lastNote;
            if (expanded && detail) {
              const noteSuffix =
                lastNote && lastNote !== detail ? ` | 📝 ${compactToolValue(lastNote, 160)}` : "";
              const stepSuffix =
                panel.currentStep && panel.currentStep !== detail
                  ? ` | ↪ ${compactToolValue(panel.currentStep, 160)}`
                  : "";
              const detailLine = theme.fg(
                "dim",
                `     ↳ ${compactToolValue(detail, 280)}${stepSuffix}${noteSuffix}${
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
    if (widgetTui) scheduleWidgetExpiry();
  });

  pi.on("session_shutdown", () => {
    clearWidget();
  });
}
