/**
 * spawner.ts — 后台批量启动子 Agent（有界并发，fire-and-forget）
 *
 * G01：任务进入有界调度队列，最多同时运行 `maxConcurrentSubAgents()` 个；
 * 未启动的任务在面板中保持 queued。
 * G02：启动前复查取消标记，被取消的排队任务不创建 SDK 会话。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import {
  publishTaskResult,
  publishCancelledBeforeStart,
  publishWallClockExceeded,
  isTaskCancelled,
  isPastWallClock,
  updateAgentTaskPanel,
  getJob,
  cleanupJobs,
  type SubTask,
} from "../../lib/agent-bus.js";
import { resolveTaskConfig, forceThinkingSupport } from "./tier-resolver.js";
import { runSingleAgent } from "./agent-runner.js";
import { runBounded } from "./bounded-queue.js";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;

/** G01：可配置并发上限（PI_MAX_SUBAGENTS）；非法值回退默认。 */
export function maxConcurrentSubAgents(): number {
  const raw = Number(process.env.PI_MAX_SUBAGENTS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_CONCURRENT_SUBAGENTS;
}

interface DispatchItem {
  task: SubTask;
  order: number;
}

/** 解析单个任务的模型并执行；始终提交一次终态。 */
async function dispatchTask(
  jobId: string,
  item: DispatchItem,
  cwd: string,
  defaultModel: Model<any> | undefined,
  modelRegistry: ModelRegistry,
  deadline: number,
  pi: ExtensionAPI,
  tools: string[],
): Promise<void> {
  const { task, order } = item;

  // G03：记录请求的模型/tier 与降级原因，不静默把降级当成原请求执行。
  const requestedProvider = (task as SubTask & { provider?: string }).provider;
  const requestedModel =
    requestedProvider && task.model
      ? `${requestedProvider}/${task.model}`
      : task.model;
  const requestedTier = (task as Record<string, unknown>).tier as string | undefined;
  let fallbackReason: string | undefined;

  let subModel: Model<any> | undefined = undefined;
  let subThinkingLevel: string | undefined = undefined;

  // 优先级 1: task.provider + task.model 或 task.model 精确指定
  const taskRecord = task as SubTask & { provider?: string };
  const explicitProvider = taskRecord.provider;
  if (explicitProvider || task.model) {
    const p = explicitProvider ?? task.model!.split("/")[0];
    const m = explicitProvider ? task.model! : task.model!.split("/").slice(1).join("/") || task.model!;
    if (p && m) {
      const found = modelRegistry.find(p, m);
      if (found) {
        subModel = found;
        subThinkingLevel = (task as Record<string, unknown>).thinkingLevel as string | undefined;
      } else {
        fallbackReason = `显式模型 ${p}/${m} 未找到，按后续优先级降级`;
        console.warn(`[parallel-agent] 模型 ${p}/${m} 未找到，降级`);
      }
    }
  }

  // 优先级 2: task.tier 层级解析
  if (!subModel) {
    const resolved = resolveTaskConfig(
      task as SubTask & { tier?: string; thinkingLevel?: string },
    );
    if (resolved) {
      const [p, m] = resolved.model.split("/");
      const found = modelRegistry.find(p, m);
      if (found) {
        subModel = found;
        subThinkingLevel = resolved.thinkingLevel;
      } else {
        fallbackReason = `tier ${task.tier} → ${resolved.model} 未找到，继承父模型`;
        console.warn(`[parallel-agent] tier=${task.tier} → ${resolved.model} 未找到，降级`);
      }
    }
  }

  // 优先级 3: 继承主 Agent 模型
  if (!subModel) subModel = defaultModel;
  if (!subThinkingLevel) subThinkingLevel = pi.getThinkingLevel();
  const name = task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id;

  if (!subModel) {
    publishTaskResult(jobId, {
      id: task.id,
      name,
      order,
      ok: false,
      error: "no model available",
      errorCode: "configuration",
      outcome: "failed",
      terminalReason: "没有可用模型，任务未启动",
      requestedModel,
      requestedTier,
      fallbackReason,
    });
    return;
  }

  forceThinkingSupport(subModel);

  // G03：降级原因写入面板备注，便于父 Agent 验收时判断执行成本。
  if (fallbackReason) {
    try {
      updateAgentTaskPanel(jobId, task.id, {
        note: fallbackReason,
        noteSource: "system",
      });
    } catch {
      // 面板不可用时不影响派发
    }
  }

  try {
    const result = await runSingleAgent(
      task,
      order,
      jobId,
      cwd,
      subModel,
      modelRegistry,
      deadline,
      pi,
      subThinkingLevel,
      (task as Record<string, unknown>).tier as string | undefined,
      tools,
    );
    result.model = `${subModel.provider}/${subModel.id}`;
    result.requestedModel = requestedModel;
    result.requestedTier = requestedTier;
    result.fallbackReason = fallbackReason;
    publishTaskResult(jobId, result);

    try {
      pi.appendEntry("agent-job-progress", {
        jobId,
        result,
        completed: getJob(jobId)?.completed ?? 0,
        total: getJob(jobId)?.total ?? 0,
        timestamp: Date.now(),
      });
    } catch {
      // 非主 session 忽略
    }

    cleanupJobs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publishTaskResult(jobId, {
      id: task.id,
      name,
      order,
      ok: false,
      error: message,
      errorCode: "runtime",
      outcome: "failed",
      terminalReason: `派发异常: ${message}`,
      model: `${subModel.provider}/${subModel.id}`,
      requestedModel,
      requestedTier,
      fallbackReason,
    });
  }
}

export function spawnAllBackground(
  jobId: string,
  tasks: SubTask[],
  cwd: string,
  defaultModel: Model<any> | undefined,
  modelRegistry: ModelRegistry,
  deadline: number,
  pi: ExtensionAPI,
  tools: string[],
): void {
  const items: DispatchItem[] = tasks.map((task, index) => ({
    task,
    order: index + 1,
  }));

  void runBounded(items, {
    limit: maxConcurrentSubAgents(),
    // C03/C04：启动前复查取消标记与可选总墙钟上限。
    shouldSkip: (item) =>
      isTaskCancelled(jobId, item.task.id) || isPastWallClock(jobId),
    onSkip: (item) => {
      if (isPastWallClock(jobId) && !isTaskCancelled(jobId, item.task.id)) {
        publishWallClockExceeded(jobId, item.task, item.order);
      } else {
        publishCancelledBeforeStart(jobId, item.task, item.order);
      }
    },
    worker: (item) =>
      dispatchTask(jobId, item, cwd, defaultModel, modelRegistry, deadline, pi, tools),
  });
}
