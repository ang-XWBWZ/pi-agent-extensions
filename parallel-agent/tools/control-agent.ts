/**
 * control-agent.ts — control_agent 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  listInstances,
  killAgent,
  killJob,
  abortAgent,
  pauseAgent,
  resumeAgent,
  sendAgentInput,
  getJobInstances,
  getAgentTaskPanel,
  listAgentTaskPanels,
  getAgentTaskOutputInfo,
  saveAgentState,
  deleteAgentSave,
  listAgentSaves,
  type AgentTaskPanel,
  type AgentTaskStageReport,
} from "../../lib/agent-bus.js";

function compactText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function compactStageReport(report: AgentTaskStageReport) {
  return {
    ...report,
    conclusion: compactText(report.conclusion, 8_000),
    detail: report.detail ? compactText(report.detail, 12_000) : undefined,
  };
}

function selectedStageReport(panel: AgentTaskPanel, offset = 0) {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const index = panel.stageReports.length - 1 - normalizedOffset;
  return index >= 0
    ? { index, report: panel.stageReports[index] }
    : undefined;
}

function compactTaskPanel(panel: AgentTaskPanel | undefined) {
  if (!panel) return undefined;
  const output = getAgentTaskOutputInfo(panel.jobId, panel.taskId);
  const latestStageReport = panel.stageReports.at(-1);
  return {
    jobId: panel.jobId,
    taskId: panel.taskId,
    status: panel.status,
    progress: panel.progress,
    currentStep: panel.currentStep,
    summary: panel.summary ? compactText(panel.summary, 8_000) : undefined,
    stageReportCount: panel.stageReports.length,
    latestStageReport: latestStageReport
      ? compactStageReport(latestStageReport)
      : undefined,
    latestNotes: panel.notes.slice(-10).map((note) => ({
      ...note,
      text: compactText(note.text, 1_000),
    })),
    outputLength: output.characterLength ?? panel.outputLength ?? 0,
    outputBytes: output.byteLength,
    outputSource: output.source,
    outputReadable: output.available,
    saveId: panel.saveId,
    updatedAt: panel.updatedAt,
  };
}

export function registerControlAgent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "control_agent",
    label: "Control Agent",
    description:
      "控制子 Agent 生命周期：列出、查看状态、注入消息、打断、暂停、恢复、杀死、存档、恢复存档、删除存档。" +
      "status 会显示子 Agent 主动提交的阶段结论；可用 stageOffset 展开某一阶段的可选详细说明。支持操作单个 task 或整个 job。",
    promptSnippet: "Manage sub-agent lifecycle (list/status/send/abort/pause/resume/kill/save/load/list_saves/delete_save)",
    promptGuidelines: [
      "Use control_agent list/status before changing a child Agent lifecycle; taskId targets one task and omission targets the job.",
      "Use control_agent kill, kill_job, or delete_save only for an explicit cleanup reason and report the affected target.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: list | status | send | abort | pause | resume | kill | kill_job | save | list_saves | delete_save" }),
      jobId: Type.Optional(Type.String({ description: "Job ID" })),
      taskId: Type.Optional(Type.String({ description: "Task ID（单 agent 操作时必填）" })),
      stageOffset: Type.Optional(Type.Number({ description: "仅 status 使用；0 为最新阶段，1 为上一个阶段，用于展开该阶段的详细控制面板" })),
      input: Type.Optional(Type.String({ description: "消息内容（send/resume 操作时使用）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");
      const { action, jobId, taskId, input } = params;

      // ---- list ----
      if (action === "list") {
        const insts = listInstances();
        const recentPanels = listAgentTaskPanels()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 20);
        if (insts.length === 0) {
          const panelLines = recentPanels.map((panel) =>
            `  📌 [${panel.jobId.slice(0, 8)}] ${panel.taskId} — ${panel.status} ${panel.progress}% — ${(
              panel.summary ||
              panel.currentStep ||
              "无阶段结论"
            ).slice(0, 100)}`,
          );
          return {
            content: [{
              type: "text",
              text: panelLines.length > 0
                ? `没有运行中的子 Agent 实例。\n\n最近任务面板:\n${panelLines.join("\n")}`
                : "没有运行中的子 Agent 实例或任务面板。",
            }],
            details: {
              instances: [],
              taskPanels: recentPanels.map(compactTaskPanel),
            },
          };
        }
        const lines = insts.map((inst) => {
          const panel = getAgentTaskPanel(inst.jobId, inst.taskId);
          const icon =
            inst.detailedStatus === "thinking" ? "🧠" :
            inst.detailedStatus === "tool_calling" ? "🔧" :
            inst.detailedStatus === "idle" ? "⏳" :
            inst.detailedStatus === "paused" ? "⏸️" :
            inst.detailedStatus === "done" ? "✅" :
            inst.status === "paused" ? "⏸️" : "🟢";
          const extra = inst.currentTool ? ` [${inst.currentTool}]` : "";
          const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
          const taskProgress = panel
            ? ` | 📌 ${panel.progress}% ${(
                panel.summary ||
                panel.currentStep ||
                ""
              ).slice(0, 80)}`
            : "";
          return `${icon} [${inst.jobId.slice(0, 8)}] ${inst.taskId} — ${inst.name.slice(0, 30)} — ${inst.detailedStatus}${extra} (${elapsed}s)${taskProgress}`;
        });
        return {
          content: [{ type: "text", text: `运行中的子 Agent (${insts.length}):\n${lines.join("\n")}` }],
          details: {
            instances: insts.map((i) => ({
              jobId: i.jobId,
              taskId: i.taskId,
              name: i.name,
              status: i.status,
              detailedStatus: i.detailedStatus,
              currentTool: i.currentTool,
              taskPanel: compactTaskPanel(getAgentTaskPanel(i.jobId, i.taskId)),
            })),
          },
        };
      }

      // ---- status ----
      if (action === "status") {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: "status 操作需要 jobId 和 taskId" }], details: { error: "missing_args" } };
        }
        const inst = getJobInstances(jobId).find((i) => i.taskId === taskId);
        const panel = getAgentTaskPanel(jobId, taskId);
        if (!inst && !panel) {
          return { content: [{ type: "text", text: `实例和任务面板均不存在: ${jobId}/${taskId}` }], details: { error: "not_found" } };
        }
        if (
          params.stageOffset !== undefined &&
          (!Number.isFinite(params.stageOffset) || params.stageOffset < 0)
        ) {
          return {
            content: [{ type: "text", text: "stageOffset 必须是大于等于 0 的有限数字。" }],
            details: { error: "invalid_stage_offset", jobId, taskId },
          };
        }
        const stageOffset = Math.floor(params.stageOffset ?? 0);
        const selectedStage = panel
          ? selectedStageReport(panel, stageOffset)
          : undefined;
        const startedAt = inst?.startedAt ?? panel!.createdAt;
        const endAt = panel?.finishedAt ?? Date.now();
        const elapsed = ((endAt - startedAt) / 1000).toFixed(1);
        const idleSec = inst?.lastActivityAt
          ? ((Date.now() - inst.lastActivityAt) / 1000).toFixed(0)
          : "?";

        const toolLines = inst && inst.toolHistory.length > 0
          ? ["", "📋 工具调用历史:", ...inst.toolHistory.slice(-10).map((t) => {
              const icon = t.status === "started" ? "▶" : t.status === "error" ? "❌" : "✅";
              const dur = t.duration ? ` ${t.duration}ms` : "";
              const err = t.error ? ` (${t.error.slice(0, 60)})` : "";
              return `  ${icon} ${t.toolName} [${t.status}]${dur}${err}`;
            })]
          : [];
        const noteLines = panel?.notes.length
          ? [
              "",
              "📝 任务备注:",
              ...panel.notes.slice(-10).map((note) => {
                const at = new Date(note.createdAt).toLocaleTimeString();
                return `  - [${note.source} ${at}] ${compactText(note.text, 1_000)}`;
              }),
            ]
          : [];
        const stageTimelineLines = panel?.stageReports.length
          ? [
              "",
              `🧩 阶段结论记录（${panel.stageReports.length} 条，最新在后）:`,
              ...panel.stageReports.slice(-5).map((report, offset) => {
                const index = panel.stageReports.length - Math.min(5, panel.stageReports.length) + offset + 1;
                return `  ${index}. ${report.status} ${report.progress}% — ${compactText(report.conclusion, 800)}`;
              }),
            ]
          : [];
        const selectedStageLines = selectedStage
          ? [
              "",
              `📋 结论控制面板（第 ${selectedStage.index + 1}/${panel!.stageReports.length} 阶段）:`,
              `   状态: ${selectedStage.report.status} | 进度: ${selectedStage.report.progress}% | 来源: ${selectedStage.report.source}`,
              selectedStage.report.currentStep
                ? `   步骤: ${selectedStage.report.currentStep}`
                : undefined,
              "   结论:",
              compactText(selectedStage.report.conclusion, 8_000),
              selectedStage.report.detail
                ? "\n📚 详细控制面板（可选）:"
                : "   详细: （本阶段未填写）",
              selectedStage.report.detail
                ? compactText(selectedStage.report.detail, 12_000)
                : undefined,
            ].filter((line): line is string => Boolean(line))
          : panel?.stageReports.length
            ? [`   未找到 stageOffset=${stageOffset} 对应的阶段；可用范围为 0-${panel.stageReports.length - 1}。`]
            : [];

        const lines = [
          `📊 ${inst?.name ?? panel!.name}`,
          `   Job: ${jobId.slice(0, 8)} | Task: ${taskId}`,
          inst
            ? `   运行状态: ${inst.detailedStatus}${inst.currentTool ? ` (${inst.currentTool})` : ""} | 生命周期: ${inst.status} | 运行: ${elapsed}s | 空闲: ${idleSec}s`
            : `   运行实例: 已结束 | 记录时长: ${elapsed}s`,
          panel
            ? `   任务面板: ${panel.status} | 进度: ${panel.progress}% | 修订: ${panel.revision} | 落盘: ${panel.persistenceError ? "失败" : "成功"}`
            : undefined,
          panel?.currentStep ? `   当前步骤: ${panel.currentStep}` : undefined,
          panel?.summary && (panel?.stageReports.length ?? 0) === 0
            ? `   最新结论（兼容字段）: ${compactText(panel.summary, 8_000)}`
            : undefined,
          panel?.saveId ? `   可恢复存档: ${panel.saveId}` : undefined,
          inst
            ? `   输入: ${inst.promptLength}字 | 输出: ${inst.outputLength}字 | 自动续推: ${inst.autoContinue ? "✅" : "❌"}(${inst.autoContinueDelay}s)`
            : (panel?.outputLength ?? panel?.outputSnapshot?.length ?? 0) > 0
              ? `   原始输出: ${panel?.outputLength ?? panel?.outputSnapshot?.length ?? 0}字（按需使用 read_agent_output 展开）`
              : undefined,
          ...toolLines,
          ...stageTimelineLines,
          ...selectedStageLines,
          ...noteLines,
        ].filter((line): line is string => Boolean(line));

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            jobId,
            taskId,
            name: inst?.name ?? panel!.name,
            status: inst?.status,
            detailedStatus: inst?.detailedStatus,
            currentTool: inst?.currentTool,
            elapsed,
            idleSec,
            promptLength: inst?.promptLength,
            outputLength: inst?.outputLength ?? panel?.outputLength ?? panel?.outputSnapshot?.length ?? 0,
            autoContinue: inst?.autoContinue,
            toolHistory: inst?.toolHistory.slice(-10) ?? [],
            taskPanel: compactTaskPanel(panel),
            selectedStageIndex: selectedStage?.index,
            selectedStageReport: selectedStage
              ? compactStageReport(selectedStage.report)
              : undefined,
          },
        };
      }

      // ---- 需要 jobId + taskId 的操作 ----
      if (["send", "abort", "pause", "resume", "kill", "save"].includes(action)) {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: `${action} 操作需要 jobId 和 taskId` }], details: { error: "missing_args" } };
        }
      }

      switch (action) {
        case "kill_job": {
          if (!jobId) {
            return { content: [{ type: "text", text: "kill_job 需要 jobId" }], details: { error: "missing_args" } };
          }
          const count = await killJob(jobId);
          ctx.ui.notify(`💀 已杀死 ${count} 个子 Agent`, "warn");
          return {
            content: [{ type: "text", text: `💀 Job ${jobId.slice(0, 8)}: 已杀死 ${count} 个子 Agent` }],
            details: { action: "kill_job", jobId, killed: count },
          };
        }

        case "kill": {
          const ok = await killAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `💀 已杀死 ${taskId}` : `❌ 杀死失败: ${taskId}`, ok ? "warn" : "error");
          return {
            content: [{ type: "text", text: ok ? `💀 已杀死子 Agent: ${taskId}` : `❌ 无法杀死: ${taskId}` }],
            details: { action: "kill", jobId, taskId, ok },
          };
        }

        case "abort": {
          const ok = await abortAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `⏹ 已打断 ${taskId}` : `❌ 打断失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `⏹ 已打断子 Agent: ${taskId}（未销毁，可 resume）` : `❌ 无法打断: ${taskId}` }],
            details: { action: "abort", jobId, taskId, ok },
          };
        }

        case "pause": {
          const ok = await pauseAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `⏸️ 已暂停 ${taskId}` : `❌ 暂停失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `⏸️ 已暂停子 Agent: ${taskId}\n使用 control_agent({ action: "resume", ... }) 恢复。` : `❌ 无法暂停: ${taskId}` }],
            details: { action: "pause", jobId, taskId, ok },
          };
        }

        case "resume": {
          const resumeText = input;
          const ok = await resumeAgent(jobId!, taskId!, resumeText);
          ctx.ui.notify(ok ? `▶️ 已恢复 ${taskId}` : `❌ 恢复失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `▶️ 已恢复子 Agent: ${taskId}${resumeText ? ` (提示: "${resumeText.slice(0, 50)}")` : ""}` : `❌ 无法恢复: ${taskId}（可能不是 paused 状态）` }],
            details: { action: "resume", jobId, taskId, ok },
          };
        }

        case "send": {
          if (!input) {
            return { content: [{ type: "text", text: "send 操作需要 input 参数" }], details: { error: "missing_input" } };
          }
          const ok = await sendAgentInput(jobId!, taskId!, input);
          ctx.ui.notify(ok ? `📨 已注入: ${input.slice(0, 40)}` : `❌ 注入失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `📨 已向 ${taskId} 注入消息: "${input.slice(0, 100)}"` : `❌ 无法发送: ${taskId}` }],
            details: { action: "send", jobId, taskId, ok },
          };
        }

        case "save": {
          const saved = saveAgentState(jobId!, taskId!, {
            reason: "manual",
            output: getAgentTaskPanel(jobId!, taskId!)?.outputSnapshot,
          });
          ctx.ui.notify(saved ? `💾 已存档: ${taskId}` : `❌ 存档失败: ${taskId}`, saved ? "info" : "error");
          return {
            content: [{ type: "text", text: saved ? `💾 子 Agent 已存档: **${saved.name}**\n   saveId: \`${saved.saveId}\`\n   模型: ${saved.model}\n   消息数: ${saved.messages.length}\n   使用 \`spawn_agent({ resumeFrom: "${saved.saveId}" })\` 恢复。` : `❌ 存档失败: ${taskId}（实例可能已结束）` }],
            details: { action: "save", jobId, taskId, ok: !!saved, saveId: saved?.saveId },
          };
        }

        case "list_saves": {
          const saves = listAgentSaves();
          if (saves.length === 0) {
            return { content: [{ type: "text", text: "没有存档的子 Agent。" }], details: { saves: [] } };
          }
          const lines = saves.map((s) => {
            const age = ((Date.now() - s.savedAt) / 1000 / 60).toFixed(0);
            return `  💾 \`${s.saveId}\` — ${s.name.slice(0, 30)} — ${s.model} — ${s.reason ?? "manual"} — ${s.messages.length} 消息 — ${age}分钟前`;
          });
          return {
            content: [{ type: "text", text: `存档列表 (${saves.length}):\n${lines.join("\n")}` }],
            details: { saves: saves.map((s) => ({ saveId: s.saveId, name: s.name, model: s.model, reason: s.reason ?? "manual", messageCount: s.messages.length, savedAt: s.savedAt })) },
          };
        }

        case "delete_save": {
          if (!taskId) {
            return { content: [{ type: "text", text: "delete_save 需要 taskId（作为 saveId）" }], details: { error: "missing_args" } };
          }
          const ok = deleteAgentSave(taskId);
          ctx.ui.notify(ok ? `🗑 已删除存档: ${taskId}` : `❌ 删除失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `🗑 已删除存档: \`${taskId}\`` : `❌ 存档不存在: \`${taskId}\`` }],
            details: { action: "delete_save", saveId: taskId, ok },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: list | status | send | abort | pause | resume | kill | kill_job | save | list_saves | delete_save` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });
}
