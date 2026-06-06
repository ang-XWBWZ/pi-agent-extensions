/**
 * attention-summarize.ts — attention_summarize 工具
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BufferState } from "../lib/types.js";
import { addItem } from "../lib/state.js";

export function registerAttentionSummarize(pi: ExtensionAPI, st: BufferState): void {
  pi.registerTool({
    name: "attention_summarize",
    label: "Attention Summarize",
    description: "将暂存器中所有条目替换为一条总结。重置轮换计数器，消去轮换提示。",
    promptSnippet: "Summarize attention buffer into one concise item",
    promptGuidelines: [
      "Use when buffer has many stale items or needs consolidation.",
      "summary: a concise summary replacing all current items.",
      "Old items are cleared and replaced with a single '[总结] ...' entry.",
      "The context event will deliver the updated buffer contents next turn.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "替换全部条目的总结内容" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const oldCount = st.items.length;
      st.items.length = 0;
      addItem(st, `[总结] ${params.summary}`);
      return {
        content: [{ type: "text", text: `✅ 已总结 ${oldCount} 条 → 1 条: "${params.summary.slice(0, 80)}${params.summary.length > 80 ? "…" : ""}"` }],
        details: { oldCount, newCount: 1 },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const preview = (args.summary ?? "").slice(0, 40);
      text.setText(theme.fg("toolTitle", theme.bold(`attention_summarize("${preview}${preview.length >= 40 ? "…" : ""}")`)));
      return text;
    },
  });
}
