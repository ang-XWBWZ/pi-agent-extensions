/**
 * model-switch.ts — 注册 switch_model 工具，允许 LLM 自行切换模型
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "switch_model",
    label: "Switch Model",
    description:
      "切换当前模型。列出可用模型时不传参数; 切换时传 provider + model。",
    promptSnippet: "List or switch between available models",
    promptGuidelines: [
      "Use switch_model without arguments to list available models. Use switch_model with provider and model to switch.",
    ],
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 无参数 → 列出可用模型
      if (!params.provider || !params.model) {
        const all = await ctx.modelRegistry.getAvailable();
        const lines = all.map(
          (m) => `${m.provider}/${m.id}${m.reasoning ? " 🧠" : ""}`,
        );
        return {
          content: [
            {
              type: "text",
              text:
                "可用模型:\n" +
                lines.map((l) => `  - ${l}`).join("\n") +
                `\n\n当前: ${ctx.model?.provider}/${ctx.model?.id}`,
            },
          ],
          details: {},
        };
      }

      // 切换
      const target = ctx.modelRegistry.find(
        params.provider,
        params.model,
      );
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `模型不存在: ${params.provider}/${params.model}`,
            },
          ],
          details: {},
        };
      }

      const ok = await pi.setModel(target);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `已切换至 ${params.provider}/${params.model}`
              : `切换失败: ${params.provider}/${params.model}`,
          },
        ],
        details: {},
      };
    },
  });
}
