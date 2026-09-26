/**
 * capability-tool.ts — JIT 按需能力激活工具 (load_capability)
 *
 * 核心机制：
 * - 纯净定义：严禁 promptGuidelines / promptSnippet，杜绝 System Prompt 重新编译导致缓存失效；
 * - 尾部注入：在 tool_result 中返回 usageDoc，向模型传递详细操作守则，前面所有历史与 System 缓存 100% 保持；
 * - 纯追加挂载：调用 activateCapability -> pi.setActiveTools 增量追加工具集。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activateCapability, getRegisteredCapabilities } from "./capability-router.js";
import { renderStructuredToolCall, renderToolResult } from "./tui-render.js";

export function registerCapabilityTool(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: "load_capability",
    label: "load_capability",
    description:
      "按需激活进阶能力子系统（如 parallel_agent、work_goal 等）。激活后将即时挂载对应新工具并返回该能力的深度指南。普通任务无需激活。",
    parameters: Type.Object({
      capability: Type.String({
        description: "要激活的能力 ID，参见初始 <subsystems> 列表（如 parallel_agent, work_goal）",
      }),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "load_capability", [
        { name: "capability", value: args.capability, tone: "accent" },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 8,
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const capId = (params as { capability?: string }).capability?.trim();
      if (!capId) {
        const available = getRegisteredCapabilities()
          .map((c) => `- ${c.id}: ${c.name} (${c.summary})`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `请提供有效的能力 ID。当前系统可用能力清单：\n${available || "(暂无注册能力)"}`,
            },
          ],
        };
      }

      const res = await activateCapability(capId, pi, ctx);
      const text = [
        res.message,
        ...(res.doc ? ["", "---", `【${capId} 能力深度使用指南】`, res.doc] : []),
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          capability: capId,
          success: res.success,
          activatedTools: res.activatedTools,
        },
      };
    },
  });
}
