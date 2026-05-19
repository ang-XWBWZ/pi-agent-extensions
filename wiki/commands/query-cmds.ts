// query-cmds.ts — search (v3.1)
// /wiki-search → TUI 面板（不触发 AI）
// /wiki-ask   → 消息（触发 AI 总结）
// /wiki-close → 关闭 TUI 面板

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { search } from "../lib/search.js";
import type { SearchHit } from "../lib/types.js";

/** 最后一次搜索结果（供 widget 渲染） */
let lastResults: { query: string; hits: SearchHit[] } | null = null;

export function cmdSearch(raw: string, pi: ExtensionAPI, ctx: any): string {
  const q = raw.trim();
  if (!q) return "🔍 /wiki-search — 搜索 wiki 索引（标题+全文），结果在 Wiki 面板显示\n用法: /wiki-search <关键词>";

  const hits = search(q);
  if (!hits.length) {
    lastResults = { query: q, hits: [] };
    return `🔍 未匹配 "${q}"`;
  }

  lastResults = { query: q, hits: hits.slice(0, 20) };

  // 设置 TUI 面板
  try {
    ctx.ui.setWidget("wiki-search", (_tui: any, theme: any) => ({
      render: (width: number) => {
        const r = lastResults;
        if (!r) return [];
        const w = Math.max(width - 2, 20);
        const lines: string[] = [
          truncateToWidth(theme.bold(`🔍 Wiki 搜索: "${r.query}" — ${r.hits.length} 结果`), w, "…"),
          theme.fg("dim", truncateToWidth("─".repeat(60), w, "")),
        ];
        for (let i = 0; i < Math.min(r.hits.length, 15); i++) {
          const h = r.hits[i];
          lines.push(truncateToWidth(theme.fg("accent", `${i + 1}. ${h.title}`), w, "…"));
          lines.push(truncateToWidth(theme.fg("dim", `   ${h.relPath}  (${h.score})`), w, "…"));
          if (h.snippet) lines.push(truncateToWidth(theme.fg("muted", `   ${h.snippet.slice(0, 100)}`), w, "…"));
        }
        if (r.hits.length > 15) lines.push(theme.fg("dim", truncateToWidth(`   ...还有 ${r.hits.length - 15} 个结果`, w, "…")));
        return lines;
      },
      invalidate: () => {},
    }));
  } catch { /* TUI 不可用时忽略 */ }

  return `🔍 "${q}" — ${hits.length} 结果（面板显示）`;
}

export function cmdClose(_raw: string, _pi: ExtensionAPI, ctx: any): string {
  lastResults = null;
  try { ctx.ui.setWidget("wiki-search", undefined); } catch { /* TUI 不可用时忽略 */ }
  return "✅ Wiki 面板已关闭";
}

export function cmdAsk(raw: string): string {
  const q = raw.trim();
  if (!q) return "💬 /wiki-ask — 搜索并返回源文件全文\n用法: /wiki-ask <问题>";
  const hits = search(q);
  if (!hits.length) return `🔍 未匹配 "${q}"`;
  const top = hits.slice(0, 3);
  const lines = [`🔍 "${q}" — ${hits.length} 结果，返回前 ${top.length} 篇全文:`, ""];
  for (const h of top) {
    lines.push(`📄 **${h.title}** \`${h.relPath}\`\n   ${h.snippet}`);
    const full = resolve(h.sourceDir, h.relPath);
    if (existsSync(full)) {
      try { lines.push(`\n---\n${readFileSync(full, "utf-8").slice(0, 3000)}\n---\n`); } catch {}
    }
  }
  return lines.join("\n");
}
