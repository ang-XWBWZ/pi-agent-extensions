/**
 * parallel-agent.ts — 子 Agent 系统 v10
 *
 * 工具:
 *   spawn_agent          — 并行派发子 Agent，立即返回 jobId，后台运行
 *   check_agent_results  — 查询/等待子 Agent 结果
 *   send_agent_message   — Agent 间消息传递
 *   control_agent        — 子 Agent 完整生命周期控制
 *   update_agent_task    — 子 Agent 专属任务面板与增量备注
 *   read_agent_output    — 按需分页读取子 Agent 原始输出
 *
 * v10 改进:
 *   - 模型分级联动：task 支持 tier (L0/L1/L2) 自动选模型 + 思考深度
 *   - 思考深度传递：task.thinkingLevel 覆盖层级默认值
 *   - 优先级链：task.model > task.tier + thinkingLevel > 主 Agent 模型
 *   - 超时前保存会话、输出快照与任务面板，返回可恢复 saveId
 *   - 每个子任务拥有独立面板、进度、阶段结论、可选详细说明和追加式备注
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCapability } from "./lib/capability-router.js";
import {
  onMessage,
  registerFrontendProcessor,
} from "./lib/agent-bus.js";
import { setupWidget } from "./parallel-agent/lib/widget.js";
import { registerSpawnAgent } from "./parallel-agent/tools/spawn-agent.js";
import { registerCheckResults } from "./parallel-agent/tools/check-results.js";
import { registerSendMessage } from "./parallel-agent/tools/send-message.js";
import { registerControlAgent } from "./parallel-agent/tools/control-agent.js";
import { registerManageSkills } from "./parallel-agent/tools/manage-skills.js";
import { registerManageTools } from "./parallel-agent/tools/manage-tools.js";
import { registerUpdateAgentTask } from "./parallel-agent/tools/update-task.js";
import { registerReadAgentOutput } from "./parallel-agent/tools/read-output.js";

export default function (pi: ExtensionAPI) {
  registerCapability({
    id: "parallel_agent",
    name: "Parallel Agent Subsystem",
    summary: "Spawn/manage background sub-agents for parallel code exploration and task delegation.",
    keywords: ["subagent", "parallel", "spawn_agent", "background agent", "worker", "delegation"],
    phases: ["work"],
    tools: [
      "spawn_agent",
      "check_agent_results",
      "send_agent_message",
      "control_agent",
      "update_agent_task",
      "read_agent_output",
      "manage_skills",
      "manage_tools",
    ],
    toolDescriptions: {
      spawn_agent: "并行派发后台子 Agent 执行探索、调研或独立验证任务，返回 jobId",
      check_agent_results: "轮询或阻塞等待子 Agent 执行结果，支持结果自动注入主上下文",
      send_agent_message: "向指定运行中的子 Agent 点对点发送通信消息或广播指令",
      control_agent: "子 Agent 完整生命周期控制（列出/状态/暂停/恢复/终止/保存/加载）",
      update_agent_task: "更新子任务进度面板、单调递增进度、阶段性结论与备忘录",
      read_agent_output: "分页按需读取子任务原始日志输出字节，避免上下文污染",
      manage_skills: "管理子任务可用的 Skill 技能黑白名单",
      manage_tools: "管理子任务可用的 Tool 工具黑白名单",
    },
    usageDoc: `# Parallel Agent Subsystem (parallel_agent)

### Available Tools:
- \`spawn_agent(tasks)\`: Spawns sub-agents to explore code or run analysis in parallel in the background. Returns jobId.
- \`check_agent_results(jobId?, wait?, timeout?)\`: Non-blocking or blocking poll for sub-agent results. Completed results auto-inject into context.
- \`send_agent_message(to, payload, type?)\`: Point-to-point or broadcast message delivery to running sub-agents.
- \`control_agent(action, jobId?, taskId?, ...)\`: Manage sub-agent lifecycle (list, status, pause, resume, abort, kill, save, load).
- \`update_agent_task(...)\`: Update sub-agent task panel with monotonic progress, conclusions, and notes.
- \`read_agent_output(jobId, taskId, cursor?, maxBytes?)\`: Paged byte-slice read of raw sub-agent logs without polluting context.
- \`manage_skills(action, skills?)\`: Manage sub-agent skill blacklist.
- \`manage_tools(action, tools?)\`: Manage sub-agent tool blacklist.

### Critical Guidelines:
1. Use spawn_agent only for bounded independent work that benefits from concurrency or second-pass review.
2. In PLAN phase, every task must explicitly use phase="plan" or "chat".
3. Give each sub-agent a concrete goal, scope, allowed/forbidden tools, expected output, and stop condition.
4. Completed results are auto-injected; avoid polling in a busy loop when wait=false is sufficient.
5. Use read_agent_output only when summary evidence is missing; never dump full archives into context.`,
  });
  // SDK 子 Agent 没有交互式 UI。若仍注册这个全局 widget，它们会驱动
  // 父会话的 TUI 重绘，并在销毁时清掉父会话的 TUI 引用。
  const suppressSubAgentWidget =
    (globalThis as Record<string, unknown>)
      .__pi_parallel_agent_suppress_widget === true;

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

  // ---- context 事件注入待收消息 + steer 消息 ----
  pi.on("context", (event, _ctx) => {
    const steerQ = (globalThis as Record<string, unknown>)[STEER_KEY] as string[];
    const hasSteer = steerQ && steerQ.length > 0;
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
    return {
      messages: [
        ...event.messages,
        {
          role: "user",
          content: parts.join("\n"),
        } as any,
      ],
    };
  });

  // ---- 子 Agent 状态面板 Widget ----
  if (!suppressSubAgentWidget) setupWidget(pi);

  // ---- 工具注册 ----
  registerUpdateAgentTask(pi);
  registerSpawnAgent(pi);
  registerCheckResults(pi);
  registerReadAgentOutput(pi);
  registerSendMessage(pi);
  registerControlAgent(pi);
  registerManageSkills(pi);
  registerManageTools(pi);
}
