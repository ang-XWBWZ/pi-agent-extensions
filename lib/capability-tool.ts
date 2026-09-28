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
import {
  activateCapability,
  getRegisteredCapabilities,
  formatFullCapabilityCatalog,
} from "./capability-router.js";
import { getExecutionContext } from "./execution-context.js";
import { renderStructuredToolCall, renderToolResult } from "./tui-render.js";

export function registerCapabilityTool(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: "load_capability",
    label: "load_capability",
    description:
      "按需激活进阶能力子系统（如 model_switch、provider_manager、parallel_agent、work_goal 等），或查看系统功能与工具完整清单。激活后将即时挂载对应新工具并返回该能力的深度指南。",
    parameters: Type.Object({
      capability: Type.Optional(
        Type.String({
          description:
            "要激活的能力 ID（如 model_switch, provider_manager, parallel_agent, work_goal 等）。留空或配合 action='list' 可查看系统全量能力与工具功能清单。",
        }),
      ),
      action: Type.Optional(
        Type.String({
          description: "操作类型：'load'（激活指定能力，默认）或 'list'（列出全量能力与工具功能清单）",
        }),
      ),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "load_capability", [
        { name: "capability", value: args.capability, tone: "accent" },
        { name: "action", value: args.action, tone: "warning" },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 12,
      });
    },
    async execute(_tcid, params, _signal, _onUpdate, ctx) {
      const action = (params as { action?: string }).action?.trim();
      const capId = (params as { capability?: string }).capability?.trim();

      if (action === "list" || !capId) {
        const catalog = formatFullCapabilityCatalog();
        return {
          content: [
            {
              type: "text",
              text: catalog,
            },
          ],
          details: {
            action: "list",
            totalCapabilities: getRegisteredCapabilities().length,
          },
        };
      }

      let currentPhase: any = "work";
      try {
        currentPhase = getExecutionContext()?.phase ?? "work";
      } catch {
        currentPhase = "work";
      }
      const res = await activateCapability(capId, pi, ctx, currentPhase);
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
