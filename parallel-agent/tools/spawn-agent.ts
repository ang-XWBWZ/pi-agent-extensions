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
import { getExecutionContext } from "../../lib/execution-context.js";
import { loadToolConfig } from "../lib/tier-resolver.js";
import { spawnAllBackground } from "../lib/spawner.js";
import { formatJobFullResult } from "../lib/result-format.js";

// 硬编码安全网
const TOOL_SAFETY_NET: ReadonlySet<string> = new Set([
  "spawn_agent",
  "check_agent_results",
  "read_agent_output",
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
      "Use spawn_agent only for bounded independent work that benefits from parallelism or a second-pass review; in PLAN every task must explicitly use phase=plan or chat.",
      "Give every spawn_agent task a goal, scope, allowed and forbidden tools, expected output, and stop condition.",
      "Do not use spawn_agent for a trivial read/search; completed results auto-inject and can also be checked with check_agent_results.",
      "Use spawn_agent notes for durable initial constraints or handoff context that must remain visible on the child task panel; the child must later submit a conclusion for every meaningful stage and detail only when useful.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "任务标识" }),
          prompt: Type.String({ description: "子任务描述" }),
          context: Type.Optional(Type.Array(Type.String())),
          skills: Type.Optional(Type.Array(Type.String())),
          phase: Type.Optional(StringEnum(["chat", "plan", "work"] as const)),
          provider: Type.Optional(Type.String({ description: "模型 provider（和 model 搭配使用，优先级高于 tier）" })),
          model: Type.Optional(Type.String({ description: "模型 ID（可单独用 provider/model 格式，也可和 provider 分开指定）" })),
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
            const latestStage = saved.taskPanel?.stageReports?.at(-1);
            const historyText = saved.messages
              .map((m) => {
                if (m.role === "user") return `[User]: ${typeof m.content === "string" ? m.content : "(content)"}`;
                if (m.role === "assistant") return `[Assistant]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "(content)"}`;
                return `[${m.role}]`;
              })
              .join("\n");
            const resumeContext = `[从存档恢复: ${saved.name} (${saved.model}, ${saved.messages.length} 条消息)]\n\n--- 历史对话 ---\n${historyText.slice(-10_000)}\n--- 历史结束 ---`;
            const checkpointContext = [
              latestStage?.conclusion
                ? `最新阶段结论: ${latestStage.conclusion}`
                : saved.taskPanel?.summary
                  ? `最新阶段结论（兼容字段）: ${saved.taskPanel.summary}`
                  : undefined,
              latestStage?.detail
                ? `最新阶段详细说明:\n${latestStage.detail}`
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

      const parentExecutionContext = getExecutionContext();
      const inheritableExecutionContext =
        parentExecutionContext.approval.inheritToChildren
          ? parentExecutionContext
          : undefined;
      const inheritedTasks = resolvedTasks.map((task) => ({
        ...task,
        parentExecutionContext:
          task.parentExecutionContext ?? inheritableExecutionContext,
      }));

      const job = createJob(inheritedTasks);
      job.status = "running";
      job._autoInjectRequested = autoInject;

      try {
        pi.appendEntry("agent-job", {
          jobId: job.jobId,
          total,
          tasks: inheritedTasks.map((t) => ({ id: t.id, prompt: t.prompt.slice(0, 80) })),
          createdAt: job.createdAt,
          status: "running",
        });
      } catch { /* */ }

      const filteredTools = getFilteredTools(pi);

      spawnAllBackground(
        job.jobId,
        inheritedTasks,
        ctx.cwd,
        defaultModel,
        ctx.modelRegistry,
        deadline,
        pi,
        filteredTools,
      );

      if (autoInject) {
        onJobComplete(job.jobId, async (completedJob) => {
          if (completedJob._autoInjected || completedJob._autoInjecting) return;
          completedJob._autoInjecting = true;
          try {
            const elapsed = completedJob.finishedAt
              ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
              : "?";
            pi.sendMessage(
              {
                customType: "sub-agent-results",
                content: formatJobFullResult(completedJob, elapsed),
                display: false,
                details: {
                  jobId: completedJob.jobId,
                  status: completedJob.status,
                },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
            completedJob._autoInjected = true;
          } finally {
            completedJob._autoInjecting = false;
          }
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
              `阶段结论/详情: \`control_agent({ action: "status", jobId: "${job.jobId}", taskId, stageOffset: 0 })\`（0 为最新阶段）`,
              `生命周期: \`control_agent({ action: "kill" | "abort" | "send" | "pause" | "resume" | "list" | "status", jobId: "${job.jobId}" })\``,
            ].join("\n"),
          },
        ],
        details: { jobId: job.jobId, taskCount: total, status: "dispatched", autoInject },
      };
    },
  });
}
