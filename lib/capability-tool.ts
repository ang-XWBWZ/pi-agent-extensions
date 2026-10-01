/** Fixed capability transport: load returns guides and schemas at the tail;
 * call dispatches a reviewed operation without changing native tool definitions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  activateCapability,
  getDefaultActivationState,
  getRegisteredCapabilities,
  formatFullCapabilityCatalog,
} from "./capability-router.js";
import { getExecutionContext } from "./execution-context.js";
import { executeCapabilityCall, describeCapabilityOperations } from "./capability-dispatch.js";
import { renderStructuredToolCall, renderToolResult } from "./tui-render.js";

export function registerCapabilityTool(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: "call_capability",
    label: "Call capability",
    description: "Call an operation from a previously loaded capability. First use load_capability to obtain exact operation names and argument schemas. Normal phase, approval, protected-path and child-tool restrictions apply to the actual operation. Calls execute sequentially; use spawn_agent for parallel tasks.",
    executionMode: "sequential",
    parameters: Type.Object({
      capability: Type.String({ description: "Loaded capability ID" }),
      operation: Type.String({ description: "Exact operation name returned by load_capability" }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments matching that operation's returned JSON Schema" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "call_capability", [
        { name: "capability", value: args.capability, tone: "accent" },
        { name: "operation", value: args.operation, tone: "warning" },
        { name: "arguments", value: args.arguments, maxLength: 180 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, { previewLines: 12 });
    },
    execute: executeCapabilityCall,
  });
  pi.registerTool({
    name: "load_capability",
    label: "load_capability",
    description:
      "按需激活进阶能力子系统（如 model_switch、provider_manager、parallel_agent、work_goal 等），或查看系统功能与工具完整清单。加载后返回操作 Schema 与深度指南；通过固定 call_capability 入口调用，不改变请求工具定义。",
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
        currentPhase = getExecutionContext(ctx?.sessionManager)?.phase ?? "work";
      } catch {
        currentPhase = "work";
      }
      const res = await activateCapability(
        capId,
        pi,
        ctx,
        currentPhase,
        getDefaultActivationState(ctx?.sessionManager),
        ctx?.sessionManager,
      );
      const text = [
        res.message,
        ...(res.doc ? ["", "---", `【${capId} 能力深度使用指南】`, res.doc] : []),
        ...(res.success ? ["", describeCapabilityOperations(capId, ctx)] : []),
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
