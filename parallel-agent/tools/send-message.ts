/**
 * send-message.ts — send_agent_message 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sendMessage } from "../../lib/agent-bus.js";
import { isToolResultError, renderStructuredToolCall, renderToolResult } from "../../lib/tui-render.js";
import { subAgentIdentity } from "../lib/helpers.js";

export function registerSendMessage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description:
      "向子 Agent 或其他 Agent 发送消息。支持广播 (to='broadcast') 和点对点通信。",
    promptSnippet: "Send messages between agents via the AgentBus",
    promptGuidelines: [
      "Use send_agent_message for one-way coordination with running Agents; target a task unless a broadcast is necessary.",
      "send_agent_message is fire-and-forget; use check_agent_results for results instead of waiting for a reply.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "目标: 'broadcast' | jobId | taskId" }),
      type: Type.Optional(StringEnum(["info", "request", "response", "error"] as const)),
      payload: Type.String({ description: "消息内容" }),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "send_agent_message", [
        { name: "to", value: args.to, tone: "accent" },
        { name: "type", value: args.type, tone: "warning" },
        { name: "payload", value: args.payload, maxLength: 160 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 4,
        isError: isToolResultError(result, context),
      });
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");
      let fromId = "main";
      if (ctx?.sessionManager) {
        const identity = subAgentIdentity.get(ctx.sessionManager);
        if (identity) fromId = identity.taskId;
      }
      const msgId = sendMessage(fromId, params.to, params.type ?? "info", params.payload);
      return {
        content: [{ type: "text", text: `📨 消息已发送 → ${params.to} (id: ${msgId.slice(0, 8)})` }],
        details: { msgId, to: params.to, type: params.type ?? "info" },
      };
    },
  });
}
