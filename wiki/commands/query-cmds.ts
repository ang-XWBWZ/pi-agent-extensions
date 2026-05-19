// query-cmds.ts — 查询: search / ask / index (v2.3)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, readIndex } from "../lib/store.js";
import { searchEntries } from "../lib/search.js";

export async function cmdSearch(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const q = parts.slice(1).join(" ");
  if (!q) return "用法: /wiki search <关键词>";
  const hits = await searchEntries(q, "both");
  if (!hits.length) return `🔍 未匹配 "${q}"`;
  const lines = hits.slice(0, 10).map((h, i) =>
    `${i + 1}. 📄 **${h.title}** \`${h.entryId}\` [${h.status}] (${h.score})\n   ${h.snippet}`
  );
  return `🔍 "${q}" — ${hits.length} 结果:\n\n${lines.join("\n\n")}`;
}

export async function cmdAsk(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const q = parts.slice(1).join(" ");
  if (!q) return "用法: /wiki ask <问题>";
  const hits = await searchEntries(q, "both");
  if (!hits.length) return `🔍 未匹配 "${q}"`;
  const top = hits.slice(0, 5);
  const lines = [`🔍 "${q}" — ${hits.length} 结果，前 ${top.length}:`, ""];
  for (const h of top) {
    lines.push(`📄 **${h.title}** → ${h.source}\n   ${h.snippet}`);
    try {
      const c = await readFile(resolve(repoRoot(), "entries", `${h.entryId}.md`), "utf-8");
      lines.push(`\n---\n${c.slice(0, 2000)}\n---\n`);
    } catch { /* skip */ }
  }
  return lines.join("\n");
}

export async function cmdIndex(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const idx = await readIndex();
  if (!idx.entryCount) return "📭 索引为空。使用 /wiki add 添加条目。";
  const all: string[] = ["📚 Wiki 索引\n"];
  for (const [tid, tree] of Object.entries(idx.trees)) {
    all.push(`📂 ${tree.label} (${tree.entries.length})`);
    for (const eid of tree.entries) {
      const e = idx.entries[eid];
      if (!e) continue;
      all.push(`  📄 ${e.title} \`${eid}\` [${e.status}] ${e.tags?.length ? `[${e.tags.join(", ")}]` : ""}`);
    }
  }
  return all.join("\n");
}
