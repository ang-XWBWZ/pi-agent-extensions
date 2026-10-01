import { BASELINE_CORE_TOOLS, computeActiveTools, getDefaultActivationState } from "../../lib/capability-router.js";
import { capabilityToolRegistry } from "../../lib/capability-dispatch.js";
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
  claimDelivery,
  failDelivery,
  finalizeDelivery,
  type SubTask,
  type AgentJob,
} from "../../lib/agent-bus.js";
import { getExecutionContext } from "../../lib/execution-context.js";
import { isToolResultError, renderStructuredToolCall, renderToolResult } from "../../lib/tui-render.js";
import { loadToolConfig } from "../lib/tier-resolver.js";
import { buildResumeContext } from "../lib/resume.js";
import { spawnAllBackground } from "../lib/spawner.js";
import { formatJobFullResult } from "../lib/result-format.js";

// 硬编码安全网
export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 600;
/** G02：单次派发任务数上限，超出时明确报错而不是无界创建会话。 */
export const MAX_TASKS_PER_DISPATCH = 8;

const TOOL_SAFETY_NET: ReadonlySet<string> = new Set([
  "spawn_agent",
  "check_agent_results",
  "read_agent_output",
  "control_agent",
]);
const REQUIRED_CHILD_TOOLS: ReadonlySet<string> = new Set([
  "update_agent_task",
]);

function getFilteredTools(
  pi: ExtensionAPI,
  phase: "chat" | "plan" | "work" = "work",
  sessionManager?: object,
): string[] {
  const configBlacklist = new Set(loadToolConfig());
  const filtered = [...new Set([...BASELINE_CORE_TOOLS, ...computeActiveTools(phase, getDefaultActivationState(sessionManager))])].filter((t) => {
    if (TOOL_SAFETY_NET.has(t)) return false;
    if (REQUIRED_CHILD_TOOLS.has(t)) return true;
    if (configBlacklist.has(t)) return false;
    return true;
  });
  // A09：update_agent_task 仅在 Plan/Work 保留；Chat 遵守全部工具禁用边界。
  if (phase !== "chat") {
    for (const required of REQUIRED_CHILD_TOOLS) {
      if (!filtered.includes(required)) filtered.push(required);
    }
  }
  return filtered;
}

export function registerSpawnAgent(pi: ExtensionAPI): void {
  capabilityToolRegistry(pi).registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "派发子 Agent 执行分析任务。子 Agent 继承默认工具（read/bash/edit/write），" +
      "在后台并行运行，不阻塞主 Agent。每个任务拥有独立、增量落盘的任务面板与备注。" +
      "返回 jobId 用于查询结果。",
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
          thinkingLevel: Type.Optional(Type.String({ description: "覆盖层级默认思考深度: off | minimal | low | medium | high | xhigh | max" })),
          resumeFrom: Type.Optional(Type.String({ description: "从存档恢复（saveId），继承历史对话上下文" })),
          notes: Type.Optional(Type.Array(Type.String({ description: "任务面板初始备注" }))),
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "单任务超时秒（默认 600，即 10 分钟）" })),
      wallClock: Type.Optional(
        Type.Number({
          description:
            "整个 Job 的可选总墙钟上限秒数（含排队与暂停；缺省或 0 表示不限制）。到点后未启动的排队任务标记为超时。",
        }),
      ),
      autoInject: Type.Optional(Type.Boolean({ description: "完成后自动推送结果到主对话（默认 true）" })),
    }),
    renderCall(args, theme, context) {
      const taskIds = Array.isArray(args.tasks)
        ? args.tasks.map((task) => task.id).join(", ")
        : undefined;
      return renderStructuredToolCall(theme, context, "spawn_agent", [
        { name: "tasks", value: taskIds, tone: "accent", maxLength: 180 },
        { name: "timeout", value: args.timeout, tone: "muted" },
        { name: "wallClock", value: args.wallClock, tone: "muted" },
        { name: "autoInject", value: args.autoInject, tone: "muted" },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 8,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const total = params.tasks.length;
      const timeoutSeconds = params.timeout ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS;
      const autoInject = params.autoInject !== false;

      if (signal?.aborted) throw new Error("操作已取消");
      if (total === 0) throw new Error("spawn_agent 至少需要一个子任务");
      if (total > MAX_TASKS_PER_DISPATCH) {
        throw new Error(
          `spawn_agent 单次最多派发 ${MAX_TASKS_PER_DISPATCH} 个子任务（收到 ${total}）；请拆分为多个 Job。`,
        );
      }
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("spawn_agent timeout 必须是大于 0 的有限秒数");
      }
      if (
        params.wallClock !== undefined &&
        (!Number.isFinite(params.wallClock) || params.wallClock <= 0)
      ) {
        throw new Error(
          "spawn_agent wallClock 必须是大于 0 的有限秒数（缺省表示不限制）",
        );
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

      // 处理 resumeFrom：把存档数据放进独立内联字段（F01/F02/F03/F05）。
      const resolvedTasks: SubTask[] = [];
      const missingResumes: string[] = [];
      for (const rawTask of params.tasks as SubTask[]) {
        const task: SubTask = { ...rawTask, id: rawTask.id.trim() };
        const resumeId = (task as Record<string, unknown>).resumeFrom as string | undefined;
        if (resumeId) {
          const saved = loadAgentState(resumeId);
          if (!saved) {
            // F04：指定存档不存在/损坏时明确报错，不静默退化成全新任务。
            missingResumes.push(resumeId);
            continue;
          }
          const resume = buildResumeContext(saved);
          const resumeNote = `从存档 ${resume.saveId} 恢复（源 job ${resume.sourceJobId ?? "?"} / task ${resume.sourceTaskId ?? "?"}）`;
          resolvedTasks.push({
            ...task,
            // 恢复文本进入内联字段；task.context 仍只表示文件路径。
            contextText: [task.contextText, resume.text]
              .filter(Boolean)
              .join("\n\n"),
            resumedFrom: resume.saveId,
            sourceJobId: resume.sourceJobId,
            sourceTaskId: resume.sourceTaskId,
            notes: [...(task.notes ?? []), resumeNote],
          });
        } else {
          resolvedTasks.push(task);
        }
      }

      if (missingResumes.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                "恢复失败：以下存档不存在或已损坏，未派发任何任务（不静默退化为全新任务）：",
                ...missingResumes.map((id) => `  - ${id}`),
                "",
                "请确认 saveId（来自 timeout/runtime 结果的 saveId 字段）是否正确。",
              ].join("\n"),
            },
          ],
          details: { error: "resume_not_found", missing: missingResumes },
        };
      }

      const parentExecutionContext = getExecutionContext(ctx?.sessionManager);
      const inheritableExecutionContext =
        parentExecutionContext.approval.inheritToChildren
          ? parentExecutionContext
          : undefined;
      const inheritedTasks = resolvedTasks.map((task) => ({
        ...task,
        parentExecutionContext:
          task.parentExecutionContext ?? inheritableExecutionContext,
      }));

      // C08/D06：用会话 runtime 的真实 sessionId 作为 owner，便于消息与 UI 归属。
      const ownerSessionId = getExecutionContext(ctx?.sessionManager).sessionId;
      const job = createJob(inheritedTasks, ownerSessionId);
      job.status = "running";
      job._autoInjectRequested = autoInject;
      // C03：可选总墙钟上限（独立字段，不改变缺省语义）。
      if (params.wallClock && params.wallClock > 0) {
        job.wallClockSeconds = params.wallClock;
        job.wallClockDeadline = job.createdAt + params.wallClock * 1000;
      }
      if (job.delivery) {
        job.delivery.requested = autoInject;
      }

      try {
        pi.appendEntry("agent-job", {
          jobId: job.jobId,
          total,
          tasks: inheritedTasks.map((t) => ({ id: t.id, prompt: t.prompt.slice(0, 80) })),
          createdAt: job.createdAt,
          status: "running",
        });
      } catch { /* */ }

      const filteredTools = getFilteredTools(
        pi,
        getExecutionContext(ctx?.sessionManager)?.phase ?? "work",
        ctx?.sessionManager,
      );

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
          if (!claimDelivery(completedJob, "auto")) return;
          try {
            if (completedJob._autoInjected) return;
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
            finalizeDelivery(completedJob, "auto");
          } catch (error: any) {
            failDelivery(completedJob, error?.message ?? String(error));
            throw error;
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
