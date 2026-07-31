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
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage as SessionMessage } from "@earendil-works/pi-agent-core";
import type {
  ConversationPhase,
  ExecutionContext,
} from "./workflow-types.js";

// ---- 全局单例 ----

const globalBus: EventEmitter =
  ((globalThis as Record<string, unknown>).__pi_agent_bus as EventEmitter) ||
  (() => {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    (globalThis as Record<string, unknown>).__pi_agent_bus = bus;
    return bus;
  })();

/**
 * EventEmitter 默认会让监听器异常穿透 emit 调用，异步监听器拒绝也会变成
 * unhandledRejection。总线事件逐个隔离，确保一个 UI/扩展监听器故障不会
 * 终止其他子 Agent 或宿主进程。
 */
function emitSafely(eventName: string, payload: unknown): void {
  for (const listener of globalBus.rawListeners(eventName)) {
    try {
      const result = listener.call(globalBus, payload);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch((error) => {
          console.warn(`[agent-bus] ${eventName} 异步监听器失败:`, error);
        });
      }
    } catch (error) {
      console.warn(`[agent-bus] ${eventName} 监听器失败:`, error);
    }
  }
}

/** 跨 reload 共享状态（globalThis 承载，不随模块重载丢失） */
interface AgentBusState {
  jobs: Map<string, AgentJob>;
  instances: Map<string, AgentInstance>;
  taskPanels: Map<string, AgentTaskPanel>;
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
      taskPanels: new Map(),
      frontendQueue: [],
      frontendProcessors: new Map(),
      frontendProcessing: false,
    };
    (globalThis as Record<string, unknown>).__pi_agent_state = s;
    return s;
  })();

// 兼容从旧版扩展 reload 后遗留的 globalThis 状态。
if (!state.taskPanels) state.taskPanels = new Map();

// ---- types ----

export interface SubTask {
  [key: string]: unknown;
  id: string;
  prompt: string;
  context?: string[];
  skills?: string[];
  phase?: ConversationPhase;
  parentExecutionContext?: ExecutionContext;
  provider?: string;
  model?: string;
  tier?: string;
  thinkingLevel?: string;
  resumeFrom?: string;
  notes?: string[];
}

export interface SubResult {
  id: string;
  name: string;
  order: number;
  ok: boolean;
  /** 子 Agent 在最终提交前写入的最终结论，优先于长输出展示。 */
  summary?: string;
  output?: string;
  /** 原始输出的字符数；output 本身可能是受限快照。 */
  outputLength?: number;
  error?: string;
  errorCode?: "timeout" | "runtime" | "killed" | "disposed" | "configuration";
  /** 超时或异常时自动保存的会话存档 ID */
  saveId?: string;
  /** 存档失败时的非致命错误，避免掩盖原始任务错误 */
  checkpointError?: string;
  /** 清理阶段的非致命错误 */
  cleanupErrors?: string[];
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
  /** spawn_agent(autoInject=true) 请求自动注入完整结果 */
  _autoInjectRequested?: boolean;
  /** 自动注入进行中，防止完成事件重入造成重复完整结果 */
  _autoInjecting?: boolean;
  /** 是否已通过 autoInject 自动推送过完整结果，防止重复 */
  _autoInjected?: boolean;
}

export type AgentTaskPanelStatus =
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "completed"
  | "failed"
  | "timed_out"
  | "killed"
  | "interrupted";

export interface AgentTaskNote {
  id: string;
  text: string;
  source: "agent" | "main" | "system";
  createdAt: number;
}

/**
 * 子 Agent 主动提交的一条阶段报告。
 *
 * conclusion 是面板的主视图内容，detail 是按需展开的补充说明；两者都不
 * 用来承载逐行日志或完整原始输出。
 */
export interface AgentTaskStageReport {
  id: string;
  conclusion: string;
  detail?: string;
  status: AgentTaskPanelStatus;
  progress: number;
  currentStep?: string;
  source: AgentTaskNote["source"];
  createdAt: number;
}

/**
 * 每个子 Agent 独立的持久化任务面板。
 *
 * 面板与会话存档分离：面板用于高频、小体积的增量检查点；会话存档用于
 * 超时/完成后的恢复。这样即使进程在一个 LLM 回合中断，最近的步骤、备注
 * 和输出快照仍可从磁盘恢复。
 */
export interface AgentTaskPanel {
  version: 1;
  jobId: string;
  taskId: string;
  name: string;
  objective: string;
  status: AgentTaskPanelStatus;
  progress: number;
  currentStep?: string;
  /** 最近一条阶段结论；保留此字段以兼容旧调用方。 */
  summary?: string;
  /** 按时间追加的阶段结论与可选详细说明。 */
  stageReports: AgentTaskStageReport[];
  notes: AgentTaskNote[];
  outputSnapshot?: string;
  /** 完整原始输出的字符数；面板仅保留 outputSnapshot。 */
  outputLength?: number;
  lastTool?: string;
  saveId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** 最近一次持久化失败；状态仍保留在内存中 */
  persistenceError?: string;
}

export interface AgentTaskPanelUpdate {
  status?: AgentTaskPanelStatus;
  progress?: number;
  currentStep?: string;
  /** 兼容旧调用方的最近阶段结论字段。 */
  summary?: string;
  /** 新阶段报告的结论；写入时同时更新 summary。 */
  conclusion?: string;
  /** 新阶段报告的可选详细说明；必须伴随 conclusion。 */
  detail?: string;
  reportSource?: AgentTaskStageReport["source"];
  outputSnapshot?: string;
  outputLength?: number;
  lastTool?: string;
  saveId?: string;
  note?: string;
  noteSource?: AgentTaskNote["source"];
}

/** 兼容扩展热重载和旧落盘状态中尚未包含 stageReports 的面板。 */
function ensureStageReports(panel: AgentTaskPanel): AgentTaskStageReport[] {
  if (!Array.isArray(panel.stageReports)) panel.stageReports = [];
  return panel.stageReports;
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
  /** 模型层级 (L0/L1/L2) */
  tier?: string;
  /** 思考深度 (off/minimal/low/medium/high/xhigh/max) */
  thinkingLevel?: string;
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
  _savedMessages?: SessionMessage[];
  /** 内部：是否已完成（防重复终止） */
  _settled?: boolean;
  /** 内部：统一清理函数（abort + dispose + unregister） */
  _dispose?: (reason?: string) => Promise<void>;
}

// Agent 间通信消息（区别于 pi-agent-core 的 SessionMessage / LLM 对话消息）
export interface BusAgentMessage {
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
  TASK_PANEL_UPDATED: "task-panel:updated",
} as const;

// ---- 存储（通过 globalThis 跨 reload 共享） ----

/** 获取全局 EventEmitter（供外部监听） */
export function getAgentBus(): EventEmitter {
  return globalBus;
}

// ---- 存档 ----

export interface AgentSaveState {
  version: 2;
  saveId: string;
  jobId: string;
  taskId: string;
  name: string;
  model: string;
  messages: SessionMessage[];
  reason: "manual" | "completed" | "timeout" | "runtime_error" | "killed";
  output?: string;
  taskPanel?: AgentTaskPanel;
  savedAt: number;
}

export interface SaveAgentStateOptions {
  reason?: AgentSaveState["reason"];
  output?: string;
  saveId?: string;
  /** 仅供生命周期边界使用：bus 注册丢失时仍可保存最后一个实例快照 */
  instance?: AgentInstance;
}

export class AgentPersistenceError extends Error {
  readonly operation: string;
  readonly target: string;

  constructor(operation: string, target: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${operation} 失败 (${target}): ${detail}`);
    this.name = "AgentPersistenceError";
    this.operation = operation;
    this.target = target;
  }
}

function agentDataDir(): string {
  const override = process.env.PI_AGENT_DATA_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, ".pi", "agent");
}

function saveDir(): string {
  const dir = join(agentDataDir(), "sub-agent-saves");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function taskPanelDir(): string {
  return join(agentDataDir(), "sub-agent-tasks");
}

function taskOutputDir(): string {
  return join(agentDataDir(), "sub-agent-output");
}

/** 用户可控 ID 绝不直接成为路径片段，避免越界写入和 Windows 非法字符。 */
function safeStorageName(value: string): string {
  const slug = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 48) || "item";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

function savePath(saveId: string): string {
  return join(saveDir(), `${safeStorageName(saveId)}.json`);
}

function panelPath(jobId: string, taskId: string): string {
  const dir = join(taskPanelDir(), safeStorageName(jobId));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safeStorageName(taskId)}.json`);
}

function taskOutputPath(
  jobId: string,
  taskId: string,
  createDirectory = false,
): string {
  const dir = join(taskOutputDir(), safeStorageName(jobId));
  if (createDirectory) mkdirSync(dir, { recursive: true });
  return join(dir, `${safeStorageName(taskId)}.log`);
}

export type AgentTaskOutputSource = "log" | "snapshot" | "none";

export interface AgentTaskOutputInfo {
  source: AgentTaskOutputSource;
  available: boolean;
  byteLength: number;
  characterLength?: number;
}

export interface ReadAgentTaskOutputOptions {
  /** 由上一次读取返回的字节游标；从 0 开始。 */
  cursor?: number;
  /** 单次最多读取的 UTF-8 字节数；范围 256-32,000。 */
  maxBytes?: number;
}

export interface AgentTaskOutputSlice {
  source: AgentTaskOutputSource;
  /** 实际开始读取的位置；输入位于 UTF-8 字符中间时会后移到下一个字符边界。 */
  cursor: number;
  /** 继续读取时使用的字节游标。 */
  nextCursor: number;
  totalBytes: number;
  hasMore: boolean;
  text: string;
}

const DEFAULT_AGENT_TASK_OUTPUT_READ_BYTES = 12_000;
const MAX_AGENT_TASK_OUTPUT_READ_BYTES = 32_000;

function outputReadLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_AGENT_TASK_OUTPUT_READ_BYTES;
  }
  return Math.max(256, Math.min(MAX_AGENT_TASK_OUTPUT_READ_BYTES, Math.floor(value)));
}

function outputCursor(value: number | undefined, totalBytes: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(totalBytes, Math.floor(value)));
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function sliceUtf8Buffer(
  source: AgentTaskOutputSource,
  data: Buffer,
  requestedCursor: number,
  maxBytes: number,
): AgentTaskOutputSlice {
  const totalBytes = data.length;
  let cursor = outputCursor(requestedCursor, totalBytes);
  while (cursor < totalBytes && isUtf8ContinuationByte(data[cursor])) cursor++;

  let end = Math.min(totalBytes, cursor + maxBytes);
  while (end < totalBytes && isUtf8ContinuationByte(data[end])) end--;

  return {
    source,
    cursor,
    nextCursor: end,
    totalBytes,
    hasMore: end < totalBytes,
    text: data.subarray(cursor, end).toString("utf8"),
  };
}

/**
 * 每个任务都有独立的原始输出日志；它不进入面板或自动结果，只有按需读取工具
 * 才会访问。jobId/taskId 始终经 safeStorageName 映射，不能控制真实路径。
 */
export function resetAgentTaskOutput(jobId: string, taskId: string): boolean {
  try {
    writeFileSync(taskOutputPath(jobId, taskId, true), "", "utf8");
    return true;
  } catch (error) {
    console.warn("[agent-bus] 初始化子 Agent 原始输出失败:", error);
    return false;
  }
}

export function appendAgentTaskOutput(
  jobId: string,
  taskId: string,
  text: string,
): boolean {
  if (!text) return true;
  try {
    appendFileSync(taskOutputPath(jobId, taskId, true), text, "utf8");
    return true;
  } catch (error) {
    console.warn("[agent-bus] 追加子 Agent 原始输出失败:", error);
    return false;
  }
}

export function replaceAgentTaskOutput(
  jobId: string,
  taskId: string,
  text: string,
): boolean {
  try {
    writeFileSync(taskOutputPath(jobId, taskId, true), text, "utf8");
    return true;
  } catch (error) {
    console.warn("[agent-bus] 写入子 Agent 原始输出失败:", error);
    return false;
  }
}

export function getAgentTaskOutputInfo(
  jobId: string,
  taskId: string,
): AgentTaskOutputInfo {
  const panel = getAgentTaskPanel(jobId, taskId);
  const logPath = taskOutputPath(jobId, taskId);
  try {
    if (existsSync(logPath)) {
      const byteLength = statSync(logPath).size;
      if (byteLength > 0) {
        return {
          source: "log",
          available: true,
          byteLength,
          characterLength: panel?.outputLength,
        };
      }
    }
  } catch {
    // 原始日志不可读时，继续使用有界面板快照。
  }

  const snapshot = panel?.outputSnapshot;
  if (!snapshot) {
    return { source: "none", available: false, byteLength: 0 };
  }
  return {
    source: "snapshot",
    available: true,
    byteLength: Buffer.byteLength(snapshot, "utf8"),
    characterLength: panel?.outputLength ?? snapshot.length,
  };
}

/**
 * 从原始输出日志中按 UTF-8 字节游标读取一段。日志不存在时才降级读取面板快照，
 * 因而主 Agent 不必为了展开某段结果而先加载完整会话存档。
 */
export function readAgentTaskOutput(
  jobId: string,
  taskId: string,
  options: ReadAgentTaskOutputOptions = {},
): AgentTaskOutputSlice {
  const maxBytes = outputReadLimit(options.maxBytes);
  const logPath = taskOutputPath(jobId, taskId);

  try {
    if (existsSync(logPath)) {
      const totalBytes = statSync(logPath).size;
      if (totalBytes > 0) {
        let cursor = outputCursor(options.cursor, totalBytes);
        if (cursor >= totalBytes) {
          return {
            source: "log",
            cursor,
            nextCursor: cursor,
            totalBytes,
            hasMore: false,
            text: "",
          };
        }

        const fd = openSync(logPath, "r");
        try {
          const probe = Buffer.allocUnsafe(Math.min(4, totalBytes - cursor));
          const probeRead = readSync(fd, probe, 0, probe.length, cursor);
          let probeIndex = 0;
          while (
            probeIndex < probeRead &&
            isUtf8ContinuationByte(probe[probeIndex])
          ) {
            cursor++;
            probeIndex++;
          }

          const readLength = Math.min(totalBytes - cursor, maxBytes + 4);
          const buffer = Buffer.allocUnsafe(readLength);
          const bytesRead = readSync(fd, buffer, 0, readLength, cursor);
          let end = Math.min(maxBytes, bytesRead);
          while (
            cursor + end < totalBytes &&
            end < bytesRead &&
            isUtf8ContinuationByte(buffer[end])
          ) {
            end--;
          }

          return {
            source: "log",
            cursor,
            nextCursor: cursor + end,
            totalBytes,
            hasMore: cursor + end < totalBytes,
            text: buffer.subarray(0, end).toString("utf8"),
          };
        } finally {
          closeSync(fd);
        }
      }
    }
  } catch (error) {
    console.warn("[agent-bus] 读取子 Agent 原始输出失败:", error);
  }

  const snapshot = getAgentTaskPanel(jobId, taskId)?.outputSnapshot;
  if (snapshot) {
    return sliceUtf8Buffer(
      "snapshot",
      Buffer.from(snapshot, "utf8"),
      options.cursor ?? 0,
      maxBytes,
    );
  }
  return {
    source: "none",
    cursor: 0,
    nextCursor: 0,
    totalBytes: 0,
    hasMore: false,
    text: "",
  };
}

function writeJson(target: string, value: unknown): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // 临时文件清理失败不掩盖原始持久化错误。
    }
    throw new AgentPersistenceError("写入子 Agent 状态", target, error);
  }
}

const AGENT_SAVE_OUTPUT_SNAPSHOT_CHARS = 20_000;
export const TASK_PANEL_OUTPUT_SNAPSHOT_CHARS = 64_000;
const MAX_TASK_STAGE_REPORTS = 40;
const MAX_TASK_STAGE_CONCLUSION_CHARS = 8_000;
const MAX_TASK_STAGE_DETAIL_CHARS = 12_000;

function trimSnapshot(
  value: string | undefined,
  maxChars = AGENT_SAVE_OUTPUT_SNAPSHOT_CHARS,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  const markerPrefix = "\n\n... [中间快照截断 ";
  const markerSuffix = " 字符] ...\n\n";
  const marker = `${markerPrefix}${value.length}${markerSuffix}`;
  const usable = Math.max(0, maxChars - marker.length);
  const tail = Math.min(16_000, Math.floor(usable / 3));
  const head = usable - tail;
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}${markerPrefix}${omitted}${markerSuffix}${value.slice(-tail)}`;
}

function defaultSaveId(jobId: string, taskId: string): string {
  return `${safeStorageName(taskId)}--${jobId.slice(0, 8)}`;
}

/**
 * 保存完整会话状态。内部使用异常表达持久化失败，公开边界会捕获并返回 null，
 * 避免存档故障导致宿主进程退出。
 */
function saveAgentStateOrThrow(
  jobId: string,
  taskId: string,
  options: SaveAgentStateOptions,
): AgentSaveState {
  const inst = getInstance(jobId, taskId) ?? options.instance;
  if (!inst) {
    throw new AgentPersistenceError(
      "保存子 Agent 状态",
      `${jobId}/${taskId}`,
      new Error("运行实例不存在"),
    );
  }

  // 优先使用 session 实时消息，session dispose 后用快照
  let messages: SessionMessage[];
  try {
    messages = inst.session.state.messages;
  } catch {
    messages = inst._savedMessages ?? [];
  }

  const saveId = options.saveId || defaultSaveId(jobId, taskId);
  const savedState: AgentSaveState = {
    version: 2,
    saveId,
    jobId,
    taskId,
    name: inst.name,
    model: inst.model ?? "?",
    messages,
    reason: options.reason ?? "manual",
    output: trimSnapshot(options.output),
    taskPanel: getAgentTaskPanel(jobId, taskId),
    savedAt: Date.now(),
  };

  try {
    writeJson(savePath(saveId), savedState);
  } catch (e) {
    // 消息可能含循环引用或不可序列化内容，清理后重试。
    try {
      const cleaned = {
        ...savedState,
        messages: messages.map((m) => {
          const content = typeof m.content === "string" ? m.content : "(binary content)";
          return { ...m, content: content.slice(0, 5000) };
        }),
      };
      writeJson(savePath(saveId), cleaned);
    } catch (retryError) {
      throw new AgentPersistenceError(
        "保存子 Agent 会话",
        `${jobId}/${taskId}`,
        retryError instanceof AgentPersistenceError ? retryError : e,
      );
    }
  }
  return savedState;
}

export function saveAgentState(
  jobId: string,
  taskId: string,
  options: SaveAgentStateOptions = {},
): AgentSaveState | null {
  try {
    return saveAgentStateOrThrow(jobId, taskId, options);
  } catch (error) {
    console.warn("[agent-bus] 存档失败:", error);
    return null;
  }
}

export function loadAgentState(saveId: string): AgentSaveState | null {
  try {
    const dir = saveDir();
    const currentPath = savePath(saveId);
    let target = currentPath;

    // 兼容旧版以 taskId 直接命名的存档，但拒绝任何路径分隔符。
    if (!existsSync(currentPath)) {
      const legacyName = `${saveId}.json`;
      if (basename(legacyName) !== legacyName) return null;
      const legacyPath = join(dir, legacyName);
      if (!existsSync(legacyPath)) return null;
      target = legacyPath;
    }

    const parsed = JSON.parse(readFileSync(target, "utf-8")) as
      | AgentSaveState
      | Omit<AgentSaveState, "version" | "jobId" | "reason">;
    if (!("version" in parsed)) {
      return {
        ...parsed,
        version: 2,
        jobId: "legacy",
        reason: "manual",
      };
    }
    if (parsed.taskPanel && !Array.isArray(parsed.taskPanel.stageReports)) {
      parsed.taskPanel.stageReports = [];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function deleteAgentSave(saveId: string): boolean {
  try {
    const dir = saveDir();
    const currentPath = savePath(saveId);
    if (existsSync(currentPath)) {
      unlinkSync(currentPath);
      return true;
    }
    const legacyName = `${saveId}.json`;
    if (basename(legacyName) !== legacyName) return false;
    unlinkSync(join(dir, legacyName));
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

// ---- 持久化任务面板 ----

function persistAgentTaskPanel(panel: AgentTaskPanel): boolean {
  try {
    const stageReports = ensureStageReports(panel);
    const snapshot: AgentTaskPanel = {
      ...panel,
      outputSnapshot: trimSnapshot(
        panel.outputSnapshot,
        TASK_PANEL_OUTPUT_SNAPSHOT_CHARS,
      ),
      stageReports: stageReports.slice(-MAX_TASK_STAGE_REPORTS),
      notes: panel.notes.slice(-100),
      persistenceError: undefined,
    };
    writeJson(panelPath(panel.jobId, panel.taskId), snapshot);
    panel.persistenceError = undefined;
    return true;
  } catch (error) {
    panel.persistenceError =
      error instanceof Error ? error.message : String(error);
    console.warn("[agent-bus] 任务面板持久化失败:", error);
    return false;
  }
}

function createAgentTaskPanel(jobId: string, task: SubTask): AgentTaskPanel {
  const now = Date.now();
  const name =
    task.prompt.slice(0, 60).replace(/\s+/g, " ").trim() || task.id;
  const panel: AgentTaskPanel = {
    version: 1,
    jobId,
    taskId: task.id,
    name,
    objective: task.prompt.slice(0, 4_000),
    status: "queued",
    progress: 0,
    stageReports: [],
    notes: (task.notes ?? []).slice(-20).map((note) => ({
      id: randomUUID(),
      text: note.slice(0, 4_000),
      source: "main",
      createdAt: now,
    })),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  state.taskPanels.set(instanceKey(jobId, task.id), panel);
  // 原始输出独立于轻量面板保存；失败不阻断任务，读取时会退回面板快照。
  resetAgentTaskOutput(jobId, task.id);
  persistAgentTaskPanel(panel);
  return panel;
}

export function getAgentTaskPanel(
  jobId: string,
  taskId: string,
): AgentTaskPanel | undefined {
  const panel = state.taskPanels.get(instanceKey(jobId, taskId));
  if (panel) ensureStageReports(panel);
  return panel;
}

export function listAgentTaskPanels(jobId?: string): AgentTaskPanel[] {
  const panels = Array.from(state.taskPanels.values());
  return panels
    .filter((panel) => !jobId || panel.jobId === jobId)
    .map((panel) => {
      ensureStageReports(panel);
      return panel;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function updateAgentTaskPanel(
  jobId: string,
  taskId: string,
  update: AgentTaskPanelUpdate,
): AgentTaskPanel | undefined {
  const panel = getAgentTaskPanel(jobId, taskId);
  if (!panel) return undefined;

  if (update.status !== undefined) panel.status = update.status;
  if (update.progress !== undefined && Number.isFinite(update.progress)) {
    panel.progress = Math.max(0, Math.min(100, Math.round(update.progress)));
  }
  if (update.currentStep !== undefined) {
    panel.currentStep = update.currentStep.trim().slice(0, 2_000) || undefined;
  }
  if (update.summary !== undefined) {
    panel.summary = update.summary.trim().slice(0, 8_000) || undefined;
  }
  if (update.conclusion?.trim()) {
    const conclusion = update.conclusion
      .trim()
      .slice(0, MAX_TASK_STAGE_CONCLUSION_CHARS);
    const detail = update.detail?.trim().slice(0, MAX_TASK_STAGE_DETAIL_CHARS);
    panel.summary = conclusion;
    const stageReports = ensureStageReports(panel);
    stageReports.push({
      id: randomUUID(),
      conclusion,
      detail: detail || undefined,
      status: panel.status,
      progress: panel.progress,
      currentStep: panel.currentStep,
      source: update.reportSource ?? "system",
      createdAt: Date.now(),
    });
    if (stageReports.length > MAX_TASK_STAGE_REPORTS) {
      panel.stageReports = stageReports.slice(-MAX_TASK_STAGE_REPORTS);
    }
  }
  if (update.outputSnapshot !== undefined) {
    panel.outputSnapshot = trimSnapshot(
      update.outputSnapshot,
      TASK_PANEL_OUTPUT_SNAPSHOT_CHARS,
    );
  }
  if (update.outputLength !== undefined && Number.isFinite(update.outputLength)) {
    panel.outputLength = Math.max(0, Math.floor(update.outputLength));
  }
  if (update.lastTool !== undefined) {
    panel.lastTool = update.lastTool.trim().slice(0, 200) || undefined;
  }
  if (update.saveId !== undefined) panel.saveId = update.saveId || undefined;
  if (update.note?.trim()) {
    panel.notes.push({
      id: randomUUID(),
      text: update.note.trim().slice(0, 4_000),
      source: update.noteSource ?? "system",
      createdAt: Date.now(),
    });
    if (panel.notes.length > 100) panel.notes = panel.notes.slice(-100);
  }

  if (
    panel.status === "completed" ||
    panel.status === "failed" ||
    panel.status === "timed_out" ||
    panel.status === "killed" ||
    panel.status === "interrupted"
  ) {
    panel.finishedAt ??= Date.now();
  } else {
    panel.finishedAt = undefined;
  }

  panel.revision += 1;
  panel.updatedAt = Date.now();
  persistAgentTaskPanel(panel);
  emitSafely(Events.TASK_PANEL_UPDATED, { jobId, taskId, panel });
  return panel;
}

/**
 * 宿主进程重启后恢复磁盘面板。原来仍处于活动态的任务标记为 interrupted，
 * 避免把没有对应会话的记录误报为仍在运行。
 */
function hydratePersistedTaskPanels(): void {
  if (state.taskPanels.size > 0) return;
  const root = taskPanelDir();
  if (!existsSync(root)) return;

  try {
    for (const jobDir of readdirSync(root, { withFileTypes: true })) {
      if (!jobDir.isDirectory()) continue;
      const dir = join(root, jobDir.name);
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".json")) continue;
        try {
          const panel = JSON.parse(
            readFileSync(join(dir, file.name), "utf-8"),
          ) as AgentTaskPanel;
          if (!panel.jobId || !panel.taskId || panel.version !== 1) continue;
          // 兼容阶段报告加入前已落盘的 v1 面板。
          panel.stageReports = Array.isArray(panel.stageReports)
            ? panel.stageReports.slice(-MAX_TASK_STAGE_REPORTS)
            : [];
          panel.notes = Array.isArray(panel.notes) ? panel.notes.slice(-100) : [];
          if (
            panel.status === "queued" ||
            panel.status === "running" ||
            panel.status === "blocked" ||
            panel.status === "paused"
          ) {
            panel.status = "interrupted";
            panel.summary =
              panel.summary || "宿主进程已重启；保留最后一次任务检查点。";
            panel.finishedAt = Date.now();
            panel.updatedAt = Date.now();
            panel.revision += 1;
          }
          state.taskPanels.set(instanceKey(panel.jobId, panel.taskId), panel);
          persistAgentTaskPanel(panel);
        } catch (error) {
          console.warn("[agent-bus] 忽略损坏的任务面板:", error);
        }
      }
    }
  } catch (error) {
    console.warn("[agent-bus] 恢复任务面板失败:", error);
  }
}

hydratePersistedTaskPanels();

// ---- Job API ----

export function createJob(tasks: SubTask[]): AgentJob {
  if (tasks.length === 0) {
    throw new Error("AgentJob 至少需要一个子任务");
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) throw new Error("AgentJob task.id 不能为空");
    if (ids.has(task.id)) {
      throw new Error(`AgentJob task.id 重复: ${task.id}`);
    }
    ids.add(task.id);
  }

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
  for (const task of tasks) createAgentTaskPanel(jobId, task);
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

  const panelStatus: AgentTaskPanelStatus =
    result.ok ? "completed" :
    result.errorCode === "timeout" || result.error === "timeout" ? "timed_out" :
    result.errorCode === "killed" ? "killed" :
    "failed";
  const existingPanel = getAgentTaskPanel(jobId, result.id);
  const finalConclusion = result.summary ?? existingPanel?.summary ?? (result.ok
    ? (result.output ?? "任务已完成")
    : (result.error ?? "任务失败"));
  const hasTerminalReport = existingPanel?.stageReports.some(
    (report) => report.status === panelStatus,
  );
  updateAgentTaskPanel(jobId, result.id, {
    status: panelStatus,
    progress: result.ok ? 100 : undefined,
    summary: finalConclusion,
    conclusion: hasTerminalReport ? undefined : finalConclusion,
    reportSource: "system",
    outputSnapshot: result.output,
    outputLength: result.outputLength,
    saveId: result.saveId,
  });

  job.results.push(result);
  job.completed++;

  emitSafely(Events.TASK_RESULT, {
    jobId,
    result,
    progress: `${job.completed}/${job.total}`,
  });

  if (job.completed >= job.total) {
    if (job.status !== "killed") job.status = "complete";
    job.finishedAt = Date.now();
    emitSafely(Events.JOB_COMPLETE, { jobId, job });
  }
}

export function publishJobError(jobId: string, error: string): void {
  const job = state.jobs.get(jobId);
  if (!job) return;
  job.status = "error";
  job.finishedAt = Date.now();
  emitSafely(Events.JOB_ERROR, { jobId, error });
}

// ---- Instance API（生命周期管理） ----

function instanceKey(jobId: string, taskId: string): string {
  return `${jobId}:${taskId}`;
}

export function registerInstance(inst: AgentInstance): void {
  const key = instanceKey(inst.jobId, inst.taskId);
  state.instances.set(key, inst);
  updateAgentTaskPanel(inst.jobId, inst.taskId, {
    status: "running",
    currentStep: "子 Agent 会话已启动",
  });
  emitSafely(Events.INSTANCE_REGISTERED, { jobId: inst.jobId, taskId: inst.taskId, name: inst.name });
}

export function unregisterInstance(jobId: string, taskId: string): void {
  const key = instanceKey(jobId, taskId);
  const inst = state.instances.get(key);
  if (inst?._idleTimer) clearTimeout(inst._idleTimer);
  state.instances.delete(key);
  if (inst) {
    emitSafely(Events.INSTANCE_UNREGISTERED, { jobId, taskId, name: inst.name });
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
    // update_agent_task 自身会写入更精确的状态；工具结束事件不能把
    // completed/blocked 又覆盖成 running。
    if (update.logTool.toolName !== "update_agent_task") {
      updateAgentTaskPanel(jobId, taskId, {
        status: "running",
        currentStep:
          update.logTool.status === "started"
            ? `正在调用工具 ${update.logTool.toolName}`
            : `工具 ${update.logTool.toolName} ${
                update.logTool.status === "done" ? "已完成" : "执行失败"
              }`,
        lastTool: update.logTool.toolName,
        note:
          update.logTool.status === "error"
            ? `工具 ${update.logTool.toolName} 失败：${update.logTool.error ?? "未知错误"}`
            : undefined,
        noteSource: "system",
      });
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

  emitSafely(Events.STATUS_CHANGED, {
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
    try { await inst._dispose("killed by main agent"); } catch (error) {
      console.warn("[agent-bus] killAgent dispose 失败:", error);
    }
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
      errorCode: "killed",
    });
  }
  updateAgentTaskPanel(jobId, taskId, {
    status: "killed",
    summary: "由主 Agent 终止",
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
  inst.detailedStatus = "paused";
  updateAgentTaskPanel(jobId, taskId, {
    status: "paused",
    currentStep: "任务已暂停，可继续恢复",
  });
  emitSafely(Events.AGENT_PAUSED, { jobId, taskId, name: inst.name });
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
    inst.detailedStatus = "running";
    updateAgentTaskPanel(jobId, taskId, {
      status: "running",
      currentStep: msg,
      note: `任务已恢复：${msg}`,
      noteSource: "main",
    });
    emitSafely(Events.AGENT_RESUMED, { jobId, taskId, name: inst.name });
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
    updateAgentTaskPanel(jobId, taskId, {
      currentStep: text,
      note: `主 Agent 注入：${text}`,
      noteSource: "main",
    });
    return true;
  } catch {
    return false;
  }
}

// ---- 消息传递 ----

export function sendMessage(
  from: string,
  to: string,
  type: BusAgentMessage["type"],
  payload: string,
): string {
  const msgId = randomUUID();
  const msg: BusAgentMessage = { msgId, from, to, type, payload, timestamp: Date.now() };
  emitSafely(Events.AGENT_MESSAGE, msg);
  return msgId;
}

export function onMessage(
  target: string,
  handler: (msg: BusAgentMessage) => void | Promise<void>,
): () => void {
  const wrapper = (msg: BusAgentMessage) => {
    if (msg.to === target || msg.to === "broadcast") {
      return handler(msg);
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
  callback: (job: AgentJob) => void | Promise<void>,
): () => void {
  const invoke = (job: AgentJob) =>
    Promise.resolve()
      .then(() => callback(job))
      .catch((error) => {
        console.warn(`[agent-bus] Job ${jobId} 完成回调失败:`, error);
      });
  const existing = state.jobs.get(jobId);
  if (
    existing &&
    (existing.status === "complete" ||
      existing.status === "error" ||
      existing.status === "killed")
  ) {
    setImmediate(() => { void invoke(existing); });
    return () => {};
  }

  const handler = (data: { jobId: string; job: AgentJob }) => {
    if (data.jobId !== jobId) return;
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
    const job = state.jobs.get(jobId);
    if (job) return invoke(job);
  };

  const errorHandler = (data: { jobId: string }) => {
    if (data.jobId !== jobId) return;
    globalBus.off(Events.JOB_COMPLETE, handler);
    globalBus.off(Events.JOB_ERROR, errorHandler);
    const job = state.jobs.get(jobId);
    if (job) return invoke(job);
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

    // 不能用 once：并发多个 Job 时，其他 Job 的完成事件会先触发并移除监听器，
    // 导致当前 waitForJob 永远等不到目标 Job。
    globalBus.on(Events.JOB_COMPLETE, onComplete);
    globalBus.on(Events.JOB_ERROR, onError);
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
      for (const [key, panel] of state.taskPanels) {
        if (panel.jobId === id) state.taskPanels.delete(key);
      }
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
