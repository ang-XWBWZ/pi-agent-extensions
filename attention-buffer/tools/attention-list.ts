/**
 * attention-list.ts — attention_list 工具
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BufferState } from "../lib/types.js";
import { tokensSince, roundsSince, fmtK } from "../lib/state.js";

export function registerAttentionList(pi: ExtensionAPI, st: BufferState): void {
  pi.registerTool({
    name: "attention_list",
    label: "Attention List",
    description: "查看注意力暂存器中所有暂存内容及当前阈值状态。",
    promptSnippet: "List all items in attention buffer",
    promptGuidelines: [
      "Use to inspect the current attention buffer contents.",
      "Returns all items with IDs, content, and threshold status.",
      "Also shows remind/rotate progress (tokens since last remind/rotate).",
      "Useful before deciding whether to summarize or clear.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (st.items.length === 0) {
        return { content: [{ type: "text", text: "📌 暂存器为空" }] };
      }
      const totalChars = st.items.reduce((s, it) => s + it.content.length, 0);
      const remindStatus = [
        `提醒进度: ${fmtK(tokensSince(st))} / ${fmtK(st.config.remind.tokens)} tokens, ${roundsSince(st)} 轮 (单轮 ${fmtK(st.lastTurnTokens)})`,
        `  触发条件: 累计≥${fmtK(st.config.remind.tokens)} / 单轮>${fmtK(st.config.remind.singleTurnTokens)}`,
      ].join("\n");
      const rotateStatus = `轮换进度: ${fmtK(tokensSince(st))} / ${fmtK(st.config.rotate.tokens)} tokens, ${roundsSince(st)} / ${st.config.rotate.rounds} 轮`;
      const itemLines = st.items.map((it, i) => `  ${i + 1}. [${it.id}] ${it.content}`).join("\n");
      return {
        content: [{
          type: "text",
          text: [
            `📌 注意力暂存器 (${st.items.length}/${st.config.maxItems} 条, ${totalChars} 字符)`,
            `会话总量: ${fmtK(st.sessionTokens)} tokens, ${st.sessionRounds} 轮`,
            "", remindStatus, "", rotateStatus, "", itemLines || "  (空)",
          ].join("\n"),
        }],
        details: {
          count: st.items.length, maxItems: st.config.maxItems, totalChars,
          items: st.items.map((it) => ({ id: it.id, content: it.content })),
          session: { tokens: st.sessionTokens, rounds: st.sessionRounds },
          since: { tokens: tokensSince(st), rounds: roundsSince(st) },
        },
      };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`attention_list()`)));
      return text;
    },
  });
}
