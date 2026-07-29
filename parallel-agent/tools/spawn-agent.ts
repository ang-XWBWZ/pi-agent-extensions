/**
 * spawn-agent.ts — spawn_agent 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createJob,
  onJobComplete,
  loadAgentState,
  type SubTask,
  type AgentJob,
} from "../../lib/agent-bus.js";
import { loadToolConfig } from "../lib/tier-resolver.js";
import { spawnAllBackground } from "../lib/spawner.js";

// 硬编码安全网
const TOOL_SAFETY_NET: ReadonlySet<string> = new Set([
  "spawn_agent",
  "check_agent_results",
  "control_agent",
]);
const REQUIRED_CHILD_TOOLS: ReadonlySet<string> = new Set([
  "update_agent_task",
]);

function getFilteredTools(pi: ExtensionAPI): string[] {
  const configBlacklist = new Set(loadToolConfig());
  const filtered = (pi.getActiveTools?.() ?? []).filter((t) => {
    if (TOOL_SAFETY_NET.has(t)) return false;
    if (REQUIRED_CHILD_TOOLS.has(t)) return true;
    if (configBlacklist.has(t)) return false;
    return true;
  });
  for (const required of REQUIRED_CHILD_TOOLS) {
    if (!filtered.includes(required)) filtered.push(required);
  }
  return filtered;
}

export function registerSpawnAgent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "派发子 Agent 执行分析任务。子 Agent 继承默认工具（read/bash/edit/write），" +
      "在后台并行运行，不阻塞主 Agent。每个任务拥有独立、增量落盘的任务面板与备注。" +
      "返回 jobId 用于查询结果。",
    promptSnippet: "Spawn sub-agents for parallel code exploration (read-only)",
    promptGuidelines: [
      "Use spawn_agent to delegate exploration/research to sub-agents.",
      "Each task runs in an isolated in-memory session with default tools.",
      "Keep prompts focused on analysis. Results returned as structured JSON.",
      "After spawning, use check_agent_results(jobId) to retrieve results.",
      "For multiple independent tasks, spawn them together for parallel execution.",
      "Results are auto-injected into the conversation when complete — you DO NOT need to block-wait. Keep interacting with the user normally.",
      "To resume from a saved state, set resumeFrom on the task to the saveId from control_agent save/list_saves.",
      "Each task supports 'tier' (L0/L1/L2) for automatic model + thinking level selection from modelTiers config.",
      "Use tier: \"L0\" for cheap/fast tasks: file lookups, code maps, simple queries — saves tokens.",
      "Use tier: \"L1\" (default if not specified) for coding, refactoring, debugging.",
      "Use tier: \"L2\" for architecture design, cross-module analysis, security review — deepest reasoning.",
      "Override thinking level per task with 'thinkingLevel' (off/minimal/low/medium/high/xhigh).",
      "Task model resolution priority: task.model > task.tier > main agent model.",
      "Skills passed in spawn_agent are loaded in FULL.",
      "Skills in the global settings.json skills.blacklist are never loaded.",
      "Delegate independent read/search/analysis tasks only. Sub-agents are YOUR workers — dispatch and move on.",
      "FORBIDDEN: Do NOT spawn sub-agents for trivial single-file reads or single kb_search calls. These are faster done directly.",
      "Use spawn_agent notes for durable initial constraints or handoff context that must remain visible on the child task panel.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "任务标识" }),
          prompt: Type.String({ description: "子任务描述" }),
          context: Type.Optional(Type.Array(Type.String())),
          skills: Type.Optional(Type.Array(Type.String())),
          mode: Type.Optional(StringEnum(["plan", "work", "yolo"] as const)),
          model: Type.Optional(Type.String()),
          tier: Type.Optional(Type.String({ description: "模型层级: L0(快速) | L1(主要) | L2(高级)。自动选模型+思考深度" })),
          thinkingLevel: Type.Optional(Type.String({ description: "覆盖层级默认思考深度: off | minimal | low | medium | high | xhigh" })),
          resumeFrom: Type.Optional(Type.String({ description: "从存档恢复（saveId），继承历史对话上下文" })),
          notes: Type.Optional(Type.Array(Type.String({ description: "任务面板初始备注" }))),
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "单任务超时秒（默认 60）" })),
      autoInject: Type.Optional(Type.Boolean({ description: "完成后自动推送结果到主对话（默认 true）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const total = params.tasks.length;
      const timeoutSeconds = params.timeout ?? 60;
      const autoInject = params.autoInject !== false;

      if (signal?.aborted) throw new Error("操作已取消");
      if (total === 0) throw new Error("spawn_agent 至少需要一个子任务");
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("spawn_agent timeout 必须是大于 0 的有限秒数");
      }
      const taskIds = params.tasks.map((task) => task.id.trim());
      if (taskIds.some((taskId) => !taskId)) {
        throw new Error("spawn_agent task.id 不能为空");
      }
      const duplicateIds = taskIds.filter(
        (taskId, index) => taskIds.indexOf(taskId) !== index,
      );
      if (duplicateIds.length > 0) {
        throw new Error(
          `spawn_agent 同一 Job 内 task.id 必须唯一: ${[
            ...new Set(duplicateIds),
          ].join(", ")}`,
        );
      }
      const deadline = timeoutSeconds * 1000;

      let defaultModel: Model<any> | undefined = undefined;
      if (ctx.model) defaultModel = ctx.model as Model<any>;

      if (!defaultModel) {
        return {
          content: [{ type: "text", text: "错误: 没有可用的模型" }],
          details: { error: "no model" },
        };
      }

      // 处理 resumeFrom：注入存档上下文
      const resolvedTasks: SubTask[] = [];
      for (const rawTask of params.tasks as SubTask[]) {
        const task: SubTask = { ...rawTask, id: rawTask.id.trim() };
        const resumeId = (task as Record<string, unknown>).resumeFrom as string | undefined;
        if (resumeId) {
          const saved = loadAgentState(resumeId);
          if (saved) {
            const historyText = saved.messages
              .map((m) => {
                if (m.role === "user") return `[User]: ${typeof m.content === "string" ? m.content : "(content)"}`;
                if (m.role === "assistant") return `[Assistant]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "(content)"}`;
                return `[${m.role}]`;
              })
              .join("\n");
            const resumeContext = `[从存档恢复: ${saved.name} (${saved.model}, ${saved.messages.length} 条消息)]\n\n--- 历史对话 ---\n${historyText.slice(-10_000)}\n--- 历史结束 ---`;
            const checkpointContext = [
              saved.taskPanel?.summary
                ? `阶段摘要: ${saved.taskPanel.summary}`
                : undefined,
              saved.output ? `中间输出快照:\n${saved.output}` : undefined,
              saved.taskPanel?.notes.length
                ? `任务备注:\n${saved.taskPanel.notes
                    .slice(-20)
                    .map((note) => `- ${note.text}`)
                    .join("\n")}`
                : undefined,
            ]
              .filter((item): item is string => Boolean(item))
              .join("\n\n");
            resolvedTasks.push({
              ...task,
              context: [
                ...(task.context || []),
                checkpointContext
                  ? `${resumeContext}\n\n--- 持久化检查点 ---\n${checkpointContext}`
                  : resumeContext,
              ],
            });
          } else {
            console.warn(`[parallel-agent] 存档 ${resumeId} 不存在，跳过恢复`);
            resolvedTasks.push(task);
          }
        } else {
          resolvedTasks.push(task);
        }
      }

      const job = createJob(resolvedTasks);
      job.status = "running";

      try {
        pi.appendEntry("agent-job", {
          jobId: job.jobId,
          total,
          tasks: resolvedTasks.map((t) => ({ id: t.id, prompt: t.prompt.slice(0, 80) })),
          createdAt: job.createdAt,
          status: "running",
        });
      } catch { /* */ }

      const filteredTools = getFilteredTools(pi);

      spawnAllBackground(
        job.jobId,
        resolvedTasks,
        ctx.cwd,
        defaultModel,
        ctx.modelRegistry,
        deadline,
        pi,
        filteredTools,
      );

      if (autoInject) {
        onJobComplete(job.jobId, async (completedJob) => {
          if (completedJob._autoInjected) return;
          completedJob._autoInjected = true;
        });
      }

      ctx.ui.notify(`🚀 已派发 ${total} 个子任务 (job: ${job.jobId.slice(0, 8)})`, "info");

      return {
        content: [
          {
            type: "text",
            text: [
              `✅ 已派发 ${total} 个子任务，后台并行执行中。`,
              `🔄 完成后将自动推送结果到对话，无需阻塞等待。`,
              ``,
              `📋 Job ID: \`${job.jobId}\``,
              `📊 任务数: ${total}`,
              `📌 每个子任务的面板、备注和输出快照会在执行中增量落盘；超时会自动生成可恢复 saveId。`,
              ``,
              `主动查询: \`check_agent_results("${job.jobId}")\`（非阻塞，立即返回当前进度）`,
              `生命周期: \`control_agent({ action: "kill" | "abort" | "send" | "pause" | "resume" | "list" | "status", jobId: "${job.jobId}" })\``,
            ].join("\n"),
          },
        ],
        details: { jobId: job.jobId, taskCount: total, status: "dispatched", autoInject },
      };
    },
  });
}
