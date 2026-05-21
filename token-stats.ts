/**
 * token-stats.ts — 上下文环指示器
 *
 * 不篡改原生 footer。仅追加环 + 百分比到状态栏。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function ring(pct: number | null): string {
  if (pct === null) return "\u25cb";
  if (pct >= 80) return "\u25c9";
  if (pct >= 40) return "\u25ce";
  return "\u25cb";
}

export default function (pi: ExtensionAPI) {
  function refresh(ctx: ExtensionContext) {
    const cu = ctx.getContextUsage();
    const pct = cu?.percent ?? null;
    const label = pct !== null ? `${ring(pct)} ${pct.toFixed(0)}%` : ring(null);
    ctx.ui.setStatus("token-stats", label);
  }

  // context usage only changes after message_end (model reports usage in response)
  pi.on("message_end", (_event, ctx) => refresh(ctx));
}
