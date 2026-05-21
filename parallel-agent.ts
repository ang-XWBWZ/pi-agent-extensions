/**
 * parallel-agent.ts — 子 Agent 系统 v6
 *
 * 工具:
 *   spawn_agent          — 并行派发子 Agent，立即返回 jobId，后台运行
 *   check_agent_results  — 查询/等待子 Agent 结果
 *   send_agent_message   — Agent 间消息传递
 *   control_agent        — 子 Agent 完整生命周期控制
 *
 * v6 改进:
 *   - 完整生命周期：kill / abort / send / pause / resume / list / status
 *   - 子 Agent 注册到 AgentBus，外部可控制
 *   - session.steer() 实现运行时消息注入
 *   - pause = abort 不 dispose；resume = sendUserMessage("继续")
 *   - kill = abort + dispose + 标记失败
 * v7 改进:
 *   - spawn_agent 支持 autoInject（默认 true）：子任务完成时自动推送结果到主对话
 *   - 主 Agent 不再需要阻塞式 check_agent_results(wait=true)，完成即通知
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createJob,
  publishTaskResult,
  publishJobError,
  getJob,
  listJobs,
  listInstances,
  waitForJob,
  onJobComplete,
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
  getAgentBus,
  Events,
  updateInstanceStatus,
  saveAgentState,
  loadAgentState,
  deleteAgentSave,
  listAgentSaves,
  type SubTask,
  type SubResult,
  type AgentJob,
  type AgentInstance,
  type AgentSaveState,
} from "./lib/agent-bus.js";

// ---- helpers ----

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
    } catch { /* try next */ }
  }
  return `\n[无法加载 skill: ${name}]`;
}

// ---- Token 估算（匹配系统启发式） ----
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
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
): Promise<SubResult> {
  const name =
    task.prompt.slice(0, 20).replace(/\n/g, " ").trim() || task.id;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: SubResult) => {
      if (settled) return;
      settled = true;
      try { unregisterInstance(jobId, task.id); } catch (e) { console.warn("[parallel-agent] unregisterInstance 失败:", e); }
      resolve(result);
    };

    // 异步执行体：避免 async Promise executor 反模式
    (async () => {
      try {
      // 上下文 + skill 注入
      let extra = "";
      if (task.context?.length) extra += await loadContext(task.context, cwd);
      if (task.skills?.length) {
        for (const s of task.skills) extra += await loadSkill(s);
      }
      const prompt = extra
        ? `${task.prompt}\n\n[注入上下文]\n${extra}`
        : task.prompt;

      // ---- 串行化 globalThis 写入（Promise 链替代 InitLock） ----
      sessionChain = sessionChain.then(async () => {
        (globalThis as Record<string, unknown>).__pi_default_mode =
          task.mode || "plan";
        (globalThis as Record<string, unknown>).__pi_is_sub_agent = true;

        try {
          const sm = SessionManager.inMemory();
          const created = await createAgentSession({
            sessionManager: sm,
            modelRegistry,
            model: subModel,
            cwd,
          });
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
      const instRef: AgentInstance = {
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
        inputTokens: estimateTokens(prompt),
        outputTokens: 0,
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
          if (instRef.autoContinue && !settled) {
            autoContinueTimer = setTimeout(() => {
              if (!settled) {
                try { session.steer("继续执行未完成的任务。"); } catch { /* ignore */ }
              }
            }, instRef.autoContinueDelay * 1000);
          }
        }, 5000);
        instRef._idleTimer = idleTimer;
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          abortedExternally = false;
          try { unsub(); } catch (e) { console.warn("[parallel-agent] unsub 失败:", e); }
          try { session.abort(); } catch (e) { console.warn("[parallel-agent] session.abort 失败:", e); }
          try { session.dispose(); } catch (e) { console.warn("[parallel-agent] session.dispose 失败:", e); }
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
      resetTimer();

      const unsub = session.subscribe((event) => {
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
        // ---- agent end → done ----
        if (event.type === "agent_end") {
          clearIdle();
          updateInstanceStatus(jobId, task.id, { detailedStatus: "done" });
          // 捕获消息快照 + 自动存档
          try {
            instRef._savedMessages = session.state.messages;
            saveAgentState(jobId, task.id);
          } catch { /* */ }
          if (abortedExternally) {
            abortedExternally = false;
            return;
          }
          unsub();
          if (timer) clearTimeout(timer);
          session.dispose();
          finish({
            id: task.id,
            name,
            order,
            ok: true,
            output: output.trim() || "(无输出)",
          });
        }
      });

      // 启动子 Agent
      await session.prompt(prompt);
      } catch (err: unknown) {
        finish({
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

// ---- 后台批量启动（fire-and-forget） ----

function spawnAllBackground(
  jobId: string,
  tasks: SubTask[],
  cwd: string,
  defaultModel: Model<any> | undefined,
  modelRegistry: ModelRegistry,
  deadline: number,
  pi: ExtensionAPI,
): void {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    let subModel: Model<any> | undefined = defaultModel;
    if (task.model) {
      const [p, m] = task.model.split("/");
      const found = modelRegistry.find(p, m);
      if (found) {
        subModel = found;
      } else {
        console.warn(`[parallel-agent] 模型 ${task.model} 未找到，降价使用默认模型`);
        subModel = defaultModel;
      }
    }

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

    // 定时刷新（兜底 outputLength 更新）
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    widgetRefreshTimer = setInterval(refreshWidget, 1500);

    ctx.ui.setWidget("sub-agents", (tui, theme) => {
      widgetTui = tui;
      return {
        render: () => {
          const insts = listInstances();
          if (insts.length === 0) return [];

          const lines: string[] = [];
          lines.push(theme.fg("accent", theme.bold(`🤖 子 Agent (${insts.length})`)));

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
            const tokIn = inst.inputTokens > 1000
              ? `${(inst.inputTokens / 1000).toFixed(1)}k`
              : String(inst.inputTokens);
            const tokOut = inst.outputTokens > 1000
              ? `${(inst.outputTokens / 1000).toFixed(1)}k`
              : String(inst.outputTokens);
            const title = inst.name.length > 20
              ? inst.name.slice(0, 20) + "…"
              : inst.name;
            const modelShort = inst.model || "?";
            const modelTag = modelShort.length > 30
              ? modelShort.slice(0, 30) + "…"
              : modelShort;

            lines.push(
              `  ${statusIcon} ${theme.fg("accent", inst.taskId)} ${theme.fg("muted", title)}  ${theme.fg("dim", modelTag)}  ${theme.fg("dim", `↑${tokIn} ↓${tokOut}  ${elapsed}s  ${statusText}`)}`,
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

      spawnAllBackground(
        job.jobId,
        resolvedTasks,
        ctx.cwd,
        defaultModel,
        ctx.modelRegistry,
        deadline,
        pi,
      );

      // ---- 自动结果注入：完成时推送结果到主对话（不阻塞） ----
      if (autoInject) {
        onJobComplete(job.jobId, (completedJob) => {
          if (completedJob._autoInjected) return;
          completedJob._autoInjected = true;
          const elapsed = completedJob.finishedAt
            ? ((completedJob.finishedAt - completedJob.createdAt) / 1000).toFixed(1)
            : "?";
          const okCount = completedJob.results.filter((r) => r.ok).length;
          const failCount = completedJob.results.filter((r) => !r.ok).length;

          const lines = [
            `🤖 [子任务完成] Job \`${job.jobId.slice(0, 8)}\` — ✅ ${okCount} / ❌ ${failCount} / 📊 ${total} (${elapsed}s)`,
            "",
            ...completedJob.results.map((r) => {
              const icon = r.ok ? "✅" : "❌";
              const text = r.ok
                ? (r.output ?? "").slice(0, 500)
                : `错误: ${r.error ?? "未知"}`;
              return `${icon} [${r.order}/${total}] **${r.name}**\n\`\`\`\n${text}\n\`\`\`\n`;
            }),
          ];

          pi.sendUserMessage(lines.join("\n"), {
            deliverAs: "steer",
            triggerTurn: true,
          });
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
                `使用 check_agent_results("${params.jobId}", true) 阻塞等待全部完成。`,
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // AbortSignal: 操作前检查
      if (signal?.aborted) throw new Error("操作已取消");
      const msgId = sendMessage("main", params.to, params.type ?? "info", params.payload);
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
