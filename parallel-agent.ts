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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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
  type SubTask,
  type SubResult,
  type AgentJob,
  type AgentInstance,
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
  authStorage: AuthStorage,
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
            authStorage,
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

      // ---- 注册实例（记录输入长度供 widget 显示） ----
      const instRef: AgentInstance = {
        jobId,
        taskId: task.id,
        name,
        session,
        status: "running",
        startedAt: Date.now(),
        promptLength: prompt.length,
        outputLength: 0,
        _abortExternally: () => { abortedExternally = true; },
        _resetTimer: () => {},
      };
      registerInstance(instRef);

      // ---- 输出收集 ----
      let output = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

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
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            output += event.assistantMessageEvent.delta;
            instRef.outputLength = output.length;
            if (output.length > 10_000)
              output = output.slice(0, 10_000) + "\n...";
          }
        }
        if (event.type === "agent_end") {
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
  authStorage: AuthStorage,
  deadline: number,
  pi: ExtensionAPI,
): void {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    let subModel: Model<any> | undefined = defaultModel;
    if (task.model) {
      const [p, m] = task.model.split("/");
      subModel = modelRegistry.find(p, m) ?? defaultModel;
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
      authStorage,
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
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

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
            const icon =
              inst.status === "running" ? "🟢" :
              inst.status === "paused" ? "⏸️" : "⏳";
            const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(0);
            const inLen = inst.promptLength > 1000
              ? `${(inst.promptLength / 1000).toFixed(1)}k`
              : String(inst.promptLength);
            const outLen = inst.outputLength > 1000
              ? `${(inst.outputLength / 1000).toFixed(1)}k`
              : String(inst.outputLength);
            const title = inst.name.length > 25
              ? inst.name.slice(0, 25) + "…"
              : inst.name;

            lines.push(
              `  ${icon} ${theme.fg("muted", title)}  ${theme.fg("dim", `入${inLen}字 → 出${outLen}字  ${elapsed}s`)}`,
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

      const job = createJob(params.tasks);
      job.status = "running";

      try {
        pi.appendEntry("agent-job", {
          jobId: job.jobId,
          total,
          tasks: params.tasks.map((t) => ({ id: t.id, prompt: t.prompt.slice(0, 80) })),
          createdAt: job.createdAt,
          status: "running",
        });
      } catch { /* */ }

      spawnAllBackground(
        job.jobId,
        params.tasks as SubTask[],
        ctx.cwd,
        defaultModel,
        modelRegistry,
        authStorage,
        deadline,
        pi,
      );

      // ---- 自动结果注入：完成时推送结果到主对话（不阻塞） ----
      if (autoInject) {
        onJobComplete(job.jobId, (completedJob) => {
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
      "控制子 Agent 生命周期：列出、查看状态、注入消息、打断、暂停、恢复、杀死。" +
      "支持操作单个 task 或整个 job。",
    promptSnippet: "Manage sub-agent lifecycle (list/status/send/abort/pause/resume/kill)",
    promptGuidelines: [
      "Use control_agent to manage running sub-agents spawned by spawn_agent.",
      "Actions: 'list' (list all instances), 'status' (get one instance details),",
      "  'send' (inject message via steer), 'abort' (interrupt but keep alive),",
      "  'pause' (abort + mark paused), 'resume' (continue paused agent),",
      "  'kill' (dispose one agent), 'kill_job' (kill all agents in a job).",
      "taskId is required for single-agent actions; omit taskId for job-wide operations.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "操作: list | status | send | abort | pause | resume | kill | kill_job" }),
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
          const icon = inst.status === "running" ? "🟢" : inst.status === "paused" ? "⏸️" : "⏳";
          const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
          return `${icon} [${inst.jobId.slice(0, 8)}] ${inst.taskId} — ${inst.name.slice(0, 30)} — ${inst.status} (${elapsed}s)`;
        });
        return {
          content: [{ type: "text", text: `运行中的子 Agent (${insts.length}):\n${lines.join("\n")}` }],
          details: { instances: insts.map((i) => ({ jobId: i.jobId, taskId: i.taskId, name: i.name, status: i.status })) },
        };
      }

      // ---- status: 查看单个实例 ----
      if (action === "status") {
        if (!jobId || !taskId) {
          return { content: [{ type: "text", text: "status 操作需要 jobId 和 taskId" }], details: { error: "missing_args" } };
        }
        const inst = getJobInstances(jobId).find((i) => i.taskId === taskId);
        if (!inst) {
          return { content: [{ type: "text", text: `实例不存在: ${jobId}/${taskId}` }], details: { error: "not_found" } };
        }
        const elapsed = ((Date.now() - inst.startedAt) / 1000).toFixed(1);
        return {
          content: [
            {
              type: "text",
              text: [
                `📊 ${inst.name}`,
                `   Job: ${inst.jobId.slice(0, 8)} | Task: ${inst.taskId}`,
                `   状态: ${inst.status} | 运行: ${elapsed}s`,
              ].join("\n"),
            },
          ],
          details: { jobId: inst.jobId, taskId: inst.taskId, name: inst.name, status: inst.status, elapsed },
        };
      }

      // ---- 需要 jobId + taskId 的操作 ----
      if (["send", "abort", "pause", "resume", "kill"].includes(action)) {
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

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: list | status | send | abort | pause | resume | kill | kill_job` }],
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
