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
  type SubResult,
} from "../../lib/agent-bus.js";
import { fmtNum } from "./helpers.js";
import { resolveTaskConfig, forceThinkingSupport } from "./tier-resolver.js";
import { runSingleAgent } from "./agent-runner.js";

// ---- Job 统计 ----

export interface JobStats {
  input: number;
  output: number;
  cache: number;
  cost: number;
  ctxPct: number;
  ctxWin: number;
}

export function computeJobStats(results: SubResult[]): JobStats {
  return results.reduce((acc, r) => {
    if (r.tokens) {
      acc.input += r.tokens.input;
      acc.output += r.tokens.output;
      acc.cache += r.tokens.cache;
      acc.cost += r.tokens.cost;
      if (r.tokens.contextPercent !== null) {
        acc.ctxPct = Math.max(acc.ctxPct, r.tokens.contextPercent);
      }
      acc.ctxWin = Math.max(acc.ctxWin, r.tokens.contextWindow);
    }
    return acc;
  }, { input: 0, output: 0, cache: 0, cost: 0, ctxPct: 0, ctxWin: 0 });
}

export function formatJobNotificationLine(jobId: string, results: SubResult[], total: number, elapsed: string): string {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const totalTokens = computeJobStats(results);
  const statsPart = totalTokens.input > 0
    ? ` | 📊 \u2191${fmtNum(totalTokens.input)} \u2193${fmtNum(totalTokens.output)} R${fmtNum(totalTokens.cache)} $${totalTokens.cost < 0.001 ? totalTokens.cost.toExponential(2) : totalTokens.cost.toFixed(3)} ${totalTokens.ctxPct > 0 ? totalTokens.ctxPct.toFixed(1) + "%" : "?%"}${totalTokens.ctxWin > 0 ? "/" + fmtNum(totalTokens.ctxWin) : ""}`
    : "";
  return `\u{1f916} [\u5b50\u4efb\u52a1\u5b8c\u6210] Job \`${jobId.slice(0, 8)}\` \u2014 \u2705 ${okCount} / \u274c ${failCount} / \u{1f4ca} ${total} (${elapsed}s)${statsPart}`;
}

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

    // 优先级 1: task.model 精确指定
    if (task.model) {
      const [p, m] = task.model.split("/");
      const found = modelRegistry.find(p, m);
      if (found) {
        subModel = found;
        subThinkingLevel = (
          task as Record<string, unknown>
        ).thinkingLevel as string | undefined;
      } else {
        console.warn(
          `[parallel-agent] 模型 ${task.model} 未找到，降级`,
        );
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
        });
      });
  }
}
