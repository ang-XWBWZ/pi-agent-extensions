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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  pi.on("context", (_event, _ctx) => {
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
    _event.messages.push({
      role: "user",
      content: parts.join("\n"),
    } as any);
  });

  // ---- 子 Agent 状态面板 Widget ----
  setupWidget(pi);

  // ---- 工具注册 ----
  registerSpawnAgent(pi);
  registerCheckResults(pi);
  registerSendMessage(pi);
  registerControlAgent(pi);
  registerManageSkills(pi);
  registerManageTools(pi);
}
