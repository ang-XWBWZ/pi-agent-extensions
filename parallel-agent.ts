/**
 * parallel-agent.ts — 子 Agent 系统 v9
 *
 * 工具:
 *   spawn_agent          — 并行派发子 Agent，立即返回 jobId，后台运行
 *   check_agent_results  — 查询/等待子 Agent 结果
 *   send_agent_message   — Agent 间消息传递
 *   control_agent        — 子 Agent 完整生命周期控制
 *
 * v9 改进:
 *   - 模型分级联动：task 支持 tier (L0/L1/L2) 自动选模型 + 思考深度
 *   - 思考深度传递：task.thinkingLevel 覆盖层级默认值
 *   - 优先级链：task.model > task.tier + thinkingLevel > 主 Agent 模型
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, access } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  createJob,
  publishTaskResult,
  publishJobError,
  getJob,
  listJobs,
  listInstances,
  waitForJob,
  onJobComplete,
  onMessage,
  sendMessage,
  registerInstance,
  unregisterInstance,
  killAgent,
  killJob,
  abortAgent,
  pauseAgent,
  resumeAgent,
  sendAgentInput,
  cleanupJobs,
  getJobInstances,
  getInstance,
  getAgentBus,
  Events,
  updateInstanceStatus,
  saveAgentState,
  loadAgentState,
  deleteAgentSave,
  listAgentSaves,
  enqueueFrontend,
  registerFrontendProcessor,
  type SubTask,
  type SubResult,
  type AgentJob,
  type AgentInstance,
  type AgentSaveState,
} from "./lib/agent-bus.js";

// ---- sessionManager → taskId 映射，用于 send_agent_message 自动识别发送方 ----
const subAgentIdentity = new WeakMap<object, string>();

// ---- helpers ----

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  // 已 ≤ 目标宽度 → 直接返回
  if (visibleWidth(text) <= maxWidth) return text;
  // 从尾部逐字符移除（处理 ANSI 码 + CJK 宽字符）
  let result = text;
  while (result.length > 0 && visibleWidth(result) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result;
}

async function loadContext(paths: string[], cwd: string): Promise<string> {
  const chunks: string[] = [];
  for (const p of paths) {
    try {
      const abs = resolve(cwd, p);
      await access(abs);
      const content = await readFile(abs, "utf-8");
      chunks.push(`\n--- FILE: ${p} ---\n${content.slice(0, 50_000)}`);
    } catch {
      chunks.push(`\n[无法读取: ${p}]`);
    }
  }
  return chunks.join("\n");
}

// ---- skill 前端解析（YAML frontmatter + 异常降级） ----

/** 解析 SKILL.md 的 YAML frontmatter */
interface SkillFrontmatter {
  name: string;
  description: string;
  /** 原始 frontmatter 块全文（含 --- 包围） */
  raw: string;
  /** description 是否完整解析 */
  complete: boolean;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  // 匹配文件开头的 --- 包围的 YAML 块
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fmText = match[1];
  const lines = fmText.split('\n');
  let name = '';
  let desc = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) { name = nameMatch[1].trim(); continue; }

    // description: 单行 或 块语法（> / >- / |）
    const descStart =
      line.match(/^description:\s*[>|]\s*/) ||
      line.match(/^description:\s*(.+)/);
    if (descStart) {
      if (descStart[1]) {
        // 单行: description: xxx
        desc = descStart[1].trim();
      } else {
        // 块: >, >-, |  后续缩进行都属于 description
        const descLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const sub = lines[j];
          if (/^[ \t]/.test(sub)) {
            descLines.push(sub.trim());
          } else {
            break;
          }
        }
        desc = descLines.join(' ');
        i += descLines.length; // 跳过已处理的行
      }
    }
  }

  // name 为空时无法识别，返回 null 由调用方做长度降级
  if (!name) return null;
  return { name, description: desc, raw: match[0], complete: !!desc };
}

/**
 * 无 frontmatter 时按文件长度渐变纰漏。
 *
 *   <  1KB → 全量
 *   1-5KB  → 头 2KB
 *   5-15KB → 头 3KB + 尾 1KB
 *   > 15KB → 头 1KB + 尾 512B
 */
function partialReveal(content: string): string {
  const len = content.length;
  const sizeKB = (len / 1024).toFixed(1);

  let partial: string;
  if (len < 1024) {
    partial = content;
  } else if (len < 5120) {
    partial = content.slice(0, 2048);
  } else if (len < 15360) {
    partial = content.slice(0, 3072) + '\n... [截断] ...\n' + content.slice(-1024);
  } else {
    partial = content.slice(0, 1024) + '\n... [截断] ...\n' + content.slice(-512);
  }

  return `\u26a0\ufe0f [partial reveal \u2014 原始文件 ${sizeKB}KB, 未解析到 frontmatter]\n${partial}`;
}

/**
 * 加载 skill 文件（全量）。
 * 搜索失败时返回 [无法加载] 标记，不抛出异常。
 */
async function loadSkill(name: string): Promise<string> {
  // 按优先级尝试多个路径：项目 skills → pi agent skills → 全局 .agents/skills
  const searchPaths = [
    resolve(process.cwd(), "skills", name, "SKILL.md"),
    resolve(process.env.USERPROFILE ?? ".", ".pi", "agent", "skills", name, "SKILL.md"),
    resolve(process.env.USERPROFILE ?? ".", ".agents", "skills", name, "SKILL.md"),
  ];

  for (const skillPath of searchPaths) {
    try {
      await access(skillPath);
      const content = await readFile(skillPath, "utf-8");
      return `\n--- SKILL: ${name} ---\n${content.slice(0, 30_000)}`;
    } catch {
      // 文件不存在/读取失败，尝试下一个路径
    }
  }

  // 所有路径均失败
  return `\n[无法加载 skill: ${name}]`;
}

// ---- Token 估算（匹配系统启发式） ----
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "M" : v + "M";
  }
  if (n >= 1_000) {
    const v = (n / 1_000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "k" : v + "k";
  }
  return String(Math.round(n));
}

// ---- Session 创建串行化（防止并发 globalThis 写入） ----
let sessionChain = Promise.resolve();

// ---- 单子 Agent 执行（事件驱动，注册实例） ----

function runSingleAgent(
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
    // 改为异步立即执行，finish 内部走 _dispose 统一清理
    (async () => {
      let unsubRef: (() => void) | undefined;
      let timerRef: ReturnType<typeof setTimeout> | null = null;
      let instRef: AgentInstance | undefined;

      /** 统一终止入口：abort → unsub → clear timer → dispose → unregister → resolve */
      const finish = async (result: SubResult) => {
        const inst = instRef ? getInstance(jobId, task.id) : undefined;
        if (inst?._settled) return;
        if (inst) {
          inst._settled = true;
          // 1. Abort 当前操作
          try { await inst.session.abort(); } catch { /* */ }
          // 2. 取消订阅
          try { unsubRef?.(); } catch { /* */ }
          // 3. 清除定时器
          if (timerRef) { clearTimeout(timerRef); timerRef = null; }
          // 4. 销毁 session
          try { inst.session.dispose(); } catch { /* */ }
          // 5. 注销实例
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
          // 黑名单检查：黑名单中的 skill 完全不加载
          if (config.blacklist.includes(s)) continue;
          // 主动传入 skills → 全量加载
          extra += await loadSkill(s);
        }
      }
      const prompt = extra
        ? `${task.prompt}\n\n[注入上下文]\n${extra}`
        : task.prompt;

      // ---- 串行化 globalThis 写入（Promise 链替代 InitLock） ----
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

      // ---- 注册实例（含行为状态追踪字段） ----
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
      let timer: ReturnType<typeof setTimeout> | null = null;

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
          // 自动续推
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

      // 补上 resetTimer 引用
      instRef._resetTimer = resetTimer;
      instRef._dispose = async () => { await finish({ id: task.id, name, order, ok: false, error: "disposed" }); };
      resetTimer();

      unsubRef = session.subscribe(async (event) => {
        // ---- 泄露自检：每次 turn/tool 前确认 bus 注册状态 ----
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
            if (output.length > 10_000)
              output = output.slice(0, 10_000) + "\n...";
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
        // ---- message end → 提取原生 token 统计实时更新面板 ----
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
          } catch { /* session stats unavailable */ }
        }
        // ---- agent end → done ----
        if (event.type === "agent_end") {
          clearIdle();
          updateInstanceStatus(jobId, task.id, { detailedStatus: "done" });
          // 捕获消息快照 + 自动存档
          try {
            instRef._savedMessages = session.state.messages;
            saveAgentState(jobId, task.id);
          } catch { /* */ }
          // 提取原生 token 统计（覆盖启发式估算）
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
          } catch { /* session stats unavailable */ }
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

// ---- 层级解析（从 settings.json 读取 modelTiers） ----

const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

function settingsPath(): string {
  return join(
    process.env.USERPROFILE ?? ".",
    ".pi",
    "agent",
    "settings.json",
  );
}

/** skill 按需加载配置（仅黑名单，白名单由 spawn_agent 的 skills 参数决定） */
interface SkillConfig {
  blacklist: string[];
}

/** 从 settings.json 读取 skill 黑名单 */
function loadSkillConfig(): SkillConfig {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const section = raw.skills as Record<string, unknown> | undefined;
    if (!section || typeof section !== "object") return { blacklist: [] };

    return {
      blacklist: Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [],
    };
  } catch {
    // settings.json 不存在 / JSON 解析失败
    return { blacklist: [] };
  }
}

/** 从 settings.json 读取 tool 黑名单 */
function loadToolConfig(): string[] {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const section = raw.tools as Record<string, unknown> | undefined;
    if (!section || typeof section !== "object") return [];
    const bl = section.blacklist;
    if (!Array.isArray(bl)) return [];
    return bl.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

interface TaskResolvedConfig {
  model: string;
  thinkingLevel?: string;
}

/** 从 task.tier 解析模型+思考深度（优先级：task.model > tier > 默认） */
function resolveTaskConfig(
  task: SubTask & { tier?: string; thinkingLevel?: string },
): TaskResolvedConfig | null {
  const tier = task.tier?.toUpperCase();
  if (!tier || !["L0", "L1", "L2"].includes(tier)) return null;

  // 无配置则降级（子进程用主模型）

  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    const tiers = raw.modelTiers as Record<string, unknown> | undefined;
    if (!tiers || typeof tiers !== "object") return null;

    const cfg = tiers[tier] as Record<string, unknown> | undefined;
    if (!cfg || !Array.isArray(cfg.models) || cfg.models.length === 0)
      return null;

    const firstModel = cfg.models[0] as {
      provider: string;
      model: string;
    };
    const model = `${firstModel.provider}/${firstModel.model}`;

    const rawThink =
      (task.thinkingLevel as string) ?? (cfg.thinkingLevel as string);
    if (
      rawThink &&
      VALID_THINKING_LEVELS.includes(
        rawThink as (typeof VALID_THINKING_LEVELS)[number],
      )
    ) {
      return { model, thinkingLevel: rawThink };
    }
    return { model };
  } catch {
    return null;
  }
}

// ---- 后台批量启动（fire-and-forget） ----

interface JobStats {
  input: number;
  output: number;
  cache: number;
  cost: number;
  ctxPct: number;
  ctxWin: number;
}

function computeJobStats(results: SubResult[]): JobStats {
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

function formatJobNotificationLine(jobId: string, results: SubResult[], total: number, elapsed: string): string {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const totalTokens = computeJobStats(results);
  const statsPart = totalTokens.input > 0
    ? ` | 📊 \u2191${fmtNum(totalTokens.input)} \u2193${fmtNum(totalTokens.output)} R${fmtNum(totalTokens.cache)} $${totalTokens.cost < 0.001 ? totalTokens.cost.toExponential(2) : totalTokens.cost.toFixed(3)} ${totalTokens.ctxPct > 0 ? totalTokens.ctxPct.toFixed(1) + "%" : "?%"}${totalTokens.ctxWin > 0 ? "/" + fmtNum(totalTokens.ctxWin) : ""}`
    : "";
  return `\u{1f916} [\u5b50\u4efb\u52a1\u5b8c\u6210] Job \`${jobId.slice(0, 8)}\` \u2014 \u2705 ${okCount} / \u274c ${failCount} / \u{1f4ca} ${total} (${elapsed}s)${statsPart}`;
}

function spawnAllBackground(
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

// ---- extension ----

export default function (pi: ExtensionAPI) {

  // ---- 用 globalThis 收子进程消息 + steer 推送（不依赖 pi 实例，重载后仍有效） ----
  const STEER_KEY = "__pi_pending_steer_msgs";
  const PENDING_KEY = "__pi_pending_agent_msgs";
  if (!(globalThis as Record<string, unknown>)[PENDING_KEY]) {
    (globalThis as Record<string, unknown>)[PENDING_KEY] = [];
    (globalThis as Record<string, unknown>)[STEER_KEY] = [];
    onMessage("main", (msg) => {
      ((globalThis as Record<string, unknown>)[PENDING_KEY] as Array<any>).push({
        from: msg.from,
        type: msg.type,
        payload: msg.payload,
      });
    });
    // steer 队列由 FrontendQueue 的 "steer" 处理器投递
    // 不用 pi.sendUserMessage（避免闭包持有 stale pi 引用）
    registerFrontendProcessor("steer", async (data) => {
      const text = data as string;
      const q = (globalThis as Record<string, unknown>)[STEER_KEY] as string[];
      q.push(text);
    });
  }
  const pendingMsgs = (globalThis as Record<string, unknown>)[PENDING_KEY] as Array<{
    from: string;
    type: string;
    payload: string;
  }>;

  // ---- context 事件注入待收消息 + steer 消息（每次拉取，不缓存 pi 引用） ----
  pi.on("context", (_event, _ctx) => {
    // 注入 steer 消息
    const steerQ = (globalThis as Record<string, unknown>)[STEER_KEY] as string[];
    const hasSteer = steerQ && steerQ.length > 0;
    // 注入子进程消息
    const hasMsgs = pendingMsgs.length > 0;
    if (!hasSteer && !hasMsgs) return;
    const parts: string[] = [];
    if (hasSteer) {
      const batch = steerQ.splice(0);
      parts.push(batch.join("\n"));
    }
    if (hasMsgs) {
      const batch = pendingMsgs.splice(0);
      const lines = batch.map((m) => `[${m.from}] ${m.payload}`);
      parts.push(`[agent-message]\n${lines.join("\n")}`);
    }
    _event.messages.push({
      role: "user",
      content: parts.join("\n"),
    } as any);
    // 只修改 event.messages 原地，不返回 { messages }，避免与 attention-buffer 冲突
  });

  // ==================== 子 Agent 状态面板 Widget ====================

  let widgetTui: { requestRender(): void } | null = null;
  let widgetRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const refreshWidget = () => {
    try { widgetTui?.requestRender(); } catch { /* */ }
  };

  pi.on("session_start", async (_event, ctx) => {
    const bus = getAgentBus();

    // 订阅 agent-bus 事件，自动刷新 widget
    const onEvent = () => refreshWidget();
    bus.on(Events.INSTANCE_REGISTERED, onEvent);
    bus.on(Events.INSTANCE_UNREGISTERED, onEvent);
    bus.on(Events.AGENT_PAUSED, onEvent);
    bus.on(Events.AGENT_RESUMED, onEvent);
    bus.on(Events.TASK_RESULT, onEvent);
    bus.on(Events.STATUS_CHANGED, onEvent);

    // JOB_COMPLETE：前台通知 + 触发 LLM + 刷新 widget
    bus.on(Events.JOB_COMPLETE, (data: { jobId: string; job: AgentJob }) => {
      const completedJob = data.job;
      const elapsed = completedJob.finishedAt
        ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
        : "?";
      const line = formatJobNotificationLine(completedJob.jobId, completedJob.results, completedJob.total, elapsed);
      // 通过 sendUserMessage 触发 LLM 下一轮调用（消息固化 + AI 主动处理）
      try {
        pi.sendUserMessage(line, { deliverAs: "steer", triggerTurn: true });
      } catch { /* 非主 session 或已关闭时忽略 */ }
      refreshWidget();
    });

    // 定时刷新（兜底 outputLength 更新）
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = setInterval(refreshWidget, 1500);

    ctx.ui.setWidget("sub-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => {
          const insts = listInstances();
          if (insts.length === 0) return [];

          const lines: string[] = [];
          const hdr = theme.fg("accent", theme.bold(`🤖 子 Agent (${insts.length})`));
          lines.push(truncateToWidth(hdr, width));

          for (const inst of insts) {
            // 精细状态 → 图标 + 文字
            const statusIcon =
              inst.detailedStatus === "thinking" ? "🧠" :
              inst.detailedStatus === "tool_calling" ? "🔧" :
              inst.detailedStatus === "idle" ? "⏳" :
              inst.detailedStatus === "paused" ? "⏸️" :
              inst.detailedStatus === "done" ? "✅" :
              inst.status === "paused" ? "⏸️" : "🟢";
            const statusText =
              inst.detailedStatus === "tool_calling" && inst.currentTool
                ? inst.currentTool
                : inst.detailedStatus === "thinking" ? "思考中"
                : inst.detailedStatus === "idle" ? "空闲等待"
                : inst.detailedStatus === "done" ? "完成"
                : inst.detailedStatus === "paused" ? "已暂停"
                : "运行中";
            const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(0);
            const tokIn = fmtNum(inst.inputTokens);
            const tokOut = fmtNum(inst.outputTokens);
            const title = inst.name.length > 20
              ? inst.name.slice(0, 20) + "…"
              : inst.name;
            const modelShort = inst.model || "?";
            const tierPrefix = inst.tier ? `[${inst.tier}] ` : "";
            const thinkSuffix = inst.thinkingLevel && inst.thinkingLevel !== "off"
              ? ` 🧠${inst.thinkingLevel}`
              : "";
            const modelTag = (tierPrefix + modelShort + thinkSuffix).length > 35
              ? (tierPrefix + modelShort + thinkSuffix).slice(0, 35) + "…"
              : tierPrefix + modelShort + thinkSuffix;

            // 构建指标段：↑in ↓out [Rcache] [$cost] [ctx%/ctxWin]
            const metrics: string[] = [];
            metrics.push(`↑${tokIn}`);
            metrics.push(`↓${tokOut}`);
            if (inst.cacheTokens > 0) {
              metrics.push(`R${fmtNum(inst.cacheTokens)}`);
            }
            if (inst.cost > 0) {
              metrics.push(`$${inst.cost < 0.001 ? inst.cost.toExponential(2) : inst.cost.toFixed(3)}`);
            }
            if (inst.contextPercent !== null && inst.contextPercent !== undefined && inst.contextWindow > 0) {
              metrics.push(`${inst.contextPercent.toFixed(1)}%/${fmtNum(inst.contextWindow)}`);
            }
            metrics.push(`${elapsed}s`);
            metrics.push(statusText);

            // 构建完整行，用 visibleWidth 测量后截断
            const fullLine =
              `  ${statusIcon} ${theme.fg("accent", inst.taskId)} ${theme.fg("muted", title)}  ${theme.fg("dim", modelTag)}  ${theme.fg("dim", metrics.join(" "))}`;
            lines.push(
              visibleWidth(fullLine) > width
                ? truncateToWidth(fullLine, width - 1) + "…"
                : fullLine,
            );
          }

          return lines;
        },
        invalidate: () => tui.requestRender?.(),
      };
    });
  });

  pi.on("session_shutdown", () => {
    if (widgetRefreshTimer) {
      clearInterval(widgetRefreshTimer);
      widgetRefreshTimer = null;
    }
    widgetTui = null;
  });

  // ==================== spawn_agent ====================

  // 硬编码安全网——这些工具始终不传入子进程（防递归/生命周期冲突）
  const TOOL_SAFETY_NET: ReadonlySet<string> = new Set([
    "spawn_agent",
    "check_agent_results",
    "control_agent",
  ]);

  function getFilteredTools(): string[] {
    const configBlacklist = new Set(loadToolConfig());
    return (pi.getActiveTools?.() ?? []).filter((t) => {
      if (TOOL_SAFETY_NET.has(t)) return false;
      if (configBlacklist.has(t)) return false;
      return true;
    });
  }

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "派发子 Agent 执行分析任务。子 Agent 继承默认工具（read/bash/edit/write），" +
      "在后台并行运行，不阻塞主 Agent。返回 jobId 用于查询结果。",
    promptSnippet: "Spawn sub-agents for parallel code exploration (read-only)",
    promptGuidelines: [
      "Use spawn_agent to delegate exploration/research to sub-agents.",
      "Each task runs in an isolated in-memory session with default tools.",
      "Keep prompts focused on analysis. Results returned as structured JSON.",
      "After spawning, use check_agent_results(jobId) to retrieve results.",
      "For multiple independent tasks, spawn them together for parallel execution.",
      "Results are auto-injected into the conversation when complete — you DO NOT need to block-wait. Keep interacting with the user normally.",
      "To resume from a saved state, set resumeFrom on the task to the saveId from control_agent save/list_saves.",
      // ── 模型分层策略 (v9) ──
      "Each task supports 'tier' (L0/L1/L2) for automatic model + thinking level selection from modelTiers config.",
      "Use tier: \"L0\" for cheap/fast tasks: file lookups, code maps, simple queries — saves tokens.",
      "Use tier: \"L1\" (default if not specified) for coding, refactoring, debugging.",
      "Use tier: \"L2\" for architecture design, cross-module analysis, security review — deepest reasoning.",
      "Override thinking level per task with 'thinkingLevel' (off/minimal/low/medium/high/xhigh).",
      "Task model resolution priority: task.model > task.tier > main agent model.",
      // ── Skill 按需加载 (v10) ──
      "Skills passed in spawn_agent are loaded in FULL.",
      "Skills in the global settings.json skills.blacklist are never loaded.",
      // ── 体验 ──
      "Delegate independent read/search/analysis tasks only. Sub-agents are YOUR workers — dispatch and move on.",
      "FORBIDDEN: Do NOT spawn sub-agents for trivial single-file reads or single kb_search calls. These are faster done directly.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "任务标识" }),
          prompt: Type.String({ description: "子任务描述" }),
          context: Type.Optional(Type.Array(Type.String())),
          skills: Type.Optional(Type.Array(Type.String())),
          mode: Type.Optional(StringEnum(["plan", "work", "yolo"] as const)),
          model: Type.Optional(Type.String()),
          tier: Type.Optional(Type.String({ description: "模型层级: L0(快速) | L1(主要) | L2(高级)。自动选模型+思考深度" })),
          thinkingLevel: Type.Optional(Type.String({ description: "覆盖层级默认思考深度: off | minimal | low | medium | high | xhigh" })),
          resumeFrom: Type.Optional(Type.String({ description: "从存档恢复（saveId），继承历史对话上下文" })),
        }),
      ),
      timeout: Type.Optional(Type.Number({ description: "单任务超时秒（默认 60）" })),
      autoInject: Type.Optional(Type.Boolean({ description: "完成后自动推送结果到主对话（默认 true）" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const total = params.tasks.length;
      const deadline = (params.timeout ?? 60) * 1000;
      const autoInject = params.autoInject !== false; // 默认 true

      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");

      let defaultModel: Model<any> | undefined = undefined;
      if (ctx.model) defaultModel = ctx.model as Model<any>;

      if (!defaultModel) {
        return {
          content: [{ type: "text", text: "错误: 没有可用的模型" }],
          details: { error: "no model" },
        };
      }

      // ---- 处理 resumeFrom：注入存档上下文 ----
      const resolvedTasks: SubTask[] = [];
      for (const task of params.tasks as SubTask[]) {
        const resumeId = (task as Record<string, unknown>).resumeFrom as string | undefined;
        if (resumeId) {
          const saved = loadAgentState(resumeId);
          if (saved) {
            // 将存档消息序列化为上下文注入
            const historyText = saved.messages
              .map((m) => {
                if (m.role === "user") return `[User]: ${typeof m.content === "string" ? m.content : "(content)"}`;
                if (m.role === "assistant") return `[Assistant]: ${typeof m.content === "string" ? m.content.slice(0, 500) : "(content)"}`;
                return `[${m.role}]`;
              })
              .join("\n");
            const resumeContext = `[从存档恢复: ${saved.name} (${saved.model}, ${saved.messages.length} 条消息)]\n\n--- 历史对话 ---\n${historyText.slice(-10_000)}\n--- 历史结束 ---`;
            resolvedTasks.push({
              ...task,
              context: [...(task.context || []), resumeContext],
            });
          } else {
            console.warn(`[parallel-agent] 存档 ${resumeId} 不存在，跳过恢复`);
            resolvedTasks.push(task);
          }
        } else {
          resolvedTasks.push(task);
        }
      }

      const job = createJob(resolvedTasks);
      job.status = "running";

      try {
        pi.appendEntry("agent-job", {
          jobId: job.jobId,
          total,
          tasks: resolvedTasks.map((t) => ({ id: t.id, prompt: t.prompt.slice(0, 80) })),
          createdAt: job.createdAt,
          status: "running",
        });
      } catch { /* */ }

      const filteredTools = getFilteredTools();

      spawnAllBackground(
        job.jobId,
        resolvedTasks,
        ctx.cwd,
        defaultModel,
        ctx.modelRegistry,
        deadline,
        pi,
        filteredTools,
      );

      // ---- 自动结果注入标记（实际推送由 session_start 的 JOB_COMPLETE 监听负责） ----
      if (autoInject) {
        onJobComplete(job.jobId, async (completedJob) => {
          if (completedJob._autoInjected) return;
          completedJob._autoInjected = true;
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
              ``,
              `主动查询: \`check_agent_results("${job.jobId}")\`（非阻塞，立即返回当前进度）`,
              `生命周期: \`control_agent({ action: "kill" | "abort" | "send" | "pause" | "resume" | "list" | "status", jobId: "${job.jobId}" })\``,
            ].join("\n"),
          },
        ],
        details: { jobId: job.jobId, taskCount: total, status: "dispatched", autoInject },
      };
    },
  });

  // ==================== check_agent_results ====================

  pi.registerTool({
    name: "check_agent_results",
    label: "Check Agent Results",
    description:
      "查询子 Agent 执行结果。可轮询（不阻塞）或等待（阻塞直到完成）。" +
      "不传 jobId 时列出所有 Job。",
    promptSnippet: "Check or wait for sub-agent results",
    promptGuidelines: [
      "Use after spawn_agent to retrieve results.",
      "Pass wait=true to block until all sub-agents complete.",
      "Pass wait=false (default) for non-blocking poll — returns current progress.",
      "Call without jobId to list all pending/completed jobs.",
      "PREFER non-blocking poll (wait=false, the default). Results are auto-injected via steer when complete — no need to block.",
      "Use wait=true ONLY when you must synchronize before the next action, but know it blocks user interaction.",
      // ── 体验 ──
      "Default to wait=false. Results auto-inject on completion — polling is rarely needed.",
      "FORBIDDEN: Do NOT use wait=true during interactive conversation. It freezes the UI and kills user experience.",
    ],
    parameters: Type.Object({
      jobId: Type.Optional(Type.String({ description: "Job ID（不传则列出所有）" })),
      wait: Type.Optional(Type.Boolean({ description: "是否阻塞等待完成（默认 false）" })),
      timeout: Type.Optional(Type.Number({ description: "等待超时秒（默认 300）" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");

      if (!params.jobId) {
        const allJobs = listJobs();
        if (allJobs.length === 0) {
          return {
            content: [{ type: "text", text: "没有进行中或已完成的 Job。" }],
            details: { jobs: [] },
          };
        }

        const lines = allJobs.map((j) => {
          const statusIcon =
            j.status === "complete" ? "✅" :
            j.status === "error" ? "❌" :
            j.status === "killed" ? "💀" :
            j.status === "running" ? "🔄" : "📋";
          const elapsed = j.finishedAt
            ? `${((j.finishedAt - j.createdAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - j.createdAt) / 1000).toFixed(1)}s`;
          const suffix = j.finishedAt ? "" : " (进行中)";
          return `${statusIcon} ${j.jobId.slice(0, 8)} — ${j.completed}/${j.total} 完成 — ${elapsed}${suffix} — ${j.status}`;
        });

        return {
          content: [{ type: "text", text: `所有 Job:\n${lines.join("\n")}` }],
          details: { jobs: allJobs.map((j) => ({ jobId: j.jobId, status: j.status, completed: j.completed, total: j.total })) },
        };
      }

      const job = getJob(params.jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `Job 不存在: ${params.jobId}（可能已过期被清理）` }],
          details: { jobId: params.jobId, error: "not_found" },
        };
      }

      ctx.ui.setStatus("sub-agent", `查询 ${params.jobId.slice(0, 8)}...`);

      if (job.status === "complete" || job.status === "error" || job.status === "killed") {
        ctx.ui.setStatus("sub-agent", undefined);
        const elapsed = job.finishedAt
          ? ((job.finishedAt - job.createdAt) / 1000).toFixed(1)
          : "?";
        if (job._autoInjected) {
          return {
            content: [{ type: "text", text: `📋 Job ${params.jobId!.slice(0, 8)} 已完成，结果已自动推送到对话中。` }],
            details: { jobId: job.jobId, status: job.status, autoInjected: true },
          };
        }
        job._autoInjected = true;
        return formatJobResult(job, elapsed);
      }

      if (!params.wait) {
        ctx.ui.setStatus("sub-agent", undefined);
        const elapsed = ((Date.now() - job.createdAt) / 1000).toFixed(1);
        return {
          content: [
            {
              type: "text",
              text: [
                `🔄 Job ${params.jobId.slice(0, 8)} 进行中 — ${job.completed}/${job.total} 完成 (${elapsed}s)`,
                ``,
                `已完成:`,
                ...job.results.map(
                  (r) => `  ${r.ok ? "✅" : "❌"} ${r.name}: ${(r.output ?? r.error ?? "").slice(0, 120)}`,
                ),
                ``,
                `结果将在完成后自动推送。主动查询进度: check_agent_results("${params.jobId}")（非阻塞）。`,
              ].join("\n"),
            },
          ],
          details: { jobId: params.jobId, status: "running", completed: job.completed, total: job.total, results: job.results },
        };
      }

      const waitTimeout = (params.timeout ?? 300) * 1000;
      ctx.ui.notify(`⏳ 等待 Job ${params.jobId.slice(0, 8)} 完成...`, "info");

      const completedJob = await waitForJob(params.jobId, waitTimeout, signal);
      ctx.ui.setStatus("sub-agent", undefined);
      if (completedJob._autoInjected) {
        return {
          content: [{ type: "text", text: `📋 Job ${params.jobId!.slice(0, 8)} 已完成，结果已自动推送到对话中。` }],
          details: { jobId: completedJob.jobId, status: completedJob.status, autoInjected: true },
        };
      }
      completedJob._autoInjected = true;

      const elapsed = completedJob.finishedAt
        ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
        : "?";
      return formatJobResult(completedJob, elapsed);
    },
  });

  // ==================== send_agent_message ====================

  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description:
      "向子 Agent 或其他 Agent 发送消息。支持广播 (to='broadcast') 和点对点通信。",
    promptSnippet: "Send messages between agents via the AgentBus",
    promptGuidelines: [
      "Use to communicate with running sub-agents or coordinate multi-agent workflows.",
      'Set to="broadcast" to send to all agents.',
      "Messages are fire-and-forget — no response is returned.",
      // ── 体验 ──
      "Use 'broadcast' for coordination signals (e.g. 'pause all', 'update context'). Use taskId for targeted instructions.",
      "FORBIDDEN: Do NOT expect a reply or block waiting for one. Messages are strictly one-way.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "目标: 'broadcast' | jobId | taskId" }),
      type: Type.Optional(StringEnum(["info", "request", "response", "error"] as const)),
      payload: Type.String({ description: "消息内容" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");
      // 识别消息来源：子 Agent 调用时用 taskId，主 Agent 调用时用 "main"
      let fromId = "main";
      if (ctx?.sessionManager) {
        const id = subAgentIdentity.get(ctx.sessionManager);
        if (id) fromId = id;
      }
      const msgId = sendMessage(fromId, params.to, params.type ?? "info", params.payload);
      return {
        content: [{ type: "text", text: `📨 消息已发送 → ${params.to} (id: ${msgId.slice(0, 8)})` }],
        details: { msgId, to: params.to, type: params.type ?? "info" },
      };
    },
  });

  // ==================== control_agent ====================

  pi.registerTool({
    name: "control_agent",
    label: "Control Agent",
    description:
      "控制子 Agent 生命周期：列出、查看状态、注入消息、打断、暂停、恢复、杀死、存档、恢复存档、删除存档。" +
      "支持操作单个 task 或整个 job。",
    promptSnippet: "Manage sub-agent lifecycle (list/status/send/abort/pause/resume/kill/save/load/list_saves/delete_save)",
    promptGuidelines: [
      "Use control_agent to manage running sub-agents spawned by spawn_agent.",
      "Actions: 'list' (list all instances), 'status' (get one instance details),",
      "  'send' (inject message via steer), 'abort' (interrupt but keep alive),",
      "  'pause' (abort + mark paused), 'resume' (continue paused agent),",
      "  'kill' (dispose one agent), 'kill_job' (kill all agents in a job).",
      "  'save' (save agent state to disk), 'list_saves' (list saved agents),",
      "  'delete_save' (delete a saved state).",
      "taskId is required for single-agent actions; omit taskId for job-wide operations.",
      // ── 体验 ──
      "Use 'save' to checkpoint a sub-agent before risky operations. Use 'list_saves' to see available checkpoints.",
      "Use 'list' first to survey. Use 'kill'/'kill_job' to clean up stuck or zombie agents.",
      "FORBIDDEN: Do NOT kill agents silently. Always report to the user what was killed and why.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: list | status | send | abort | pause | resume | kill | kill_job | save | list_saves | delete_save" }),
      jobId: Type.Optional(Type.String({ description: "Job ID" })),
      taskId: Type.Optional(Type.String({ description: "Task ID（单 agent 操作时必填）" })),
      input: Type.Optional(Type.String({ description: "消息内容（send/resume 操作时使用）" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");
      const { action, jobId, taskId, input } = params;

      // ---- list: 列出所有实例 ----
      if (action === "list") {
        const insts = listInstances();
        if (insts.length === 0) {
          return {
            content: [{ type: "text", text: "没有运行中的子 Agent 实例。" }],
            details: { instances: [] },
          };
        }
        const lines = insts.map((inst) => {
          const icon =
            inst.detailedStatus === "thinking" ? "🧠" :
            inst.detailedStatus === "tool_calling" ? "🔧" :
            inst.detailedStatus === "idle" ? "⏳" :
            inst.detailedStatus === "paused" ? "⏸️" :
            inst.detailedStatus === "done" ? "✅" :
            inst.status === "paused" ? "⏸️" : "🟢";
          const extra = inst.currentTool ? ` [${inst.currentTool}]` : "";
          const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
          return `${icon} [${inst.jobId.slice(0, 8)}] ${inst.taskId} — ${inst.name.slice(0, 30)} — ${inst.detailedStatus}${extra} (${elapsed}s)`;
        });
        return {
          content: [{ type: "text", text: `运行中的子 Agent (${insts.length}):\n${lines.join("\n")}` }],
          details: { instances: insts.map((i) => ({ jobId: i.jobId, taskId: i.taskId, name: i.name, status: i.status, detailedStatus: i.detailedStatus, currentTool: i.currentTool })) },
        };
      }

      // ---- status: 查看单个实例（增强：精细状态 + 工具历史） ----
      if (action === "status") {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: "status 操作需要 jobId 和 taskId" }], details: { error: "missing_args" } };
        }
        const inst = getJobInstances(jobId).find((i) => i.taskId === taskId);
        if (!inst) {
          return { content: [{ type: "text", text: `实例不存在: ${jobId}/${taskId}` }], details: { error: "not_found" } };
        }
        const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
        const idleSec = inst.lastActivityAt ? ((Date.now() - inst.lastActivityAt) / 1000).toFixed(0) : "?";

        // 工具历史格式化
        const toolLines = inst.toolHistory.length > 0
          ? ["", "📋 工具调用历史:", ...inst.toolHistory.slice(-10).map((t, i) => {
              const icon = t.status === "started" ? "▶" : t.status === "error" ? "❌" : "✅";
              const dur = t.duration ? ` ${t.duration}ms` : "";
              const err = t.error ? ` (${t.error.slice(0, 60)})` : "";
              return `  ${icon} ${t.toolName} [${t.status}]${dur}${err}`;
            })]
          : [];

        const lines = [
          `📊 ${inst.name}`,
          `   Job: ${inst.jobId.slice(0, 8)} | Task: ${inst.taskId}`,
          `   精细状态: ${inst.detailedStatus}${inst.currentTool ? ` (${inst.currentTool})` : ""} | 传统: ${inst.status} | 运行: ${elapsed}s | 空闲: ${idleSec}s`,
          `   输入: ${inst.promptLength}字 | 输出: ${inst.outputLength}字 | 自动续推: ${inst.autoContinue ? "✅" : "❌"}(${inst.autoContinueDelay}s)`,
          ...toolLines,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            jobId: inst.jobId, taskId: inst.taskId, name: inst.name,
            status: inst.status, detailedStatus: inst.detailedStatus,
            currentTool: inst.currentTool, elapsed, idleSec,
            promptLength: inst.promptLength, outputLength: inst.outputLength,
            autoContinue: inst.autoContinue, toolHistory: inst.toolHistory.slice(-10),
          },
        };
      }

      // ---- 需要 jobId + taskId 的操作 ----
      if (["send", "abort", "pause", "resume", "kill", "save"].includes(action)) {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: `${action} 操作需要 jobId 和 taskId` }], details: { error: "missing_args" } };
        }
      }

      switch (action) {
        case "kill_job": {
          if (!jobId) {
            return { content: [{ type: "text", text: "kill_job 需要 jobId" }], details: { error: "missing_args" } };
          }
          const count = await killJob(jobId);
          ctx.ui.notify(`💀 已杀死 ${count} 个子 Agent`, "warn");
          return {
            content: [{ type: "text", text: `💀 Job ${jobId.slice(0, 8)}: 已杀死 ${count} 个子 Agent` }],
            details: { action: "kill_job", jobId, killed: count },
          };
        }

        case "kill": {
          const ok = await killAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `💀 已杀死 ${taskId}` : `❌ 杀死失败: ${taskId}`, ok ? "warn" : "error");
          return {
            content: [{ type: "text", text: ok ? `💀 已杀死子 Agent: ${taskId}` : `❌ 无法杀死: ${taskId}` }],
            details: { action: "kill", jobId, taskId, ok },
          };
        }

        case "abort": {
          const ok = await abortAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `⏹ 已打断 ${taskId}` : `❌ 打断失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `⏹ 已打断子 Agent: ${taskId}（未销毁，可 resume）` : `❌ 无法打断: ${taskId}` }],
            details: { action: "abort", jobId, taskId, ok },
          };
        }

        case "pause": {
          const ok = await pauseAgent(jobId!, taskId!);
          ctx.ui.notify(ok ? `⏸️ 已暂停 ${taskId}` : `❌ 暂停失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `⏸️ 已暂停子 Agent: ${taskId}\n使用 control_agent({ action: "resume", ... }) 恢复。` : `❌ 无法暂停: ${taskId}` }],
            details: { action: "pause", jobId, taskId, ok },
          };
        }

        case "resume": {
          const resumeText = input;
          const ok = await resumeAgent(jobId!, taskId!, resumeText);
          ctx.ui.notify(ok ? `▶️ 已恢复 ${taskId}` : `❌ 恢复失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `▶️ 已恢复子 Agent: ${taskId}${resumeText ? ` (提示: "${resumeText.slice(0, 50)}")` : ""}` : `❌ 无法恢复: ${taskId}（可能不是 paused 状态）` }],
            details: { action: "resume", jobId, taskId, ok },
          };
        }

        case "send": {
          if (!input) {
            return { content: [{ type: "text", text: "send 操作需要 input 参数" }], details: { error: "missing_input" } };
          }
          const ok = await sendAgentInput(jobId!, taskId!, input);
          ctx.ui.notify(ok ? `📨 已注入: ${input.slice(0, 40)}` : `❌ 注入失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `📨 已向 ${taskId} 注入消息: "${input.slice(0, 100)}"` : `❌ 无法发送: ${taskId}` }],
            details: { action: "send", jobId, taskId, ok },
          };
        }

        case "save": {
          const saved = saveAgentState(jobId!, taskId!);
          ctx.ui.notify(saved ? `💾 已存档: ${taskId}` : `❌ 存档失败: ${taskId}`, saved ? "info" : "error");
          return {
            content: [{ type: "text", text: saved ? `💾 子 Agent 已存档: **${saved.name}**\n   saveId: \`${saved.saveId}\`\n   模型: ${saved.model}\n   消息数: ${saved.messages.length}\n   使用 \`spawn_agent({ resumeFrom: "${saved.saveId}" })\` 恢复。` : `❌ 存档失败: ${taskId}（实例可能已结束）` }],
            details: { action: "save", jobId, taskId, ok: !!saved, saveId: saved?.saveId },
          };
        }

        case "list_saves": {
          const saves = listAgentSaves();
          if (saves.length === 0) {
            return { content: [{ type: "text", text: "没有存档的子 Agent。" }], details: { saves: [] } };
          }
          const lines = saves.map((s) => {
            const age = ((Date.now() - s.savedAt) / 1000 / 60).toFixed(0);
            return `  💾 \`${s.saveId}\` — ${s.name.slice(0, 30)} — ${s.model} — ${s.messages.length} 消息 — ${age}分钟前`;
          });
          return {
            content: [{ type: "text", text: `存档列表 (${saves.length}):\n${lines.join("\n")}` }],
            details: { saves: saves.map((s) => ({ saveId: s.saveId, name: s.name, model: s.model, messageCount: s.messages.length, savedAt: s.savedAt })) },
          };
        }

        case "delete_save": {
          if (!taskId) {
            return { content: [{ type: "text", text: "delete_save 需要 taskId（作为 saveId）" }], details: { error: "missing_args" } };
          }
          const ok = deleteAgentSave(taskId);
          ctx.ui.notify(ok ? `🗑 已删除存档: ${taskId}` : `❌ 删除失败: ${taskId}`, ok ? "info" : "error");
          return {
            content: [{ type: "text", text: ok ? `🗑 已删除存档: \`${taskId}\`` : `❌ 存档不存在: \`${taskId}\`` }],
            details: { action: "delete_save", saveId: taskId, ok },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: list | status | send | abort | pause | resume | kill | kill_job | save | list_saves | delete_save` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });

  // ==================== manage_skills ====================

  pi.registerTool({
    name: "manage_skills",
    label: "Manage Skills",
    description:
      "管理 skill 黑名单。黑名单中的 skill 完全不会注入子进程。" +
      "支持添加/移除/列出/覆盖黑名单。修改立即生效，无需 /reload。",
    promptSnippet: "Manage skill blacklist (add/remove/list/set)",
    promptGuidelines: [
      "Use manage_skills to control which skills are banned from sub-agent injection.",
      "Blacklisted skills are completely hidden — no content injected, not even description.",
      "Changes take effect immediately, no /reload needed.",
      "Use 'list' to see current blacklist. Use 'add'/'remove' for incremental changes.",
      "Use 'set' to replace the entire blacklist at once.",
      // ── 体验 ──
      "Prefer 'add'/'remove' for individual changes. Use 'set' only when redefining from a known baseline.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "操作: blacklist_add | blacklist_remove | blacklist_list | blacklist_set",
      }),
      skills: Type.Optional(Type.Array(Type.String(), {
        description: "skill 名称列表（blacklist_add/remove/set 时必填）",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");

      const { action, skills } = params;

      // 读取当前配置
      const settingsPath_ = settingsPath();
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(readFileSync(settingsPath_, "utf-8"));
      } catch {
        // settings.json 可能不存在或空，用空对象
      }

      // 确保 skills 段存在
      const section = (raw.skills || {}) as Record<string, unknown>;
      const currentList: string[] = Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [];

      switch (action) {
        case "blacklist_list": {
          if (currentList.length === 0) {
            ctx.ui.notify("📋 黑名单为空，所有 skill 可正常注入", "info");
            return {
              content: [{ type: "text", text: "📋 当前 blacklist 为空。" }],
              details: { action, blacklist: [] },
            };
          }
          const lines = currentList.map((s) => `  🔴 ${s}`);
          ctx.ui.notify(`📋 黑名单共 ${currentList.length} 条`, "info");
          return {
            content: [{ type: "text", text: `📋 当前 blacklist (${currentList.length}):\n${lines.join("\n")}` }],
            details: { action, blacklist: currentList },
          };
        }

        case "blacklist_add": {
          if (!skills || skills.length === 0) {
            return { content: [{ type: "text", text: "blacklist_add 需要 skills 参数" }], details: { error: "missing_skills" } };
          }
          const toAdd = skills.filter((s) => typeof s === "string" && !currentList.includes(s));
          if (toAdd.length === 0) {
            ctx.ui.notify("⚠️ 所有 skill 已在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 skill 已在黑名单中，无需重复添加。" }],
              details: { action, added: [], blacklist: currentList },
            };
          }
          const newList = [...currentList, ...toAdd];
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🔴 已添加 ${toAdd.length} 个 skill 到黑名单`, "warn");
          return {
            content: [{
              type: "text",
              text: `🔴 已添加 ${toAdd.length} 个 skill 到黑名单:\n${toAdd.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.map((s) => `  🔴 ${s}`).join("\n")}`,
            }],
            details: { action, added: toAdd, blacklist: newList },
          };
        }

        case "blacklist_remove": {
          if (!skills || skills.length === 0) {
            return { content: [{ type: "text", text: "blacklist_remove 需要 skills 参数" }], details: { error: "missing_skills" } };
          }
          const toRemove = skills.filter((s) => currentList.includes(s));
          if (toRemove.length === 0) {
            ctx.ui.notify("⚠️ 指定 skill 不在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 skill 不在黑名单中，无需移除。" }],
              details: { action, removed: [], blacklist: currentList },
            };
          }
          const newList = currentList.filter((s) => !toRemove.includes(s));
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🟢 已从黑名单移除 ${toRemove.length} 个 skill`, "info");
          return {
            content: [{
              type: "text",
              text: `🟢 已从黑名单移除 ${toRemove.length} 个 skill:\n${toRemove.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.length > 0 ? newList.map((s) => `  🔴 ${s}`).join("\n") : "  (空)"}`,
            }],
            details: { action, removed: toRemove, blacklist: newList },
          };
        }

        case "blacklist_set": {
          if (!skills) {
            return { content: [{ type: "text", text: "blacklist_set 需要 skills 参数（传空数组 = 清空）" }], details: { error: "missing_skills" } };
          }
          const newList = skills.filter((s) => typeof s === "string");
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(newList.length > 0 ? `🔴 已覆盖黑名单: ${newList.length} 条` : "🟢 已清空黑名单", newList.length > 0 ? "warn" : "info");
          return {
            content: [{
              type: "text",
              text: newList.length > 0
                ? `🔴 已覆盖黑名单 (${newList.length}):\n${newList.map((s) => `  • ${s}`).join("\n")}`
                : "🟢 黑名单已清空，所有 skill 可正常注入。",
            }],
            details: { action, blacklist: newList },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: blacklist_add | blacklist_remove | blacklist_list | blacklist_set` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });

  // ==================== manage_tools ====================

  pi.registerTool({
    name: "manage_tools",
    label: "Manage Tools",
    description:
      "管理 tool 黑名单。黑名单中的 tool 不会注册到子进程会话，" +
      "子进程完全不知道该 tool 的存在（无注册指令、无说明内容）。" +
      "修改立即生效，无需 /reload。\n\n",
    promptSnippet: "Manage tool blacklist for sub-agents (add/remove/list/set)",
    promptGuidelines: [
      "Use manage_tools to control which tools are banned from sub-agent sessions.",
      "Blacklisted tools are completely hidden from sub-agents:",
      "  1) Not registered in sub-agent session → cannot be called",
      "  2) No description/promptGuidelines injected → agent doesn't know it exists",
      
      "Changes take effect immediately, no /reload needed.",
      "Use 'list' to see current config blacklist. Use 'add'/'remove' for incremental changes.",
      // ── 体验 ──
      "Recommended defaults: switch_model, manage_plan, manage_skills, manage_tools",
      "These are management tools that sub-agents should not have access to.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "操作: blacklist_add | blacklist_remove | blacklist_list | blacklist_set",
      }),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "tool 名称列表（blacklist_add/remove/set 时必填）",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");

      const { action, tools } = params;

      const settingsPath_ = settingsPath();
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(readFileSync(settingsPath_, "utf-8"));
      } catch { /* 空对象兜底 */ }

      const section = (raw.tools || {}) as Record<string, unknown>;
      const currentList: string[] = Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [];

      switch (action) {
        case "blacklist_list": {
          if (currentList.length === 0) {
            ctx.ui.notify("📋 tool 黑名单为空（安全网仍生效）", "info");
            return {
              content: [{ type: "text", text: "📋 当前 tool blacklist 为空。\n安全网（始终阻塞）: spawn_agent, check_agent_results, control_agent" }],
              details: { action, blacklist: [], safetyNet: ["spawn_agent", "check_agent_results", "control_agent"] },
            };
          }
          const lines = currentList.map((s) => `  🔴 ${s}`);
          ctx.ui.notify(`📋 tool 黑名单共 ${currentList.length} 条`, "info");
          return {
            content: [{ type: "text", text: `📋 当前 tool blacklist (${currentList.length}):\n${lines.join("\n")}\n\n安全网（始终阻塞）: spawn_agent, check_agent_results, control_agent` }],
            details: { action, blacklist: currentList, safetyNet: ["spawn_agent", "check_agent_results", "control_agent"] },
          };
        }

        case "blacklist_add": {
          if (!tools || tools.length === 0) {
            return { content: [{ type: "text", text: "blacklist_add 需要 tools 参数" }], details: { error: "missing_tools" } };
          }
          const toAdd = tools.filter((s) => typeof s === "string" && !currentList.includes(s));
          if (toAdd.length === 0) {
            ctx.ui.notify("⚠️ 所有 tool 已在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 tool 已在黑名单中，无需重复添加。" }],
              details: { action, added: [], blacklist: currentList },
            };
          }
          const newList = [...currentList, ...toAdd];
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🔴 已添加 ${toAdd.length} 个 tool 到黑名单`, "warn");
          return {
            content: [{ type: "text", text: `🔴 已添加 ${toAdd.length} 个 tool 到黑名单:\n${toAdd.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.map((s) => `  🔴 ${s}`).join("\n")}` }],
            details: { action, added: toAdd, blacklist: newList },
          };
        }

        case "blacklist_remove": {
          if (!tools || tools.length === 0) {
            return { content: [{ type: "text", text: "blacklist_remove 需要 tools 参数" }], details: { error: "missing_tools" } };
          }
          const toRemove = tools.filter((s) => currentList.includes(s));
          if (toRemove.length === 0) {
            ctx.ui.notify("⚠️ 指定 tool 不在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 tool 不在黑名单中，无需移除。" }],
              details: { action, removed: [], blacklist: currentList },
            };
          }
          const newList = currentList.filter((s) => !toRemove.includes(s));
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🟢 已从黑名单移除 ${toRemove.length} 个 tool`, "info");
          return {
            content: [{ type: "text", text: `🟢 已从黑名单移除 ${toRemove.length} 个 tool:\n${toRemove.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.length > 0 ? newList.map((s) => `  🔴 ${s}`).join("\n") : "  (空)"}` }],
            details: { action, removed: toRemove, blacklist: newList },
          };
        }

        case "blacklist_set": {
          if (!tools) {
            return { content: [{ type: "text", text: "blacklist_set 需要 tools 参数（传空数组 = 清空）" }], details: { error: "missing_tools" } };
          }
          const newList = tools.filter((s) => typeof s === "string");
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(newList.length > 0 ? `🔴 已覆盖 tool 黑名单: ${newList.length} 条` : "🟢 已清空 tool 黑名单", newList.length > 0 ? "warn" : "info");
          return {
            content: [{ type: "text", text: newList.length > 0
              ? `🔴 已覆盖 tool 黑名单 (${newList.length}):\n${newList.map((s) => `  • ${s}`).join("\n")}`
              : "🟢 tool 黑名单已清空（安全网仍生效）。" }],
            details: { action, blacklist: newList },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: blacklist_add | blacklist_remove | blacklist_list | blacklist_set` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });
}

// ---- 格式化输出 ----

function formatJobResult(job: AgentJob, elapsed: string) {
  const okCount = job.results.filter((r) => r.ok).length;
  const failCount = job.results.filter((r) => !r.ok).length;

  const statusText =
    job.status === "complete" ? "✅ 完成" :
    job.status === "killed" ? "💀 已杀死" :
    "❌ 错误";

  const header = [
    `${statusText} Job ${job.jobId.slice(0, 8)}`,
    `⏱ 耗时: ${elapsed}s | ✅ ${okCount} | ❌ ${failCount} | 📊 ${job.total}`,
    ``,
  ];

  const body = job.results.map((r) => {
    const icon = r.ok ? "✅" : "❌";
    const text = r.ok
      ? (r.output ?? "").slice(0, 500)
      : `错误: ${r.error ?? "未知"}`;
    return `${icon} [${r.order}/${job.total}] ${r.name}\n   ${text}\n`;
  });

  return {
    content: [{ type: "text", text: [...header, ...body].join("\n") }],
    details: {
      jobId: job.jobId,
      status: job.status,
      elapsed,
      okCount,
      failCount,
      total: job.total,
      results: job.results.map((r) => ({
        id: r.id,
        name: r.name,
        ok: r.ok,
        output: r.output?.slice(0, 500),
        error: r.error,
      })),
    },
  };
}
