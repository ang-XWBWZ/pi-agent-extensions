/**
 * attention-clear.ts — attention_clear 工具
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BufferState } from "../lib/types.js";
import { resetCounters } from "../lib/state.js";

export function registerAttentionClear(pi: ExtensionAPI, st: BufferState): void {
  pi.registerTool({
    name: "attention_clear",
    label: "Attention Clear",
    description: "清空注意力暂存器中所有内容，重置提醒和轮换计数器。",
    promptSnippet: "Clear the attention buffer",
    promptGuidelines: [
      "Use to clear all buffered items. Resets remind and rotate counters.",
      "Typically called after summarizing or when items are no longer relevant.",
      "FORBIDDEN: Do NOT clear without reason. Only clear when items are truly stale or have been addressed.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const count = st.items.length;
      st.items.length = 0;
      resetCounters(st);
      return {
        content: [{ type: "text", text: `✅ 已清空 ${count} 条暂存，计数器已重置` }],
        details: { cleared: count },
      };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("attention_clear()")));
      return text;
    },
  });
}
