// search.ts — 搜索引擎 (v2.3)

import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { repoRoot } from "./store.js";
import type { SearchHit } from "./types.js";

export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const k = line.slice(0, ci).trim();
    let v = line.slice(ci + 1).trim();
    if (v.startsWith("[") && v.endsWith("]")) meta[k] = v.slice(1, -1).split(",").map(s => s.trim().replace(/['"]/g, ""));
    else meta[k] = v.replace(/['"]/g, "");
  }
  return { meta, body: m[2] };
}

export async function searchEntries(query: string, mode: "content" | "title" | "both"): Promise<SearchHit[]> {
  const dir = resolve(repoRoot(), "entries");
  const hits: SearchHit[] = [];
  const q = query.toLowerCase();
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }

  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const eid = basename(f, ".md");
    let content: string;
    try { content = await readFile(resolve(dir, f), "utf-8"); } catch { continue; }
    const { meta, body } = parseFrontmatter(content);
    const title = (meta.title as string) || eid;
    const source = (meta.source as string) || "";
    let score = 0;
    let snippet = "";

    if ((mode === "title" || mode === "both") && title.toLowerCase().includes(q)) {
      score += 5;
      snippet = `标题: ${title}`;
    }
    if (mode === "content" || mode === "both") {
      const bl = body.toLowerCase();
      const idx = bl.indexOf(q);
      if (idx >= 0) {
        score += 3;
        const start = Math.max(0, idx - 60);
        const end = Math.min(body.length, idx + query.length + 80);
        snippet = snippet
          ? `${snippet} | 内容: ...${body.slice(start, end).replace(/\n/g, " ")}...`
          : `内容: ...${body.slice(start, end).replace(/\n/g, " ")}...`;
      }
      let count = 0, pos = bl.indexOf(q);
      while (pos >= 0 && count < 10) { count++; pos = bl.indexOf(q, pos + 1); }
      score += Math.min(count - 1, 9);
    }

    const status = (meta.status as string) || "draft";
    if (status === "draft") score = Math.floor(score * 0.5);

    if (score > 0) hits.push({ entryId: eid, title, source, snippet, score, status });
  }
  return hits.sort((a, b) => b.score - a.score);
}
