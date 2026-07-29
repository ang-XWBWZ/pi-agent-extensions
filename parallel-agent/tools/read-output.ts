/**
 * read-output.ts — read_agent_output 工具注册
 *
 * 只按需读取子 Agent 的原始输出日志，不加载会话存档，也不把整段日志注入结果。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getAgentTaskOutputInfo,
  getAgentTaskPanel,
  readAgentTaskOutput,
} from "../../lib/agent-bus.js";

export function registerReadAgentOutput(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_agent_output",
    label: "Read Agent Output",
    description:
      "按 UTF-8 字节游标分页读取某个子 Agent 的原始输出。" +
      "它只读取请求的片段，不加载会话存档，也不会主动把完整日志注入主上下文。" +
      "默认 12,000 字节，最多 32,000 字节；用返回的 nextCursor 继续。",
    promptSnippet: "Read one bounded slice of a sub-agent's raw output when a preview needs evidence",
    promptGuidelines: [
      "Use read_agent_output only when a task summary or preview leaves a concrete evidence gap; do not prefetch full child output or session archives.",
      "With read_agent_output, start with the default bounded page and use nextCursor only if the needed evidence is not yet present; summarize the finding instead of repeatedly copying raw logs.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ description: "子任务所属 Job ID" }),
      taskId: Type.String({ description: "子任务 Task ID" }),
      cursor: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "上一次返回的 nextCursor（UTF-8 字节游标；默认 0）",
        }),
      ),
      maxBytes: Type.Optional(
        Type.Number({
          minimum: 256,
          maximum: 32_000,
          description: "本次最多读取的 UTF-8 字节数（默认 12,000）",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("读取子 Agent 输出已取消");
      if (!Number.isFinite(params.cursor ?? 0) || (params.cursor ?? 0) < 0) {
        return {
          content: [{ type: "text", text: "cursor 必须是大于等于 0 的有限数字。" }],
          details: { error: "invalid_cursor" },
        };
      }
      if (
        params.maxBytes !== undefined &&
        (!Number.isFinite(params.maxBytes) ||
          params.maxBytes < 256 ||
          params.maxBytes > 32_000)
      ) {
        return {
          content: [{ type: "text", text: "maxBytes 必须是 256-32,000 的有限数字。" }],
          details: { error: "invalid_max_bytes" },
        };
      }

      const panel = getAgentTaskPanel(params.jobId, params.taskId);
      if (!panel) {
        return {
          content: [{ type: "text", text: `任务面板不存在: ${params.jobId}/${params.taskId}` }],
          details: { error: "not_found", jobId: params.jobId, taskId: params.taskId },
        };
      }

      const info = getAgentTaskOutputInfo(params.jobId, params.taskId);
      if (!info.available) {
        return {
          content: [{ type: "text", text: `子 Agent ${params.taskId} 尚无可展开的输出。` }],
          details: {
            jobId: params.jobId,
            taskId: params.taskId,
            source: info.source,
            totalBytes: 0,
          },
        };
      }

      const slice = readAgentTaskOutput(params.jobId, params.taskId, {
        cursor: params.cursor,
        maxBytes: params.maxBytes,
      });
      const position = `${slice.cursor}-${slice.nextCursor} / ${slice.totalBytes} bytes`;
      const continuation = slice.hasMore
        ? `\n\n还有 ${slice.totalBytes - slice.nextCursor} bytes；继续读取：` +
          ` read_agent_output({ jobId: ${JSON.stringify(params.jobId)}, taskId: ${JSON.stringify(params.taskId)}, cursor: ${slice.nextCursor} })`
        : "\n\n已到达输出末尾。";

      return {
        content: [{
          type: "text",
          text: [
            `📄 子 Agent 原始输出片段 (${slice.source}, ${position})`,
            "",
            slice.text || "(该片段为空)",
            continuation,
          ].join("\n"),
        }],
        details: {
          jobId: params.jobId,
          taskId: params.taskId,
          source: slice.source,
          cursor: slice.cursor,
          nextCursor: slice.nextCursor,
          totalBytes: slice.totalBytes,
          characterLength: info.characterLength,
          hasMore: slice.hasMore,
        },
      };
    },
  });
}
