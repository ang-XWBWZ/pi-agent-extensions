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
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// ---- 全局单例 ----

const globalBus: EventEmitter =
  ((globalThis as Record<string, unknown>).__pi_agent_bus as EventEmitter) ||
  (() => {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    (globalThis as Record<string, unknown>).__pi_agent_bus = bus;
    return bus;
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
  /** 内部：标记外部触发的 abort，阻止 agent_end 自动 finish */
  _abortExternally?: () => void;
  /** 内部：重置超时计时器 */
  _resetTimer?: () => void;
  /** 内部：空闲检测定时器 */
  _idleTimer?: ReturnType<typeof setTimeout>;
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

// ---- 存储 ----

const jobs = new Map<string, AgentJob>();
const instances = new Map<string, AgentInstance>(); // key = `${jobId}:${taskId}`

/** 获取全局 EventEmitter（供外部监听） */
export function getAgentBus(): EventEmitter {
  return globalBus;
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
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): AgentJob | undefined {
  return jobs.get(jobId);
}

export function listJobs(): AgentJob[] {
  return Array.from(jobs.values());
}

export function publishTaskResult(jobId: string, result: SubResult): void {
  const job = jobs.get(jobId);
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
  const job = jobs.get(jobId);
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
  instances.set(key, inst);
  globalBus.emit(Events.INSTANCE_REGISTERED, { jobId: inst.jobId, taskId: inst.taskId, name: inst.name });
}

export function unregisterInstance(jobId: string, taskId: string): void {
  const key = instanceKey(jobId, taskId);
  const inst = instances.get(key);
  if (inst?._idleTimer) clearTimeout(inst._idleTimer);
  instances.delete(key);
  if (inst) {
    globalBus.emit(Events.INSTANCE_UNREGISTERED, { jobId, taskId, name: inst.name });
  }
}

export function getInstance(jobId: string, taskId: string): AgentInstance | undefined {
  return instances.get(instanceKey(jobId, taskId));
}

export function getJobInstances(jobId: string): AgentInstance[] {
  const prefix = `${jobId}:`;
  return Array.from(instances.entries())
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

/** 列出所有 Agent 实例 */
export function listInstances(): AgentInstance[] {
  return Array.from(instances.values());
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
  },
): void {
  const key = instanceKey(jobId, taskId);
  const inst = instances.get(key);
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

/** 杀死子 Agent（abort + dispose + unregister + 标记失败） */
export async function killAgent(jobId: string, taskId: string): Promise<boolean> {
  const inst = getInstance(jobId, taskId);
  if (!inst) return false;

  try {
    await inst.session.abort();
  } catch (e) { console.warn("[agent-bus] killAgent abort 失败:", e); }
  try {
    inst.session.dispose();
  } catch (e) { console.warn("[agent-bus] killAgent dispose 失败:", e); }

  unregisterInstance(jobId, taskId);
  publishTaskResult(jobId, {
    id: taskId,
    name: inst.name,
    order: 0,
    ok: false,
    error: "killed by main agent",
  });
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
  const job = jobs.get(jobId);
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
  const existing = jobs.get(jobId);
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
    const job = jobs.get(jobId);
    if (job) callback(job);
  };

  const errorHandler = (data: { jobId: string }) => {
    if (data.jobId !== jobId) return;
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
    const job = jobs.get(jobId);
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
  const job = jobs.get(jobId);
  if (job && (job.status === "complete" || job.status === "error" || job.status === "killed")) {
    return Promise.resolve(job);
  }

  return new Promise((resolve) => {
    // AbortSignal 支持
    if (signal?.aborted) {
      const j = jobs.get(jobId);
      resolve(j ?? { jobId, tasks: [], total: 0, completed: 0, results: [], status: "error", createdAt: 0, finishedAt: Date.now() });
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      const j = jobs.get(jobId);
      resolve(j ?? { jobId, tasks: [], total: 0, completed: 0, results: [], status: "error", createdAt: 0, finishedAt: Date.now() });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      const j = jobs.get(jobId);
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
      resolve(jobs.get(jobId)!);
    };

    const onError = (data: { jobId: string }) => {
      if (data.jobId !== jobId) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      globalBus.off(Events.JOB_COMPLETE, onComplete);
      globalBus.off(Events.JOB_ERROR, onError);
      resolve(jobs.get(jobId)!);
    };

    globalBus.once(Events.JOB_COMPLETE, onComplete);
    globalBus.once(Events.JOB_ERROR, onError);
  });
}

// ---- 清理 ----

export function cleanupJobs(maxAge: number = 600_000): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (
      (job.status === "complete" || job.status === "error" || job.status === "killed") &&
      job.finishedAt &&
      now - job.finishedAt > maxAge
    ) {
      jobs.delete(id);
    }
  }
  // 清理僵尸实例（关联 job 已不存在的）
  for (const [key, inst] of instances) {
    if (!jobs.has(inst.jobId)) {
      try { inst.session.dispose(); } catch (e) { console.warn("[agent-bus] cleanupJobs dispose 失败:", e); }
      instances.delete(key);
    }
  }
}
