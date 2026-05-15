/**
 * token-stats.ts — 上下文环指示器
 *
 * 不篡改原生 footer。仅追加环 + 百分比到状态栏。
 * 缓存量由原生 footer 的 R 字段显示。
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
    ctx.ui.setStatus("token-stats", ring(pct));
  }

  pi.on("message_end", (_event, ctx) => refresh(ctx));
  pi.on("message_start", (_event, ctx) => refresh(ctx));
}
