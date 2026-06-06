/**
 * attention-add.ts — attention_add 工具
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BufferState } from "../lib/types.js";
import { addItem } from "../lib/state.js";

export function registerAttentionAdd(pi: ExtensionAPI, st: BufferState): void {
  pi.registerTool({
    name: "attention_add",
    label: "Attention Add",
    description:
      "向注意力暂存器写入一条临时备忘。超出条数上限时自动淘汰最旧条目。内容超长自动截断。",
    promptSnippet: "Add a note to attention buffer (content, optional sticky)",
    promptGuidelines: [
      "Use to store temporary reminders, observations, or context to remember across turns.",
      "content: the note text. Auto-truncated at maxCharsPerItem (default 300).",
      "sticky (optional): if true, the item persists across context compaction.",
      "  Use sticky for: current task mainline, critical user preferences, long-running state.",
      "  Use non-sticky for: temporary observations, one-time reminders, change logs.",
      "Buffer has a max item limit (default 8); oldest item is evicted FIFO when full.",
      "Buffer contents are automatically shown to you each turn via context event.",
      "Use attention_list for detailed view; attention_summarize to consolidate.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "暂存内容（超长自动截断）" }),
      sticky: Type.Optional(Type.Boolean({ description: "粘性标记：跨 compaction 保留（默认 false）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const item = addItem(st, params.content, params.sticky ?? false);
      return {
        content: [{ type: "text", text: `📌 已暂存 (${st.items.length}/${st.config.maxItems})${params.sticky ? " 📌粘性" : ""}: "${item.content.slice(0, 80)}${item.content.length > 80 ? "…" : ""}"` }],
        details: { id: item.id, count: st.items.length, maxItems: st.config.maxItems, sticky: params.sticky ?? false },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const preview = (args.content ?? "").slice(0, 40);
      const tag = args.sticky ? " 📌" : "";
      text.setText(theme.fg("toolTitle", theme.bold(`attention_add("${preview}${preview.length >= 40 ? "…" : ""}"${tag})`)));
      return text;
    },
  });
}
