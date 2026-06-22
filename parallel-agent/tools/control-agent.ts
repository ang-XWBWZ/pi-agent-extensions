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
  saveAgentState,
  deleteAgentSave,
  listAgentSaves,
  type AgentInstance,
} from "../../lib/agent-bus.js";

export function registerControlAgent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "control_agent",
    label: "Control Agent",
    description:
      "控制子 Agent 生命周期：列出、查看状态、注入消息、打断、暂停、恢复、杀死、存档、恢复存档、删除存档。" +
      "支持操作单个 task 或整个 job。",
    promptSnippet: "Manage sub-agent lifecycle (list/status/send/abort/pause/resume/kill/save/load/list_saves/delete_save)",
    promptGuidelines: [
      "Use control_agent to manage running sub-agents spawned by spawn_agent.",
      "Actions: 'list' (list all instances), 'status' (get one instance details),",
      "  'send' (inject message via steer), 'abort' (interrupt but keep alive),",
      "  'pause' (abort + mark paused), 'resume' (continue paused agent),",
      "  'kill' (dispose one agent), 'kill_job' (kill all agents in a job).",
      "  'save' (save agent state to disk), 'list_saves' (list saved agents),",
      "  'delete_save' (delete a saved state).",
      "taskId is required for single-agent actions; omit taskId for job-wide operations.",
      "Use 'save' to checkpoint a sub-agent before risky operations. Use 'list_saves' to see available checkpoints.",
      "Use 'list' first to survey. Use 'kill'/'kill_job' to clean up stuck or zombie agents.",
      "FORBIDDEN: Do NOT kill agents silently. Always report to the user what was killed and why.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: list | status | send | abort | pause | resume | kill | kill_job | save | list_saves | delete_save" }),
      jobId: Type.Optional(Type.String({ description: "Job ID" })),
      taskId: Type.Optional(Type.String({ description: "Task ID（单 agent 操作时必填）" })),
      input: Type.Optional(Type.String({ description: "消息内容（send/resume 操作时使用）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");
      const { action, jobId, taskId, input } = params;

      // ---- list ----
      if (action === "list") {
        const insts = listInstances();
        if (insts.length === 0) {
          return {
            content: [{ type: "text", text: "没有运行中的子 Agent 实例。" }],
            details: { instances: [] },
          };
        }
        const lines = insts.map((inst) => {
          const icon =
            inst.detailedStatus === "thinking" ? "🧠" :
            inst.detailedStatus === "tool_calling" ? "🔧" :
            inst.detailedStatus === "idle" ? "⏳" :
            inst.detailedStatus === "paused" ? "⏸️" :
            inst.detailedStatus === "done" ? "✅" :
            inst.status === "paused" ? "⏸️" : "🟢";
          const extra = inst.currentTool ? ` [${inst.currentTool}]` : "";
          const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
          return `${icon} [${inst.jobId.slice(0, 8)}] ${inst.taskId} — ${inst.name.slice(0, 30)} — ${inst.detailedStatus}${extra} (${elapsed}s)`;
        });
        return {
          content: [{ type: "text", text: `运行中的子 Agent (${insts.length}):\n${lines.join("\n")}` }],
          details: { instances: insts.map((i) => ({ jobId: i.jobId, taskId: i.taskId, name: i.name, status: i.status, detailedStatus: i.detailedStatus, currentTool: i.currentTool })) },
        };
      }

      // ---- status ----
      if (action === "status") {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: "status 操作需要 jobId 和 taskId" }], details: { error: "missing_args" } };
        }
        const inst = getJobInstances(jobId).find((i) => i.taskId === taskId);
        if (!inst) {
          return { content: [{ type: "text", text: `实例不存在: ${jobId}/${taskId}` }], details: { error: "not_found" } };
        }
        const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
        const idleSec = inst.lastActivityAt ? ((Date.now() - inst.lastActivityAt) / 1000).toFixed(0) : "?";

        const toolLines = inst.toolHistory.length > 0
          ? ["", "📋 工具调用历史:", ...inst.toolHistory.slice(-10).map((t) => {
              const icon = t.status === "started" ? "▶" : t.status === "error" ? "❌" : "✅";
              const dur = t.duration ? ` ${t.duration}ms` : "";
              const err = t.error ? ` (${t.error.slice(0, 60)})` : "";
              return `  ${icon} ${t.toolName} [${t.status}]${dur}${err}`;
            })]
          : [];

        const lines = [
          `📊 ${inst.name}`,
          `   Job: ${inst.jobId.slice(0, 8)} | Task: ${inst.taskId}`,
          `   精细状态: ${inst.detailedStatus}${inst.currentTool ? ` (${inst.currentTool})` : ""} | 传统: ${inst.status} | 运行: ${elapsed}s | 空闲: ${idleSec}s`,
          `   输入: ${inst.promptLength}字 | 输出: ${inst.outputLength}字 | 自动续推: ${inst.autoContinue ? "✅" : "❌"}(${inst.autoContinueDelay}s)`,
          ...toolLines,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            jobId: inst.jobId, taskId: inst.taskId, name: inst.name,
            status: inst.status, detailedStatus: inst.detailedStatus,
            currentTool: inst.currentTool, elapsed, idleSec,
            promptLength: inst.promptLength, outputLength: inst.outputLength,
            autoContinue: inst.autoContinue, toolHistory: inst.toolHistory.slice(-10),
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
          const saved = saveAgentState(jobId!, taskId!);
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
            return `  💾 \`${s.saveId}\` — ${s.name.slice(0, 30)} — ${s.model} — ${s.messages.length} 消息 — ${age}分钟前`;
          });
          return {
            content: [{ type: "text", text: `存档列表 (${saves.length}):\n${lines.join("\n")}` }],
            details: { saves: saves.map((s) => ({ saveId: s.saveId, name: s.name, model: s.model, messageCount: s.messages.length, savedAt: s.savedAt })) },
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
