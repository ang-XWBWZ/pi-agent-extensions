/**
 * send-message.ts — send_agent_message 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sendMessage } from "../../lib/agent-bus.js";
import { subAgentIdentity } from "../lib/helpers.js";

export function registerSendMessage(pi: ExtensionAPI): void {
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
      "Use 'broadcast' for coordination signals (e.g. 'pause all', 'update context'). Use taskId for targeted instructions.",
      "FORBIDDEN: Do NOT expect a reply or block waiting for one. Messages are strictly one-way.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "目标: 'broadcast' | jobId | taskId" }),
      type: Type.Optional(StringEnum(["info", "request", "response", "error"] as const)),
      payload: Type.String({ description: "消息内容" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");
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
}
