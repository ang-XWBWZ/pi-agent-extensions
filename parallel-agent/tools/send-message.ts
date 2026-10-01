import { capabilityToolRegistry } from "../../lib/capability-dispatch.js";
/**
 * send-message.ts — send_agent_message 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  deliverAgentMessage,
  getAgentTaskPanel,
  type AgentMessageDeliveryStatus,
} from "../../lib/agent-bus.js";
import { getSessionRuntime } from "../../lib/session-runtime.js";
import { isToolResultError, renderStructuredToolCall, renderToolResult } from "../../lib/tui-render.js";
import { subAgentIdentity } from "../lib/helpers.js";

export function registerSendMessage(pi: ExtensionAPI): void {
  capabilityToolRegistry(pi).registerTool({
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

      // D04：返回真实投递状态，未知/歧义目标绝不显示为“已发送成功”。
      // D06：发往 main 的消息带上所属根会话，只有对应 owner 消费。
      const runtime = getSessionRuntime(ctx?.sessionManager);
      const ownerSessionId =
        runtime?.parentSessionId ?? runtime?.sessionId;
      const delivery = deliverAgentMessage(
        fromId,
        params.to,
        params.type ?? "info",
        params.payload,
        { jobId: identity?.jobId, ownerSessionId },
      );
      const statusText: Record<AgentMessageDeliveryStatus, string> = {
        queued: `消息已投递 → ${params.to}（已交给接收器，queued 不等于已消费）`,
        not_found: `投递失败：目标不存在或没有活动接收器 → ${params.to}`,
        ambiguous_target: `投递失败：目标歧义，多个 Job 存在同名 taskId ${params.to}；请改用 jobId 或从所属任务域发送`,
        queue_full: `投递失败：目标队列已满或接收器拒绝 → ${params.to}`,
        expired: `投递失败：目标已过期 → ${params.to}`,
        rejected: `投递失败：目标拒绝接收 → ${params.to}`,
        duplicate: `重复消息已忽略（id: ${delivery.msgId.slice(0, 8)}）`,
      };
      return {
        content: [{ type: "text", text: statusText[delivery.status] }],
        details: {
          ...delivery,
          // D07：协作消息与用户授权分开标记，不伪装成用户确认。
          collaboration: true,
          to: params.to,
          type: params.type ?? "info",
        },
      };
    },
  });
}
