/**
 * agent-bus.ts — 多 Agent 通信总线 + 生命周期管理
 *
 * 基于全局 EventEmitter 单例，实现：
 *   1. 主 Agent 派发任务 → 子 Agent 后台执行
 *   2. 子 Agent 完成后 → 通过总线回传结果
 *   3. 主 Agent 轮询/等待结果
 *   4. Agent 间消息传递
 *   5. 子 Agent 完整生命周期控制（kill/abort/send/pause/resume）
 *
 * 存储在 globalThis.__pi_agent_bus，跨 session 可见。
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---- 全局单例 ----

const globalBus: EventEmitter =
  ((globalThis as Record<string, unknown>).__pi_agent_bus as EventEmitter) ||
  (() => {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    (globalThis as Record<string, unknown>).__pi_agent_bus = bus;
    return bus;
  })();

/** 跨 reload 共享状态（globalThis 承载，不随模块重载丢失） */
interface AgentBusState {
  jobs: Map<string, AgentJob>;
  instances: Map<string, AgentInstance>;
  frontendQueue: FrontendMsg[];
  frontendProcessors: Map<string, (data: unknown) => Promise<unknown>>;
  frontendProcessing: boolean;
}

const state: AgentBusState =
  ((globalThis as Record<string, unknown>).__pi_agent_state as AgentBusState) ||
  (() => {
    const s: AgentBusState = {
      jobs: new Map(),
      instances: new Map(),
      frontendQueue: [],
      frontendProcessors: new Map(),
      frontendProcessing: false,
    };
    (globalThis as Record<string, unknown>).__pi_agent_state = s;
    return s;
  })();

// ---- types ----

export interface SubTask {
  id: string;
  prompt: string;
  context?: string[];
  skills?: string[];
  mode?: "plan" | "work" | "yolo";
  model?: string;
}

export interface SubResult {
  id: string;
  name: string;
  order: number;
  ok: boolean;
  output?: string;
  error?: string;
  /** 原生 token 统计（agent_end 时填充） */
  tokens?: {
    input: number;
    output: number;
    cache: number;
    cost: number;
    contextPercent: number | null;
    contextWindow: number;
  };
}

export interface AgentJob {
  jobId: string;
  tasks: SubTask[];
  total: number;
  completed: number;
  results: SubResult[];
  status: "dispatched" | "running" | "complete" | "error" | "killed";
  createdAt: number;
  finishedAt?: number;
  /** 是否已通过 autoInject 或 check_agent_results 推送过结果，防止重复 */
  _autoInjected?: boolean;
}

/** 子 Agent 精细行为状态 */
export type SubAgentStatus =
  | "thinking"       // LLM 正在生成文本（message_update text_delta）
  | "tool_calling"   // 正在执行工具调用
  | "idle"           // turn 结束，等待 LLM 下一轮决策（可能因缺少输入而停滞）
  | "running"        // 通用活跃状态
  | "paused"         // 手动暂停
  | "done";          // agent_end，任务完成

/** 工具调用记录 */
export interface ToolCallRecord {
  toolName: string;
  status: "started" | "done" | "error";
  timestamp: number;
  /** 工具执行耗时（ms），仅 done/error 时有值 */
  duration?: number;
  /** 错误信息，仅 error 时有值 */
  error?: string;
}

/** 运行中的子 Agent 实例 */
export interface AgentInstance {
  jobId: string;
  taskId: string;
  name: string;
  session: AgentSession;
  /** 传统状态（兼容旧代码、控制动作） */
  status: "running" | "paused" | "waiting_input";
  /** 精细行为状态（新增，供面板和查询用） */
  detailedStatus: SubAgentStatus;
  /** 当前正在调用的工具名（tool_calling 时有值） */
  currentTool?: string;
  /** 工具调用历史（最近 N 条，最新在末尾） */
  toolHistory: ToolCallRecord[];
  /** 最后一次活动时间戳 */
  lastActivityAt: number;
  /** 是否启用自动续推（idle 后自动 steer） */
  autoContinue: boolean;
  /** 自动续推延迟秒（默认 30，idle 后等 N 秒再续推） */
  autoContinueDelay: number;
  startedAt: number;
  /** 输入提示词长度（字符数） */
  promptLength: number;
  /** 当前已输出字符数（实时更新） */
  outputLength: number;
  /** 子 Agent 使用的模型标识 */
  model?: string;
  /** 累计输入 token 数 */
  inputTokens: number;
  /** 累计输出 token 数 */
  outputTokens: number;
  /** 缓存 token（cacheRead + cacheWrite，agent_end 时提取） */
  cacheTokens: number;
  /** 费用（美元，agent_end 时提取） */
  cost: number;
  /** 上下文占用百分比（agent_end 时快照） */
  contextPercent: number | null;
  /** 上下文窗口上限 */
  contextWindow: number;
  /** 内部：标记外部触发的 abort，阻止 agent_end 自动 finish */
  _abortExternally?: () => void;
  /** 内部：重置超时计时器 */
  _resetTimer?: () => void;
  /** 内部：空闲检测定时器 */
  _idleTimer?: ReturnType<typeof setTimeout>;
  /** 内部：agent_end 时捕获的消息快照（session dispose 后仍可用） */
  _savedMessages?: AgentMessage[];
  /** 内部：是否已完成（防重复终止） */
  _settled?: boolean;
  /** 内部：统一清理函数（abort + dispose + unregister） */
  _dispose?: () => Promise<void>;
}

export interface AgentMessage {
  msgId: string;
  from: string;
  to: string;
  type: "info" | "request" | "response" | "error";
  payload: string;
  timestamp: number;
}

// ---- 事件常量 ----

export const Events = {
  TASK_RESULT: "task:result",
  JOB_COMPLETE: "job:complete",
  JOB_ERROR: "job:error",
  AGENT_MESSAGE: "agent:message",
  INSTANCE_REGISTERED: "instance:registered",
  INSTANCE_UNREGISTERED: "instance:unregistered",
  AGENT_PAUSED: "agent:paused",
  AGENT_RESUMED: "agent:resumed",
  STATUS_CHANGED: "instance:status_changed",
} as const;

// ---- 存储（通过 globalThis 跨 reload 共享） ----

/** 获取全局 EventEmitter（供外部监听） */
export function getAgentBus(): EventEmitter {
  return globalBus;
}

// ---- 存档 ----

export interface AgentSaveState {
  saveId: string;
  taskId: string;
  name: string;
  model: string;
  messages: AgentMessage[];
  savedAt: number;
}

function saveDir(): string {
  const dir = join(process.env.USERPROFILE ?? ".", ".pi", "agent", "sub-agent-saves");
  try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return dir;
}

export function saveAgentState(jobId: string, taskId: string): AgentSaveState | null {
  const inst = getInstance(jobId, taskId);
  if (!inst) return null;

  // 优先使用 session 实时消息，session dispose 后用快照
  let messages: AgentMessage[];
  try {
    messages = inst.session.state.messages;
  } catch {
    messages = inst._savedMessages ?? [];
  }

  const state: AgentSaveState = {
    saveId: taskId,
    taskId,
    name: inst.name,
    model: inst.model ?? "?",
    messages,
    savedAt: Date.now(),
  };

  const dir = saveDir();
  try {
    writeFileSync(join(dir, `${taskId}.json`), JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    // 消息可能含不可序列化内容（ImageContent 等），尝试清理后重试
    try {
      const cleaned = {
        ...state,
        messages: messages.map((m) => {
          const content = typeof m.content === "string" ? m.content : "(binary content)";
          return { ...m, content: content.slice(0, 5000) };
        }),
      };
      writeFileSync(join(dir, `${taskId}.json`), JSON.stringify(cleaned, null, 2), "utf-8");
    } catch {
      console.warn("[agent-bus] 存档失败:", String(e));
      return null;
    }
  }
  return state;
}

export function loadAgentState(saveId: string): AgentSaveState | null {
  try {
    const dir = saveDir();
    const raw = readFileSync(join(dir, `${saveId}.json`), "utf-8");
    return JSON.parse(raw) as AgentSaveState;
  } catch {
    return null;
  }
}

export function deleteAgentSave(saveId: string): boolean {
  try {
    const dir = saveDir();
    unlinkSync(join(dir, `${saveId}.json`));
    return true;
  } catch {
    return false;
  }
}

export function listAgentSaves(): AgentSaveState[] {
  try {
    const dir = saveDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf-8")) as AgentSaveState;
        } catch {
          return null;
        }
      })
      .filter((s): s is AgentSaveState => s !== null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

// ---- Job API ----

export function createJob(tasks: SubTask[]): AgentJob {
  const jobId = randomUUID();
  const job: AgentJob = {
    jobId,
    tasks,
    total: tasks.length,
    completed: 0,
    results: [],
    status: "dispatched",
    createdAt: Date.now(),
  };
  state.jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): AgentJob | undefined {
  return state.jobs.get(jobId);
}

export function listJobs(): AgentJob[] {
  return Array.from(state.jobs.values());
}

export function publishTaskResult(jobId: string, result: SubResult): void {
  const job = state.jobs.get(jobId);
  if (!job) return;

  job.results.push(result);
  job.completed++;

  globalBus.emit(Events.TASK_RESULT, {
    jobId,
    result,
    progress: `${job.completed}/${job.total}`,
  });

  if (job.completed >= job.total) {
    job.status = "complete";
    job.finishedAt = Date.now();
    globalBus.emit(Events.JOB_COMPLETE, { jobId, job });
  }
}

export function publishJobError(jobId: string, error: string): void {
  const job = state.jobs.get(jobId);
  if (!job) return;
  job.status = "error";
  job.finishedAt = Date.now();
  globalBus.emit(Events.JOB_ERROR, { jobId, error });
}

// ---- Instance API（生命周期管理） ----

function instanceKey(jobId: string, taskId: string): string {
  return `${jobId}:${taskId}`;
}

export function registerInstance(inst: AgentInstance): void {
  const key = instanceKey(inst.jobId, inst.taskId);
  state.instances.set(key, inst);
  globalBus.emit(Events.INSTANCE_REGISTERED, { jobId: inst.jobId, taskId: inst.taskId, name: inst.name });
}

export function unregisterInstance(jobId: string, taskId: string): void {
  const key = instanceKey(jobId, taskId);
  const inst = state.instances.get(key);
  if (inst?._idleTimer) clearTimeout(inst._idleTimer);
  state.instances.delete(key);
  if (inst) {
    globalBus.emit(Events.INSTANCE_UNREGISTERED, { jobId, taskId, name: inst.name });
  }
}

export function getInstance(jobId: string, taskId: string): AgentInstance | undefined {
  return state.instances.get(instanceKey(jobId, taskId));
}

export function getJobInstances(jobId: string): AgentInstance[] {
  const prefix = `${jobId}:`;
  return Array.from(state.instances.entries())
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

/** 列出所有 Agent 实例 */
export function listInstances(): AgentInstance[] {
  return Array.from(state.instances.values());
}

/**
 * 更新实例精细状态并触发 STATUS_CHANGED 事件。
 * 由 parallel-agent.ts 的 session 事件订阅调用。
 */
export function updateInstanceStatus(
  jobId: string,
  taskId: string,
  update: {
    detailedStatus?: SubAgentStatus;
    currentTool?: string;
    logTool?: { toolName: string; status: "started" | "done" | "error"; duration?: number; error?: string };
    outputLength?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    cost?: number;
    contextPercent?: number | null;
    contextWindow?: number;
  },
): void {
  const key = instanceKey(jobId, taskId);
  const inst = state.instances.get(key);
  if (!inst) return;

  if (update.detailedStatus !== undefined) {
    inst.detailedStatus = update.detailedStatus;
  }
  if (update.currentTool !== undefined) {
    inst.currentTool = update.currentTool || undefined;
  }
  if (update.logTool) {
    inst.toolHistory.push({
      toolName: update.logTool.toolName,
      status: update.logTool.status,
      timestamp: Date.now(),
      duration: update.logTool.duration,
      error: update.logTool.error,
    });
    if (inst.toolHistory.length > 20) {
      inst.toolHistory = inst.toolHistory.slice(-10);
    }
  }
  if (update.outputLength !== undefined) {
    inst.outputLength = update.outputLength;
  }
  if (update.inputTokens !== undefined) {
    inst.inputTokens = update.inputTokens;
  }
  if (update.outputTokens !== undefined) {
    inst.outputTokens = update.outputTokens;
  }
  if (update.cacheTokens !== undefined) {
    inst.cacheTokens = update.cacheTokens;
  }
  if (update.cost !== undefined) {
    inst.cost = update.cost;
  }
  if (update.contextPercent !== undefined) {
    inst.contextPercent = update.contextPercent;
  }
  if (update.contextWindow !== undefined) {
    inst.contextWindow = update.contextWindow;
  }
  inst.lastActivityAt = Date.now();

  globalBus.emit(Events.STATUS_CHANGED, {
    jobId,
    taskId,
    detailedStatus: inst.detailedStatus,
    currentTool: inst.currentTool,
    toolHistory: inst.toolHistory,
  });
}

// ---- Agent 控制操作 ----

/** 杀死子 Agent（统一走 _dispose 生命周期清理，兜底处理旧版 buggy _dispose） */
export async function killAgent(jobId: string, taskId: string): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;

  // 尝试新版 _dispose（内部调用 finish → unregisterInstance）
  if (inst._dispose) {
    try { await inst._dispose(); } catch { /* */ }
  }

  // 兜底：如果 _dispose 没有清理掉实例（旧版 bug），手动清理
  if (getInstance(jobId, taskId)) {
    try { await inst.session.abort(); } catch { /* */ }
    try { inst.session.dispose(); } catch { /* */ }
    unregisterInstance(jobId, taskId);
    publishTaskResult(jobId, {
      id: taskId,
      name: inst.name,
      order: 0,
      ok: false,
      error: "killed by main agent",
    });
  }
  return true;
}

/** 杀死整个 Job 的所有子 Agent */
export async function killJob(jobId: string): Promise<number> {
  const insts = getJobInstances(jobId);
  let count = 0;
  for (const inst of insts) {
    if (await killAgent(jobId, inst.taskId)) count++;
  }
  // 标记 job 为 killed
  const job = state.jobs.get(jobId);
  if (job) {
    job.status = "killed";
    job.finishedAt = Date.now();
  }
  return count;
}

/** 中断子 Agent（abort 但不 dispose，不 finish，可恢复） */
export async function abortAgent(jobId: string, taskId: string): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;

  try {
    inst._abortExternally?.();
    await inst.session.abort();
    return true;
  } catch (e) {
    console.warn("[agent-bus] abortAgent 失败:", e);
    return false;
  }
}

/** 暂停子 Agent（abort 但不 dispose，不 finish，可恢复） */
export async function pauseAgent(jobId: string, taskId: string): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;

  try {
    inst._abortExternally?.();
    await inst.session.abort();
  } catch (e) { console.warn("[agent-bus] pauseAgent abort 失败:", e); }

  inst.status = "paused";
  globalBus.emit(Events.AGENT_PAUSED, { jobId, taskId, name: inst.name });
  return true;
}

/** 恢复子 Agent（重新发送提示） */
export async function resumeAgent(jobId: string, taskId: string, resumeText?: string): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;
  if (inst.status !== "paused") return false;

  try {
    inst._resetTimer?.();
    const msg = resumeText || "继续执行之前的任务。";
    await inst.session.sendUserMessage(msg);
    inst.status = "running";
    globalBus.emit(Events.AGENT_RESUMED, { jobId, taskId, name: inst.name });
    return true;
  } catch {
    return false;
  }
}

/** 向运行中的子 Agent 注入消息 */
export async function sendAgentInput(
  jobId: string,
  taskId: string,
  text: string,
): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;

  try {
    inst._resetTimer?.();
    // steer: 中断后注入，下次 LLM 调用前处理
    await inst.session.steer(text);
    return true;
  } catch {
    return false;
  }
}

// ---- 消息传递 ----

export function sendMessage(
  from: string,
  to: string,
  type: AgentMessage["type"],
  payload: string,
): string {
  const msgId = randomUUID();
  const msg: AgentMessage = { msgId, from, to, type, payload, timestamp: Date.now() };
  globalBus.emit(Events.AGENT_MESSAGE, msg);
  return msgId;
}

export function onMessage(
  target: string,
  handler: (msg: AgentMessage) => void,
): () => void {
  const wrapper = (msg: AgentMessage) => {
    if (msg.to === target || msg.to === "broadcast") {
      handler(msg);
    }
  };
  globalBus.on(Events.AGENT_MESSAGE, wrapper);
  return () => globalBus.off(Events.AGENT_MESSAGE, wrapper);
}

// ---- 异步完成回调（不阻塞，用于 push 注入） ----

/**
 * 注册 job 完成回调。当 job 完成或出错时触发。
 * 如果 job 已完成则立即异步回调。
 * 返回取消注册函数。
 */
export function onJobComplete(
  jobId: string,
  callback: (job: AgentJob) => void,
): () => void {
  const existing = state.jobs.get(jobId);
  if (
    existing &&
    (existing.status === "complete" ||
      existing.status === "error" ||
      existing.status === "killed")
  ) {
    setImmediate(() => callback(existing));
    return () => {};
  }

  const handler = (data: { jobId: string; job: AgentJob }) => {
    if (data.jobId !== jobId) return;
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
    const job = state.jobs.get(jobId);
    if (job) callback(job);
  };

  const errorHandler = (data: { jobId: string }) => {
    if (data.jobId !== jobId) return;
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
    const job = state.jobs.get(jobId);
    if (job) callback(job);
  };

  globalBus.on(Events.JOB_COMPLETE, handler);
  globalBus.on(Events.JOB_ERROR, errorHandler);
  return () => {
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
  };
}

// ---- 等待（阻塞式，仅用于 check_agent_results 兼容） ----

export function waitForJob(jobId: string, timeoutMs: number = 300_000, signal?: AbortSignal): Promise<AgentJob> {
  const job = state.jobs.get(jobId);
  if (job && (job.status === "complete" || job.status === "error" || job.status === "killed")) {
    return Promise.resolve(job);
  }

  return new Promise((resolve) => {
    // AbortSignal 支持
    if (signal?.aborted) {
      const j = state.jobs.get(jobId);
      resolve(j ?? { jobId, tasks: [], total: 0, completed: 0, results: [], status: "error", createdAt: 0, finishedAt: Date.now() });
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      const j = state.jobs.get(jobId);
      resolve(j ?? { jobId, tasks: [], total: 0, completed: 0, results: [], status: "error", createdAt: 0, finishedAt: Date.now() });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      const j = state.jobs.get(jobId);
      resolve(
        j ?? {
          jobId,
          tasks: [],
          total: 0,
          completed: 0,
          results: [],
          status: "error",
          createdAt: 0,
          finishedAt: Date.now(),
        },
      );
    }, timeoutMs);

    const onComplete = (data: { jobId: string }) => {
      if (data.jobId !== jobId) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      resolve(state.jobs.get(jobId)!);
    };

    const onError = (data: { jobId: string }) => {
      if (data.jobId !== jobId) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      resolve(state.jobs.get(jobId)!);
    };

    globalBus.once(Events.JOB_COMPLETE, onComplete);
    globalBus.once(Events.JOB_ERROR, onError);
  });
}

// ---- 清理 ----

export function cleanupJobs(maxAge: number = 600_000): void {
  const now = Date.now();
  for (const [id, job] of state.jobs) {
    if (
      (job.status === "complete" || job.status === "error" || job.status === "killed") &&
      job.finishedAt &&
      now - job.finishedAt > maxAge
    ) {
      state.jobs.delete(id);
    }
  }
  // 清理僵尸实例（关联 job 已不存在的）
  for (const [key, inst] of state.instances) {
    if (!state.jobs.has(inst.jobId)) {
      try { inst.session.dispose(); } catch (e) { console.warn("[agent-bus] cleanupJobs dispose 失败:", e); }
      state.instances.delete(key);
    }
  }
}

// ============================================================================
// FrontendQueue — 统一前端消息队列（游标式串行处理）
// ============================================================================

interface FrontendMsg {
  id: string;
  type: "confirm" | "steer";
  priority: number; // 越小越优先
  data: unknown;
  status: "pending" | "processing" | "done" | "timeout";
  createdAt: number;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const FRONTEND_MAX_QUEUE = 20;

// state.frontendQueue, state.frontendProcessors, state.frontendProcessing 已在顶部 state 对象中

/** 注册消息处理器（confirm / steer 各注册一次） */
export function registerFrontendProcessor(
  type: string,
  processor: (data: unknown) => Promise<unknown>,
): void {
  state.frontendProcessors.set(type, processor);
}

/** 入队：返回 Promise，溢出/超时时 reject */
export function enqueueFrontend(
  type: "confirm" | "steer",
  priority: number,
  data: unknown,
  timeoutMs: number = 60_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // 容量检查：快速失败
    if (state.frontendQueue.length >= FRONTEND_MAX_QUEUE) {
      reject(new Error(`FrontendQueue overflow (${FRONTEND_MAX_QUEUE} max)`));
      return;
    }

    const msg: FrontendMsg = {
      id: randomUUID(),
      type,
      priority,
      data,
      status: "pending",
      createdAt: Date.now(),
      timeoutMs,
      resolve,
      reject,
    };

    // 超时定时器
    msg.timer = setTimeout(() => {
      if (msg.status === "pending") {
        msg.status = "timeout";
        reject(new Error(`FrontendQueue timeout (${timeoutMs}ms)`));
        // 从队列移除
        const idx = state.frontendQueue.findIndex((m) => m.id === msg.id);
        if (idx !== -1) state.frontendQueue.splice(idx, 1);
      }
    }, timeoutMs);

    state.frontendQueue.push(msg);
    // 按优先级排序（越小越前）
    state.frontendQueue.sort((a, b) => a.priority - b.priority);

    // 事件驱动：尝试推进（不在处理中则立即开始）
    processFrontendNext();
  });
}

/** 完成当前消息，游标推进 */
function completeFrontendMsg(msgId: string, result?: unknown): void {
  const idx = state.frontendQueue.findIndex((m) => m.id === msgId);
  if (idx === -1) return;
  const msg = state.frontendQueue[idx];
  if (msg.timer) clearTimeout(msg.timer);
  state.frontendQueue.splice(idx, 1);
  state.frontendProcessing = false;
  msg.resolve(result);
  processFrontendNext();
}

/** 处理下一个 pending 消息 */
function processFrontendNext(): void {
  if (state.frontendProcessing) return;
  const next = state.frontendQueue.find((m) => m.status === "pending");
  if (!next) return;

  const processor = state.frontendProcessors.get(next.type);
  if (!processor) {
    // 无处理器 → 跳过
    completeFrontendMsg(next.id);
    return;
  }

  state.frontendProcessing = true;
  next.status = "processing";

  processor(next.data)
    .then((result) => completeFrontendMsg(next.id, result))
    .catch((err) => {
      // 处理器失败也继续推进
      if (next.timer) clearTimeout(next.timer);
      state.frontendQueue.splice(state.frontendQueue.indexOf(next), 1);
      state.frontendProcessing = false;
      next.reject(err);
      processFrontendNext();
    });
}
