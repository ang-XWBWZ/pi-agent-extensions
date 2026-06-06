/**
 * attention-buffer.ts — 自主注意力暂存器 (v4)
 *
 * AI 自主调用 + context 事件注入 + 粘性。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadState, resetCounters } from "./attention-buffer/lib/state.js";
import { ATTN_BUF_MARKER, type BufferState } from "./attention-buffer/lib/types.js";
import { registerAttentionAdd } from "./attention-buffer/tools/attention-add.js";
import { registerAttentionList } from "./attention-buffer/tools/attention-list.js";
import { registerAttentionClear } from "./attention-buffer/tools/attention-clear.js";
import { registerAttentionSummarize } from "./attention-buffer/tools/attention-summarize.js";
import { registerAttentionConfig } from "./attention-buffer/tools/attention-config.js";

function formatBufferText(st: BufferState): string {
  if (st.items.length === 0) return "";
  const lines = st.items.map((it, i) => {
    const tag = it.sticky ? " 📌" : "";
    const preview = it.content.length > 200 ? it.content.slice(0, 200) + "…" : it.content;
    return `  ${i + 1}.${tag} ${preview}`;
  });
  return [
    `${ATTN_BUF_MARKER} 注意力暂存器 (${st.items.length}/${st.config.maxItems}条, 建议≥${Math.ceil(st.config.maxItems * 0.8)}条时 summarize)`,
    ...lines,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const st = loadState();

  // ---- 工具注册 ----
  registerAttentionAdd(pi, st);
  registerAttentionList(pi, st);
  registerAttentionClear(pi, st);
  registerAttentionSummarize(pi, st);
  registerAttentionConfig(pi, st);

  // ---- context 事件注入 buffer ----
  pi.on("context", (event, _ctx) => {
    const existingIdx = event.messages.findIndex(
      (m) => typeof m.content === "string" && m.content.startsWith(ATTN_BUF_MARKER),
    );

    if (st.items.length === 0) {
      if (existingIdx >= 0) {
        const cleaned = [...event.messages];
        cleaned.splice(existingIdx, 1);
        return { messages: cleaned };
      }
      return;
    }

    const currentText = formatBufferText(st);

    if (existingIdx >= 0 && event.messages[existingIdx].content === currentText) {
      return;
    }

    const cleaned = existingIdx >= 0
      ? [...event.messages.slice(0, existingIdx), ...event.messages.slice(existingIdx + 1)]
      : [...event.messages];

    cleaned.push({ role: "user", content: currentText } as any);
    return { messages: cleaned };
  });

  // ---- message_end — token 追踪 + 状态栏 ----
  pi.on("message_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens ?? 0;

    if (!st.calibrated) {
      st.sessionTokens = currentTokens;
      st.sessionRounds = 0;
      resetCounters(st);
      st.lastTurnTokens = 0;
      st.calibrated = true;
      ctx.ui.setStatus("attn-buf", st.items.length > 0 ? `📌 ${st.items.length}` : "");
      return;
    }

    const deltaTokens = Math.max(0, currentTokens - st.sessionTokens);
    st.lastTurnTokens = deltaTokens;
    st.sessionTokens = currentTokens;
    st.sessionRounds++;
    ctx.ui.setStatus("attn-buf", st.items.length > 0 ? `📌 ${st.items.length}` : "");
  });
}
