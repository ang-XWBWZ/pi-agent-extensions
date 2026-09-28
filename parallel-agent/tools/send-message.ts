/**
 * send-message.ts — send_agent_message 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getAgentTaskPanel, sendMessage } from "../../lib/agent-bus.js";
import { isToolResultError, renderStructuredToolCall, renderToolResult } from "../../lib/tui-render.js";
import { subAgentIdentity } from "../lib/helpers.js";

export function registerSendMessage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description:
      "向子 Agent 或其他 Agent 发送消息。支持广播 (to='broadcast') 和点对点通信。注意：子任务完成时系统会自动汇总向主 Agent 汇报，严禁向 main 重复发送最终汇报。",
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
      let identity: { jobId: string; taskId: string } | undefined;
      if (ctx?.sessionManager) {
        identity = subAgentIdentity.get(ctx.sessionManager);
        if (identity) fromId = identity.taskId;
      }

      // 若为子 Agent 向 main 汇报，且面板已是 completed 终态，拦截冗余消息以避免主上下文双重汇报
      if (identity && params.to === "main") {
        const panel = getAgentTaskPanel(identity.jobId, identity.taskId);
        if (panel?.status === "completed") {
          return {
            content: [
              {
                type: "text",
                text: "ℹ️ 任务已标记为 completed，系统会在会话结束时自动将你的最终回答与面板结论统一推送给主 Agent，无需通过 send_agent_message 重复发送最终汇报。",
              },
            ],
            details: {
              suppressed: true,
              reason: "already_completed_auto_injected",
              to: params.to,
            },
          };
        }
      }

      const msgId = sendMessage(fromId, params.to, params.type ?? "info", params.payload);
      return {
        content: [{ type: "text", text: `📨 消息已发送 → ${params.to} (id: ${msgId.slice(0, 8)})` }],
        details: { msgId, to: params.to, type: params.type ?? "info" },
      };
    },
  });
}
