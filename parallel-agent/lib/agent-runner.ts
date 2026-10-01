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
  isTaskCancelled,
  saveAgentState,
  appendAgentTaskOutput,
  replaceAgentTaskOutput,
  updateInstanceStatus,
  updateAgentTaskPanel,
  projectTerminalResultToPanel,
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
import {
  bindSessionExecutionContext,
  ensureSessionRuntime,
} from "../../lib/execution-context.js";
import {
  classifyTerminal,
  extractFinalAssistantText,
  readFinalAssistantSignal,
} from "./result-classifier.js";
import { runBoundedCleanup } from "./cleanup.js";

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

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return totalSeconds === 0 ? `${ms}毫秒` : `${totalSeconds}秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}分钟` : `${minutes}分${seconds}秒`;
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
      let warningTimer: ReturnType<typeof setTimeout> | null = null;
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
      // G04：文本 delta 有界批量刷盘，避免每个 delta 都同步落盘。
      const OUTPUT_FLUSH_THRESHOLD = 4_096;
      const OUTPUT_FLUSH_INTERVAL_MS = 250;
      let outputFlushBuffer = "";
      let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
      // 先声明为空实现：finish 可能在初始化完成前触发，不能命中 TDZ。
      let flushOutputLog: (force?: boolean) => void = () => undefined;
      // C01/C02：活跃执行预算（不含暂停时间）与清理时间边界。
      const CLEANUP_TIMEOUT_MS = 5_000;
      // C01：初始化超时与活跃执行预算分离；timeout 只表示活跃预算。
      const INIT_TIMEOUT_MS = Math.min(deadline, 120_000);
      let activeElapsedMs = 0;
      let activeStartedAt = 0;

      const clearTimers = () => {
        if (timerRef) {
          clearTimeout(timerRef);
          timerRef = null;
        }
        if (warningTimer) {
          clearTimeout(warningTimer);
          warningTimer = null;
        }
        if (instRef) {
          instRef._warningTimer = null;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (autoContinueTimer) {
          clearTimeout(autoContinueTimer);
          autoContinueTimer = null;
        }
        if (outputFlushTimer) {
          clearTimeout(outputFlushTimer);
          outputFlushTimer = null;
        }
      };

      /**
       * 统一终止边界：先保存可恢复状态，再解除事件订阅，最后 abort/dispose。
       * 任何清理失败都降级为结构化结果，不允许形成未处理拒绝或退出宿主进程。
       */
      const finish = async (result: SubResult) => {
        if (settled) return;
        settled = true;
        // G04：结算前强制 flush，避免丢失尚未落盘的输出。
        flushOutputLog(true);
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

        // B05：终态面板投影走统一路径，与 publishTaskResult 完全一致。
        projectTerminalResultToPanel(jobId, result, {
          output: output.trim() || undefined,
          outputLength: totalOutputChars,
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
          // C05/C06：清理有时间边界；超时或拒绝都降级为结构化错误，不挂起结算。
          await runBoundedCleanup(
            "abort",
            () => inst.session.abort(),
            CLEANUP_TIMEOUT_MS,
            (message) => cleanupErrors.push(message),
          );
          await runBoundedCleanup(
            "dispose",
            () => inst.session.dispose(),
            CLEANUP_TIMEOUT_MS,
            (message) => cleanupErrors.push(message),
          );
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

      const resetTimer = (
        windowMs: number = deadline,
        terminalReason = "达到活跃执行预算上限",
      ) => {
        if (timerRef) {
          clearTimeout(timerRef);
          timerRef = null;
        }
        if (warningTimer) {
          clearTimeout(warningTimer);
          warningTimer = null;
        }
        if (instRef) {
          instRef._warningTimer = null;
        }

        activeStartedAt = Date.now();
        const halfDeadline = Math.floor(windowMs / 2);
        if (halfDeadline > 0) {
          warningTimer = setTimeout(() => {
            warningTimer = null;
            if (instRef) instRef._warningTimer = null;
            if (settled) return;
            const targetInst = instRef;
            if (!targetInst || targetInst._settled) return;

            const warnMsg = `[任务超时警告] 当前子任务执行时间已达到超时限制的一半（已运行约 ${formatDuration(halfDeadline)}，剩余时间约 ${formatDuration(windowMs - halfDeadline)}，总超时限制 ${formatDuration(windowMs)}）。请评估当前任务进展，加快核心结论收敛，避免陷入冗长重试或死循环，及时通过 update_agent_task 提交阶段性结论并准备输出最终答案。`;

            try {
              if (targetInst.session && !targetInst._settled) {
                void Promise.resolve(targetInst.session.steer(warnMsg)).catch((error) => {
                  console.warn(`[agent-runner] 子任务 ${task.id} 注入超时警告失败:`, error);
                });
              }
            } catch (error) {
              console.warn(`[agent-runner] 子任务 ${task.id} 触发超时警告异常:`, error);
            }

            try {
              updateAgentTaskPanel(jobId, task.id, {
                note: warnMsg,
                noteSource: "system",
              });
            } catch (error) {
              console.warn(`[agent-runner] 子任务 ${task.id} 更新任务面板警告失败:`, error);
            }
          }, halfDeadline);

          if (instRef) {
            instRef._warningTimer = warningTimer;
          }
        }

        timerRef = setTimeout(() => {
          void finish({
            id: task.id,
            name,
            order,
            ok: false,
            error: "timeout",
            errorCode: "timeout",
            outcome: "timed_out",
            terminalReason,
            lastUsefulConclusion: output.trim() || undefined,
            hasCompletionEvidence: false,
            output: output.trim() || undefined,
          });
        }, Math.max(1, windowMs));
      };

      // C02：暂停冻结活跃预算与所有定时器；恢复按剩余预算重建。
      const pauseTimers = () => {
        if (activeStartedAt > 0) {
          activeElapsedMs += Date.now() - activeStartedAt;
          activeStartedAt = 0;
        }
        // G04：暂停时也强制 flush，避免缓冲输出丢失。
        flushOutputLog(true);
        clearTimers();
      };

      const resumeTimers = () => {
        activeStartedAt = Date.now();
        const remaining = Math.max(1, deadline - activeElapsedMs);
        resetTimer(remaining);
      };

      // 覆盖上下文加载与 session 创建，避免初始化卡死形成永不结算的任务。
      resetTimer(INIT_TIMEOUT_MS, "初始化超时");

      try {
        // 上下文 + skill 注入
        let extra = "";
        if (task.context?.length) extra += await loadContext(task.context, cwd);
        // F01：内联恢复文本与文件路径型 context 分离注入。
        if (task.contextText?.trim()) {
          extra += `\n${task.contextText.trim()}`;
        }
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
          "开始工作时通过 call_capability({capability: 'parallel_agent', operation: 'update_agent_task', arguments: {currentStep: '当前步骤', progress: 0}}) 更新面板。parallel_agent 已为你加载；其他能力先用 load_capability 获取操作 Schema。",
          "每完成一个有意义的阶段、发现可复用结论、遇到阻塞或准备输出最终答案时，主动再次调用 update_agent_task。",
          "每次阶段提交使用 conclusion，说明实际结果、证据、影响或阻塞；结论以能完整说明结果为准，不必刻意压成短摘要。",
          "detail 是可选的详细控制面板，适合写必要的命令、文件、边界或推理；没有有用补充就省略。不要把完整日志或原始输出放进 conclusion/detail。",
          "note 仅用于不属于阶段结论的短暂持久备注；summary 只是兼容旧字段，新调用优先使用 conclusion。",
          `最终回答前必须将状态设为 completed、进度设为 100，并写入不超过 ${FINAL_CONCLUSION_MAX_CHARS} 字的最终 conclusion。结论先写最终结果、完成项、验证证据和阻塞项；detail 按需补充。`,
          `最终回答的前 ${FINAL_ANSWER_LEAD_CHARS} 字也应包含同一结论；详细过程、命令输出和逐行证据放在后面。主 Agent 需要原文时会按需分页读取，不会主动加载完整存档。`,
          "通信与汇报规范：任务完成后系统会自动汇总你的最终回答与面板结论并统一通知主 Agent；严禁调用 send_agent_message 向 main 发送重复的完成汇报。send_agent_message 仅限执行过程中的协作或紧急求助。",
        ].join("\n");
        const prompt = `${basePrompt}\n\n${taskPanelProtocol}`;

        // ---- 串行化 globalThis 写入 ----
        const createSession = async () => {
          if (settled) {
            throw new AgentLifecycleError(
              `${task.id} 在 session 创建前已超时`,
            );
          }
          (globalThis as Record<string, unknown>).__pi_default_phase =
            task.phase || "work";
          (globalThis as Record<string, unknown>).__pi_is_sub_agent = true;
          (globalThis as Record<string, unknown>)
            .__pi_parallel_agent_suppress_widget = true;

          try {
            const sm = SessionManager.inMemory();
            // F01/A10：子会话总是先拥有自己的 guarded runtime，绝不借用父会话
            // 或其他会话的全局状态；仅在显式可继承时才覆盖为父授权快照。
            const childRuntime = ensureSessionRuntime(sm);
            childRuntime.isSubAgent = true;
            // D06：记录父会话身份，子会话发往 main 的消息只归其 owner 消费。
            if (task.parentExecutionContext?.sessionId) {
              childRuntime.parentSessionId = task.parentExecutionContext.sessionId;
            }
            // A08：记录子任务工具上限，能力激活/阶段切换时工具投影必须与其求交。
            if (tools && tools.length > 0) {
              childRuntime.allowedTools = new Set(tools);
            }
            if (task.parentExecutionContext?.approval?.inheritToChildren) {
              bindSessionExecutionContext(sm, task.parentExecutionContext);
            }
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
            delete (globalThis as Record<string, unknown>)
              .__pi_parallel_agent_suppress_widget;
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

        // C04：注册实例前复查取消标记，防止 kill_job 后仍启动。
        if (isTaskCancelled(jobId, task.id)) {
          try { await session.abort(); } catch { /* 取消兜底清理 */ }
          try { await Promise.resolve(session.dispose()); } catch { /* 同上 */ }
          await finish({
            id: task.id,
            name,
            order,
            ok: false,
            error: "cancelled before start",
            errorCode: "cancelled",
            outcome: "cancelled",
            terminalReason: "在注册实例前发现任务已被取消",
            hasCompletionEvidence: false,
          });
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

        // 446 处已一次性确定赋值，此后不再变动。捕获为 const 别名，让下方各嵌套
        // 闭包保持非空收窄——let 的收窄不会透传进嵌套函数体。
        const liveInst: AgentInstance = instRef;

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

        /** 把缓冲的原始输出写入日志；force 时忽略大小阈值。 */
        flushOutputLog = (force = false) => {
          if (!outputFlushBuffer) return;
          if (!force && outputFlushBuffer.length < OUTPUT_FLUSH_THRESHOLD) return;
          const chunk = outputFlushBuffer;
          outputFlushBuffer = "";
          if (outputLogWritable && !appendAgentTaskOutput(jobId, task.id, chunk)) {
            markOutputLogUnavailable();
          }
        };

        const scheduleOutputFlush = () => {
          if (outputFlushTimer) return;
          outputFlushTimer = setTimeout(() => {
            outputFlushTimer = null;
            flushOutputLog(true);
          }, OUTPUT_FLUSH_INTERVAL_MS);
          (outputFlushTimer as unknown as { unref?: () => void }).unref?.();
        };

        const appendOutput = (delta: string, persistRawOutput = true) => {
          if (!delta) return;
          if (persistRawOutput && outputLogWritable) {
            outputFlushBuffer += delta;
            if (outputFlushBuffer.length >= OUTPUT_FLUSH_THRESHOLD) {
              flushOutputLog(true);
            } else {
              scheduleOutputFlush();
            }
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
          outputFlushBuffer = "";
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
          if (liveInst.detailedStatus === "done") return;
          idleTimer = setTimeout(() => {
            updateInstanceStatus(jobId, task.id, { detailedStatus: "idle" });
            liveInst._idleTimer = idleTimer;
            if (liveInst.autoContinue && !liveInst._settled) {
              autoContinueTimer = setTimeout(() => {
                if (!liveInst._settled) {
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
              }, liveInst.autoContinueDelay * 1000);
            }
          }, 5000);
          liveInst._idleTimer = idleTimer;
        };

        liveInst._resetTimer = resetTimer;
        liveInst._pauseTimers = pauseTimers;
        liveInst._resumeTimers = resumeTimers;
        liveInst._dispose = async (reason = "disposed") => {
          const killed = reason === "killed by main agent";
          await finish({
            id: task.id,
            name,
            order,
            ok: false,
            error: reason,
            errorCode: killed ? "killed" : "disposed",
            outcome: killed ? "killed" : "cancelled",
            terminalReason: killed ? "被主 Agent 终止" : "会话被显式销毁",
            lastUsefulConclusion: output.trim() || undefined,
            hasCompletionEvidence: false,
            output: output.trim() || undefined,
          });
        };
        // session 已就绪后按既有语义重新开始任务执行超时计时。
        resetTimer();

        const checkpointOutput = (force = false) => {
          if (force) flushOutputLog(true);
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
              liveInst.outputTokens += estimateTokens(event.assistantMessageEvent.delta);
              liveInst.outputLength = totalOutputChars;
              updateInstanceStatus(jobId, task.id, {
                detailedStatus: "thinking",
                outputLength: liveInst.outputLength,
                outputTokens: liveInst.outputTokens,
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
                inputTokens: stats.tokens.input || liveInst.inputTokens,
                outputTokens: stats.tokens.output || liveInst.outputTokens,
                cacheTokens: (stats.tokens.cacheRead || 0) + (stats.tokens.cacheWrite || 0),
                cost: stats.cost,
                contextPercent: cu?.percent ?? null,
                contextWindow: cu?.contextWindow ?? 0,
              });
            } catch { /* */ }
          }
          // ---- agent end → 集中式终态判定 ----
          if (event.type === "agent_end") {
            // willRetry=true 表示 SDK 还会自动重试，不是终态；等待下一轮。
            if ((event as { willRetry?: boolean }).willRetry) {
              updateInstanceStatus(jobId, task.id, { detailedStatus: "running" });
              return;
            }
            clearIdle();
            updateInstanceStatus(jobId, task.id, { detailedStatus: "done" });
            try {
              liveInst._savedMessages = session.state.messages;
            } catch {
              // finish/saveAgentState 会使用现有快照
            }
            try {
              const stats = session.getSessionStats();
              const cu = session.getContextUsage();
              updateInstanceStatus(jobId, task.id, {
                inputTokens: stats.tokens.input || liveInst.inputTokens,
                outputTokens: stats.tokens.output || liveInst.outputTokens,
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
            // B04：只取最后一条最终回答，不拼接历史中间摘要。
            if (!output.trim()) {
              replaceOutput(
                extractFinalAssistantText(event.messages) ||
                  extractFinalAssistantText(liveInst._savedMessages),
              );
              liveInst.outputLength = totalOutputChars;
            }
            checkpointOutput(true);
            const panelBeforeCompletion = getAgentTaskPanel(jobId, task.id);
            // SDK 终止原因优先取本轮消息，缺失时回退到会话快照。
            const finalSignal = readFinalAssistantSignal(event.messages);
            if (finalSignal.stopReason === undefined) {
              const snapshotSignal = readFinalAssistantSignal(
                liveInst._savedMessages,
              );
              finalSignal.stopReason = snapshotSignal.stopReason;
              finalSignal.errorMessage = snapshotSignal.errorMessage;
            }
            // B01/B02/B03：会话结束不等于任务成功。空结果、模型错误、主动
            // failed/blocked 都不能被判为 ok=true。
            const decision = classifyTerminal({
              control: "none",
              finalAssistant: finalSignal,
              panelStatus: panelBeforeCompletion?.status,
              stageReports: panelBeforeCompletion?.stageReports,
              panelSummary: panelBeforeCompletion?.summary,
              output: output.trim() || undefined,
            });
            // 面板终态投影统一由 finish -> projectTerminalResultToPanel 完成。
            const finalConclusion =
              normalizeFinalConclusion(decision.lastUsefulConclusion) ??
              fallbackFinalConclusion(output);
            const saved = saveAgentState(jobId, task.id, {
              reason: decision.ok ? "completed" : "runtime_error",
              output: output.trim() || undefined,
              instance: liveInst,
            });
            await finish({
              id: task.id,
              name,
              order,
              ok: decision.ok,
              summary: decision.ok ? finalConclusion : undefined,
              lastUsefulConclusion: decision.lastUsefulConclusion,
              outcome: decision.outcome,
              terminalReason: decision.terminalReason,
              hasCompletionEvidence: decision.hasCompletionEvidence,
              error: decision.ok ? undefined : decision.error,
              errorCode: decision.errorCode,
              output: output.trim() || (decision.ok ? "(无输出)" : undefined),
              outputLength: totalOutputChars,
              saveId: saved?.saveId,
              checkpointError: saved ? undefined : "子 Agent 状态自动落盘失败",
              tokens: {
                input: liveInst.inputTokens,
                output: liveInst.outputTokens,
                cache: liveInst.cacheTokens,
                cost: liveInst.cost,
                contextPercent: liveInst.contextPercent,
                contextWindow: liveInst.contextWindow,
              },
            });
          }
          })().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            void finish({
              id: task.id,
              name,
              order,
              ok: false,
              error: message,
              errorCode: "runtime",
              outcome: "failed",
              terminalReason: `运行期异常: ${message}`,
              lastUsefulConclusion: output.trim() || undefined,
              output: output.trim() || undefined,
            });
          });
        });

        // 启动子 Agent
        await session.prompt(prompt);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await finish({
          id: task.id,
          name,
          order,
          ok: false,
          error: message,
          errorCode: "runtime",
          outcome: "failed",
          terminalReason: `初始化异常: ${message}`,
          lastUsefulConclusion: output.trim() || undefined,
          output: output.trim() || undefined,
        });
      }
    })();
  });
}
