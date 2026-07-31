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
  getAgentTaskPanel,
  saveAgentState,
  appendAgentTaskOutput,
  replaceAgentTaskOutput,
  updateInstanceStatus,
  updateAgentTaskPanel,
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
import { setExecutionContext } from "../../lib/execution-context.js";

// ---- Session 创建串行化（防止并发 globalThis 写入） ----
let sessionChain: Promise<void> = Promise.resolve();

class AgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

const OUTPUT_SNAPSHOT_HEAD_CHARS = 48_000;
const OUTPUT_SNAPSHOT_TAIL_CHARS = 15_800;
const FINAL_CONCLUSION_MAX_CHARS = 8_000;
const FINAL_ANSWER_LEAD_CHARS = 8_000;

function normalizeFinalConclusion(conclusion: string | undefined): string | undefined {
  const text = conclusion?.trim();
  if (!text) return undefined;
  return text.length <= FINAL_CONCLUSION_MAX_CHARS
    ? text
    : `${text.slice(0, FINAL_CONCLUSION_MAX_CHARS)}…`;
}

function fallbackFinalConclusion(output: string): string {
  return normalizeFinalConclusion(output) ?? "任务已完成，但未生成文本结论。";
}

export function runSingleAgent(
  task: SubTask,
  order: number,
  jobId: string,
  cwd: string,
  subModel: Model<any>,
  modelRegistry: ModelRegistry,
  deadline: number,
  _pi: ExtensionAPI,
  thinkingLevel?: string,
  tier?: string,
  tools?: string[],
): Promise<SubResult> {
  const name =
    task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id;

  return new Promise((resolve) => {
    void (async () => {
      let unsubRef: (() => void) | undefined;
      let timerRef: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;
      let instRef: AgentInstance | undefined;
      let output = "";
      let outputHead = "";
      let outputTail = "";
      let totalOutputChars = 0;
      let settled = false;
      let abortedExternally = false;
      let lastOutputCheckpointAt = 0;
      let outputLogWritable = true;

      const clearTimers = () => {
        if (timerRef) {
          clearTimeout(timerRef);
          timerRef = null;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (autoContinueTimer) {
          clearTimeout(autoContinueTimer);
          autoContinueTimer = null;
        }
      };

      /**
       * 统一终止边界：先保存可恢复状态，再解除事件订阅，最后 abort/dispose。
       * 任何清理失败都降级为结构化结果，不允许形成未处理拒绝或退出宿主进程。
       */
      const finish = async (result: SubResult) => {
        if (settled) return;
        settled = true;
        const inst = instRef;
        const cleanupErrors: string[] = [];

        if (inst) {
          inst._settled = true;
          try {
            inst._savedMessages = inst.session.state.messages;
          } catch {
            // session 已部分销毁时沿用上一个快照
          }
        }

        clearTimers();

        try {
          unsubRef?.();
        } catch (error) {
          cleanupErrors.push(
            `unsubscribe: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const panelStatus =
          result.ok ? "completed" :
          result.errorCode === "timeout" ? "timed_out" :
          result.errorCode === "killed" ? "killed" :
          "failed";
        const panelBeforeFinish = getAgentTaskPanel(jobId, task.id);
        const panelConclusion = normalizeFinalConclusion(
          panelBeforeFinish?.summary,
        );
        const completionConclusion = normalizeFinalConclusion(result.summary) || (
          result.ok
            ? panelConclusion || fallbackFinalConclusion(result.output ?? output)
            : result.error ?? panelConclusion ?? "任务异常结束"
        );
        const hasTerminalReport = panelBeforeFinish?.stageReports.some(
          (report) => report.status === panelStatus,
        );
        updateAgentTaskPanel(jobId, task.id, {
          status: panelStatus,
          progress: result.ok ? 100 : undefined,
          summary: completionConclusion,
          // 子 Agent 未能在终止前主动提交时，系统仅补一条明确标注的终态结论。
          conclusion: hasTerminalReport ? undefined : completionConclusion,
          reportSource: "system",
          outputSnapshot: (result.output ?? output.trim()) || undefined,
          outputLength: result.outputLength ?? totalOutputChars,
        });

        const shouldCheckpoint =
          result.errorCode === "timeout" || result.errorCode === "runtime";
        if (inst && shouldCheckpoint) {
          const reason =
            result.errorCode === "timeout" ? "timeout" : "runtime_error";
          const saved = saveAgentState(jobId, task.id, {
            reason,
            output: (result.output ?? output.trim()) || undefined,
            instance: inst,
          });
          if (saved) {
            result.saveId = saved.saveId;
            updateAgentTaskPanel(jobId, task.id, { saveId: saved.saveId });
          } else {
            result.checkpointError = "子 Agent 状态自动落盘失败";
          }
        }

        if (inst) {
          try {
            await inst.session.abort();
          } catch (error) {
            cleanupErrors.push(
              `abort: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          try {
            await Promise.resolve(inst.session.dispose());
          } catch (error) {
            cleanupErrors.push(
              `dispose: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        try {
          if (getInstance(jobId, task.id)) {
            unregisterInstance(jobId, task.id);
          }
        } catch (error) {
          cleanupErrors.push(
            `unregister: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (cleanupErrors.length > 0) result.cleanupErrors = cleanupErrors;
        resolve(result);
      };

      const resetTimer = () => {
        if (timerRef) clearTimeout(timerRef);
        timerRef = setTimeout(() => {
          void finish({
            id: task.id,
            name,
            order,
            ok: false,
            error: "timeout",
            errorCode: "timeout",
            output: output.trim() || undefined,
          });
        }, Math.max(1, deadline));
      };

      // 覆盖上下文加载与 session 创建，避免初始化卡死形成永不结算的任务。
      resetTimer();

      try {
        // 上下文 + skill 注入
        let extra = "";
        if (task.context?.length) extra += await loadContext(task.context, cwd);
        if (settled) return;
        if (task.skills?.length) {
          const config = loadSkillConfig();
          for (const s of task.skills) {
            if (config.blacklist.includes(s)) continue;
            extra += await loadSkill(s);
            if (settled) return;
          }
        }
        const basePrompt = extra
          ? `${task.prompt}\n\n[注入上下文]\n${extra}`
          : task.prompt;
        const taskPanelProtocol = [
          "[子 Agent 任务面板协议]",
          "你有一个仅属于当前子任务的持久化任务面板。",
          "开始工作时调用 update_agent_task，写入 currentStep 和初始进度。",
          "每完成一个有意义的阶段、发现可复用结论、遇到阻塞或准备输出最终答案时，主动再次调用 update_agent_task。",
          "每次阶段提交使用 conclusion，说明实际结果、证据、影响或阻塞；结论以能完整说明结果为准，不必刻意压成短摘要。",
          "detail 是可选的详细控制面板，适合写必要的命令、文件、边界或推理；没有有用补充就省略。不要把完整日志或原始输出放进 conclusion/detail。",
          "note 仅用于不属于阶段结论的短暂持久备注；summary 只是兼容旧字段，新调用优先使用 conclusion。",
          `最终回答前必须将状态设为 completed、进度设为 100，并写入不超过 ${FINAL_CONCLUSION_MAX_CHARS} 字的最终 conclusion。结论先写最终结果、完成项、验证证据和阻塞项；detail 按需补充。`,
          `最终回答的前 ${FINAL_ANSWER_LEAD_CHARS} 字也应包含同一结论；详细过程、命令输出和逐行证据放在后面。主 Agent 需要原文时会按需分页读取，不会主动加载完整存档。`,
        ].join("\n");
        const prompt = `${basePrompt}\n\n${taskPanelProtocol}`;

        // ---- 串行化 globalThis 写入 ----
        const createSession = async () => {
          if (settled) {
            throw new AgentLifecycleError(
              `${task.id} 在 session 创建前已超时`,
            );
          }
          if (task.parentExecutionContext?.approval?.inheritToChildren) {
            setExecutionContext(task.parentExecutionContext);
          }

          (globalThis as Record<string, unknown>).__pi_default_phase =
            task.phase || "work";
          (globalThis as Record<string, unknown>).__pi_is_sub_agent = true;

          try {
            const sm = SessionManager.inMemory();
            subAgentIdentity.set(sm, { jobId, taskId: task.id });
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
            delete (globalThis as Record<string, unknown>).__pi_default_phase;
            delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;
          }
        };
        const sessionPromise = sessionChain.then(createSession, createSession);
        // 无论本次创建成功还是失败，队列都恢复为 fulfilled，避免一次异常毒化后续任务。
        sessionChain = sessionPromise.then(
          () => undefined,
          () => undefined,
        );
        const session = await sessionPromise;
        if (settled) {
          try { await session.abort(); } catch { /* 受控超时后的兜底清理 */ }
          try { await Promise.resolve(session.dispose()); } catch { /* 同上 */ }
          return;
        }

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

        const extractAssistantText = (messages: unknown): string => {
          if (!Array.isArray(messages)) return "";
          const parts: string[] = [];
          for (const msg of messages) {
            const m = msg as { role?: string; content?: unknown };
            if (m.role !== "assistant") continue;
            if (typeof m.content === "string" && m.content.trim()) {
              parts.push(m.content);
              continue;
            }
            if (!Array.isArray(m.content)) continue;
            for (const block of m.content) {
              const b = block as { type?: string; text?: unknown };
              if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                parts.push(b.text);
              }
            }
          }
          return parts.join("\n\n").trim();
        };

        const rebuildOutputSnapshot = () => {
          const omitted =
            totalOutputChars - outputHead.length - outputTail.length;
          output = omitted > 0
            ? `${outputHead}\n\n... [中间快照截断 ${omitted} 字符；原文可按需展开] ...\n\n${outputTail}`
            : outputHead + outputTail;
        };

        const markOutputLogUnavailable = () => {
          if (!outputLogWritable) return;
          outputLogWritable = false;
          updateAgentTaskPanel(jobId, task.id, {
            note: "原始输出日志写入失败；展开读取将降级为面板快照。",
            noteSource: "system",
          });
        };

        const appendOutput = (delta: string, persistRawOutput = true) => {
          if (!delta) return;
          if (
            persistRawOutput &&
            outputLogWritable &&
            !appendAgentTaskOutput(jobId, task.id, delta)
          ) {
            markOutputLogUnavailable();
          }
          totalOutputChars += delta.length;

          let remaining = delta;
          if (outputHead.length < OUTPUT_SNAPSHOT_HEAD_CHARS) {
            const take = Math.min(
              OUTPUT_SNAPSHOT_HEAD_CHARS - outputHead.length,
              remaining.length,
            );
            outputHead += remaining.slice(0, take);
            remaining = remaining.slice(take);
          }
          if (remaining) {
            outputTail = (outputTail + remaining).slice(-OUTPUT_SNAPSHOT_TAIL_CHARS);
          }
          rebuildOutputSnapshot();
        };

        const replaceOutput = (value: string) => {
          output = "";
          outputHead = "";
          outputTail = "";
          totalOutputChars = 0;
          if (
            outputLogWritable &&
            !replaceAgentTaskOutput(jobId, task.id, value)
          ) {
            markOutputLogUnavailable();
          }
          appendOutput(value, false);
        };

        // ---- 空闲检测 + 自动续推 ----
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
                  void Promise.resolve(
                    session.steer("继续执行未完成的任务。"),
                  ).catch((error) => {
                    updateAgentTaskPanel(jobId, task.id, {
                      status: "blocked",
                      note: `自动续推失败：${
                        error instanceof Error ? error.message : String(error)
                      }`,
                      noteSource: "system",
                    });
                  });
                }
              }, instRef.autoContinueDelay * 1000);
            }
          }, 5000);
          instRef._idleTimer = idleTimer;
        };

        instRef._resetTimer = resetTimer;
        instRef._dispose = async (reason = "disposed") => {
          const killed = reason === "killed by main agent";
          await finish({
            id: task.id,
            name,
            order,
            ok: false,
            error: reason,
            errorCode: killed ? "killed" : "disposed",
            output: output.trim() || undefined,
          });
        };
        // session 已就绪后按既有语义重新开始任务执行超时计时。
        resetTimer();

        const checkpointOutput = (force = false) => {
          const now = Date.now();
          if (!force && now - lastOutputCheckpointAt < 1_500) return;
          lastOutputCheckpointAt = now;
          updateAgentTaskPanel(jobId, task.id, {
            outputSnapshot: output.trim() || undefined,
            outputLength: totalOutputChars,
          });
        };

        unsubRef = session.subscribe((event) => {
          void (async () => {
            if (settled) return;
          // ---- 泄露自检 ----
          if (event.type === "turn_start" || event.type === "tool_execution_start") {
            if (!getInstance(jobId, task.id)) {
              throw new AgentLifecycleError(
                `${task.id} 的 bus 注册已丢失，已转入受控异常清理`,
              );
            }
          }
          // ---- text delta → thinking ----
          if (event.type === "message_update") {
            if (event.assistantMessageEvent.type === "text_delta") {
              appendOutput(event.assistantMessageEvent.delta);
              instRef.outputTokens += estimateTokens(event.assistantMessageEvent.delta);
              instRef.outputLength = totalOutputChars;
              updateInstanceStatus(jobId, task.id, {
                detailedStatus: "thinking",
                outputLength: instRef.outputLength,
                outputTokens: instRef.outputTokens,
              });
              checkpointOutput();
            }
          }
          // ---- tool start → tool_calling ----
          if (event.type === "tool_execution_start") {
            clearIdle();
            checkpointOutput(true);
            updateInstanceStatus(jobId, task.id, {
              detailedStatus: "tool_calling",
              currentTool: event.toolName,
              logTool: { toolName: event.toolName, status: "started" },
            });
          }
          // ---- tool end → thinking ----
          if (event.type === "tool_execution_end") {
            checkpointOutput(true);
            updateInstanceStatus(jobId, task.id, {
              detailedStatus: "thinking",
              currentTool: "",
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
            checkpointOutput(true);
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
            } catch {
              // finish/saveAgentState 会使用现有快照
            }
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
            if (!output.trim()) {
              replaceOutput(
                extractAssistantText(event.messages) ||
                  extractAssistantText(instRef._savedMessages),
              );
              instRef.outputLength = totalOutputChars;
            }
            checkpointOutput(true);
            const panelBeforeCompletion = getAgentTaskPanel(jobId, task.id);
            const finalConclusion =
              normalizeFinalConclusion(panelBeforeCompletion?.summary) ||
              fallbackFinalConclusion(output);
            const hasCompletedReport = panelBeforeCompletion?.stageReports.some(
              (report) => report.status === "completed",
            );
            updateAgentTaskPanel(jobId, task.id, {
              status: "completed",
              progress: 100,
              currentStep: "任务完成，正在提交最终结果",
              summary: finalConclusion,
              conclusion: hasCompletedReport ? undefined : finalConclusion,
              reportSource: "system",
              outputSnapshot: output.trim() || undefined,
              outputLength: totalOutputChars,
            });
            const saved = saveAgentState(jobId, task.id, {
              reason: "completed",
              output: output.trim() || undefined,
              instance: instRef,
            });
            await finish({
              id: task.id,
              name,
              order,
              ok: true,
              summary: finalConclusion,
              output: output.trim() || "(无输出)",
              outputLength: totalOutputChars,
              saveId: saved?.saveId,
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
          })().catch((error: unknown) => {
            void finish({
              id: task.id,
              name,
              order,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              errorCode: "runtime",
              output: output.trim() || undefined,
            });
          });
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
          errorCode: "runtime",
          output: output.trim() || undefined,
        });
      }
    })();
  });
}
