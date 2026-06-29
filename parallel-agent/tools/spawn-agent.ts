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

// 硬编码安全网
const TOOL_SAFETY_NET: ReadonlySet<string> = new Set([
  "spawn_agent",
  "check_agent_results",
  "control_agent",
]);

function getFilteredTools(pi: ExtensionAPI): string[] {
  const configBlacklist = new Set(loadToolConfig());
  return (pi.getActiveTools?.() ?? []).filter((t) => {
    if (TOOL_SAFETY_NET.has(t)) return false;
    if (configBlacklist.has(t)) return false;
    return true;
  });
}

export function registerSpawnAgent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "派发子 Agent 执行分析任务。子 Agent 继承默认工具（read/bash/edit/write），" +
      "在后台并行运行，不阻塞主 Agent。返回 jobId 用于查询结果。",
    promptSnippet: "Spawn sub-agents for parallel code exploration (read-only)",
    promptGuidelines: [
      "Use when: the task has independent search, review, comparison, or analysis branches that can run in parallel.",
      "Do not use when: a single local read/search is enough, the decision must be owned by the main agent, or the task needs unsafe side effects.",
      "Phase policy: in Plan, sub-agents should be read-only analysts by default; in Work, delegate bounded implementation or verification only when the scope is explicit.",
      "Authorization policy: sub-agents run guarded by default. Use autonomy:'auto' only when the current Work authorization explicitly allows inheritance.",
      "Workflow: give each task Goal, Scope, Allowed tools, Forbidden tools, Expected output, and Stop condition.",
      "Conflict policy: use direct read/rg for cheap local lookups; use spawn_agent only for parallelism or second-pass review.",
      "Failure / fallback: if a sub-agent times out or returns vague output, narrow the task and retry once, or continue with direct inspection.",
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
      "Task model resolution priority: task.provider+task.model > task.model (provider/model format) > task.tier > main agent model.",
      "Skills passed in spawn_agent are loaded in FULL.",
      "Skills in the global settings.json skills.blacklist are never loaded.",
      "Delegate independent read/search/analysis tasks only. Sub-agents are YOUR workers — dispatch and move on.",
      "FORBIDDEN: Do NOT spawn sub-agents for trivial single-file reads or single kb_search calls. These are faster done directly.",
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
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "单任务超时秒（默认 60）" })),
      autoInject: Type.Optional(Type.Boolean({ description: "完成后自动推送结果到主对话（默认 true）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const total = params.tasks.length;
      const deadline = (params.timeout ?? 60) * 1000;
      const autoInject = params.autoInject !== false;

      if (signal?.aborted) throw new Error("操作已取消");

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
      for (const task of params.tasks as SubTask[]) {
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
            resolvedTasks.push({
              ...task,
              context: [...(task.context || []), resumeContext],
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
