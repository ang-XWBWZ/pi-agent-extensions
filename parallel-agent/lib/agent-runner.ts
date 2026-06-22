/**
 * agent-runner.ts — 单子 Agent 执行（事件驱动，注册实例）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import {
  registerInstance,
  unregisterInstance,
  getInstance,
  saveAgentState,
  updateInstanceStatus,
  type SubTask,
  type SubResult,
  type AgentInstance,
} from "../../lib/agent-bus.js";
import {
  loadContext,
  loadSkill,
  estimateTokens,
  subAgentIdentity,
} from "./helpers.js";
import { loadSkillConfig } from "./tier-resolver.js";

// ---- Session 创建串行化（防止并发 globalThis 写入） ----
let sessionChain = Promise.resolve();

export function runSingleAgent(
  task: SubTask,
  order: number,
  jobId: string,
  cwd: string,
  subModel: Model<any>,
  modelRegistry: ModelRegistry,
  deadline: number,
  pi: ExtensionAPI,
  thinkingLevel?: string,
  tier?: string,
  tools?: string[],
): Promise<SubResult> {
  const name =
    task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id;

  return new Promise((resolve) => {
    (async () => {
      let unsubRef: (() => void) | undefined;
      let timerRef: ReturnType<typeof setTimeout> | null = null;
      let instRef: AgentInstance | undefined;

      /** 统一终止入口 */
      const finish = async (result: SubResult) => {
        const inst = instRef ? getInstance(jobId, task.id) : undefined;
        if (inst?._settled) return;
        if (inst) {
          inst._settled = true;
          try { await inst.session.abort(); } catch { /* */ }
          try { unsubRef?.(); } catch { /* */ }
          if (timerRef) { clearTimeout(timerRef); timerRef = null; }
          try { inst.session.dispose(); } catch { /* */ }
          try { unregisterInstance(jobId, task.id); } catch { /* */ }
        }
        resolve(result);
      };

      try {
        // 上下文 + skill 注入
        let extra = "";
        if (task.context?.length) extra += await loadContext(task.context, cwd);
        if (task.skills?.length) {
          const config = loadSkillConfig();
          for (const s of task.skills) {
            if (config.blacklist.includes(s)) continue;
            extra += await loadSkill(s);
          }
        }
        const prompt = extra
          ? `${task.prompt}\n\n[注入上下文]\n${extra}`
          : task.prompt;

        // ---- 串行化 globalThis 写入 ----
        sessionChain = sessionChain.then(async () => {
          (globalThis as Record<string, unknown>).__pi_default_mode =
            task.mode || "work";
          (globalThis as Record<string, unknown>).__pi_is_sub_agent = true;

          try {
            const sm = SessionManager.inMemory();
            subAgentIdentity.set(sm, task.id);
            const opts: Record<string, unknown> = {
              sessionManager: sm,
              modelRegistry,
              model: subModel,
              cwd,
            };
            if (thinkingLevel) opts.thinkingLevel = thinkingLevel;
            if (tools && tools.length > 0) opts.tools = tools;
            const created = await createAgentSession(
              opts as Parameters<typeof createAgentSession>[0],
            );
            return created.session;
          } finally {
            delete (globalThis as Record<string, unknown>).__pi_default_mode;
            delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;
          }
        });
        const session = await sessionChain;

        // ---- 外部控制状态 ----
        let abortedExternally = false;

        // ---- 注册实例 ----
        instRef = {
          jobId,
          taskId: task.id,
          name,
          session,
          status: "running",
          detailedStatus: "running",
          currentTool: undefined,
          toolHistory: [],
          lastActivityAt: Date.now(),
          autoContinue: (task as Record<string, unknown>).autoContinue === true,
          autoContinueDelay: ((task as Record<string, unknown>).autoContinueDelay as number) ?? 30,
          startedAt: Date.now(),
          promptLength: prompt.length,
          outputLength: 0,
          model: `${subModel.provider}/${subModel.id}`,
          tier: tier ?? (task as Record<string, unknown>).tier as string | undefined,
          thinkingLevel: thinkingLevel,
          inputTokens: estimateTokens(prompt),
          outputTokens: 0,
          cacheTokens: 0,
          cost: 0,
          contextPercent: null,
          contextWindow: 0,
          _abortExternally: () => { abortedExternally = true; },
          _resetTimer: () => {},
        };
        registerInstance(instRef);

        // ---- 输出收集 ----
        let output = "";

        // ---- 空闲检测 + 自动续推 ----
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;

        const clearIdle = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; }
        };

        const startIdleDetection = () => {
          clearIdle();
          if (instRef.detailedStatus === "done") return;
          idleTimer = setTimeout(() => {
            updateInstanceStatus(jobId, task.id, { detailedStatus: "idle" });
            instRef._idleTimer = idleTimer;
            if (instRef.autoContinue && !instRef._settled) {
              autoContinueTimer = setTimeout(() => {
                if (!instRef._settled) {
                  try { session.steer("继续执行未完成的任务。"); } catch { /* ignore */ }
                }
              }, instRef.autoContinueDelay * 1000);
            }
          }, 5000);
          instRef._idleTimer = idleTimer;
        };

        const resetTimer = () => {
          if (timerRef) clearTimeout(timerRef);
          timerRef = setTimeout(() => {
            finish({
              id: task.id,
              name,
              order,
              ok: false,
              error: "timeout",
              output: output.trim() || undefined,
            });
          }, deadline);
        };

        instRef._resetTimer = resetTimer;
        instRef._dispose = async () => { await finish({ id: task.id, name, order, ok: false, error: "disposed" }); };
        resetTimer();

        unsubRef = session.subscribe(async (event) => {
          // ---- 泄露自检 ----
          if (event.type === "turn_start" || event.type === "tool_execution_start") {
            if (!getInstance(jobId, task.id)) {
              console.warn(`[parallel-agent] ${task.id} 泄露检测: bus 注册已丢失，强制自毁`);
              try { session.abort(); } catch { /* */ }
              try { session.dispose(); } catch { /* */ }
              return;
            }
          }
          // ---- text delta → thinking ----
          if (event.type === "message_update") {
            if (event.assistantMessageEvent.type === "text_delta") {
              output += event.assistantMessageEvent.delta;
              instRef.outputLength = output.length;
              instRef.outputTokens += estimateTokens(event.assistantMessageEvent.delta);
              // 输出截断策略：保留头和尾，丢弃中间
          // 避免大输出（代码审查、文件分析）丢尾导致关键结论丢失
          const MAX_OUTPUT_CHARS = 10_000;
          const TAIL_RESERVE = 2_000;
          if (output.length > MAX_OUTPUT_CHARS) {
            const head = output.slice(0, MAX_OUTPUT_CHARS - TAIL_RESERVE);
            const tail = output.slice(-TAIL_RESERVE);
            output = head + "\n\n... [中间截断 " + (output.length - MAX_OUTPUT_CHARS + TAIL_RESERVE) + " 字符] ...\n\n" + tail;
          }
              updateInstanceStatus(jobId, task.id, {
                detailedStatus: "thinking",
                outputLength: instRef.outputLength,
                outputTokens: instRef.outputTokens,
              });
            }
          }
          // ---- tool start → tool_calling ----
          if (event.type === "tool_execution_start") {
            clearIdle();
            updateInstanceStatus(jobId, task.id, {
              detailedStatus: "tool_calling",
              currentTool: event.toolName,
              logTool: { toolName: event.toolName, status: "started" },
            });
          }
          // ---- tool end → thinking ----
          if (event.type === "tool_execution_end") {
            updateInstanceStatus(jobId, task.id, {
              detailedStatus: "thinking",
              logTool: {
                toolName: event.toolName,
                status: event.isError ? "error" : "done",
                error: event.isError ? String(event.result).slice(0, 200) : undefined,
              },
            });
          }
          // ---- turn start → running ----
          if (event.type === "turn_start") {
            clearIdle();
            updateInstanceStatus(jobId, task.id, { detailedStatus: "running" });
          }
          // ---- turn end → idle detection ----
          if (event.type === "turn_end") {
            updateInstanceStatus(jobId, task.id, { detailedStatus: "thinking" });
            startIdleDetection();
          }
          // ---- message end → token 统计 ----
          if (event.type === "message_end") {
            try {
              const stats = session.getSessionStats();
              const cu = session.getContextUsage();
              updateInstanceStatus(jobId, task.id, {
                inputTokens: stats.tokens.input || instRef.inputTokens,
                outputTokens: stats.tokens.output || instRef.outputTokens,
                cacheTokens: (stats.tokens.cacheRead || 0) + (stats.tokens.cacheWrite || 0),
                cost: stats.cost,
                contextPercent: cu?.percent ?? null,
                contextWindow: cu?.contextWindow ?? 0,
              });
            } catch { /* */ }
          }
          // ---- agent end → done ----
          if (event.type === "agent_end") {
            clearIdle();
            updateInstanceStatus(jobId, task.id, { detailedStatus: "done" });
            try {
              instRef._savedMessages = session.state.messages;
              saveAgentState(jobId, task.id);
            } catch { /* */ }
            try {
              const stats = session.getSessionStats();
              const cu = session.getContextUsage();
              updateInstanceStatus(jobId, task.id, {
                inputTokens: stats.tokens.input || instRef.inputTokens,
                outputTokens: stats.tokens.output || instRef.outputTokens,
                cacheTokens: (stats.tokens.cacheRead || 0) + (stats.tokens.cacheWrite || 0),
                cost: stats.cost,
                contextPercent: cu?.percent ?? null,
                contextWindow: cu?.contextWindow ?? 0,
              });
            } catch { /* */ }
            if (abortedExternally) {
              abortedExternally = false;
              return;
            }
            await finish({
              id: task.id,
              name,
              order,
              ok: true,
              output: output.trim() || "(无输出)",
              tokens: {
                input: instRef.inputTokens,
                output: instRef.outputTokens,
                cache: instRef.cacheTokens,
                cost: instRef.cost,
                contextPercent: instRef.contextPercent,
                contextWindow: instRef.contextWindow,
              },
            });
          }
        });

        // 启动子 Agent
        await session.prompt(prompt);
      } catch (err: unknown) {
        await finish({
          id: task.id,
          name,
          order,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
}
