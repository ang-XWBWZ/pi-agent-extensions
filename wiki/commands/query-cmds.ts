// query-cmds.ts — search / ask (v3.0)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { search } from "../lib/search.js";

export function cmdSearch(raw: string): string {
  const q = raw.trim();
  if (!q) return "🔍 /wiki-search — 搜索 wiki 索引（标题+全文）\n用法: /wiki-search <关键词>";
  const hits = search(q);
  if (!hits.length) return `🔍 未匹配 "${q}"。尝试其他关键词，或 /wiki-load 加载更多数据源。`;
  const lines = hits.slice(0, 10).map((h, i) =>
    `${i + 1}. 📄 **${h.title}** \`${h.relPath}\` (得分:${h.score})\n   ${h.snippet}`
  );
  return `🔍 "${q}" — ${hits.length} 结果:\n\n${lines.join("\n\n")}`;
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
