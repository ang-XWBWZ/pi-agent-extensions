/**
 * spawner.ts — 后台批量启动子 Agent（fire-and-forget）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import {
  publishTaskResult,
  getJob,
  cleanupJobs,
  type SubTask,
} from "../../lib/agent-bus.js";
import { resolveTaskConfig, forceThinkingSupport } from "./tier-resolver.js";
import { runSingleAgent } from "./agent-runner.js";

// ---- 批量启动 ----

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
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

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
          subThinkingLevel = (
            task as Record<string, unknown>
          ).thinkingLevel as string | undefined;
        } else {
          console.warn(
            `[parallel-agent] 模型 ${p}/${m} 未找到，降级`,
          );
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
          console.warn(
            `[parallel-agent] tier=${task.tier} → ${resolved.model} 未找到，降级`,
          );
        }
      }
    }

    // 优先级 3: 继承主 Agent 模型
    if (!subModel) subModel = defaultModel;
    if (!subThinkingLevel) subThinkingLevel = pi.getThinkingLevel();

    if (!subModel) {
      publishTaskResult(jobId, {
        id: task.id,
        name: task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id,
        order: i + 1,
        ok: false,
        error: "no model available",
        errorCode: "configuration",
      });
      continue;
    }

    forceThinkingSupport(subModel);

    const name =
      task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id;

    runSingleAgent(
      task,
      i + 1,
      jobId,
      cwd,
      subModel,
      modelRegistry,
      deadline,
      pi,
      subThinkingLevel,
      (task as Record<string, unknown>).tier as string | undefined,
      tools,
    )
      .then((result) => {
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
      })
      .catch((err) => {
        publishTaskResult(jobId, {
          id: task.id,
          name,
          order: i + 1,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          errorCode: "runtime",
        });
      });
  }
}
