// search.ts — 搜索 (v3.0)
// 先搜索引 title → 再搜源文件内容

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getIndex } from "./store.js";
import type { FileEntry, SearchHit } from "./types.js";

export function search(query: string): SearchHit[] {
  const idx = getIndex();
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const [relPath, entry] of Object.entries(idx)) {
    let score = 0;
    let snippet = "";

    // 标题匹配
    if (entry.title.toLowerCase().includes(q)) {
      score += 10;
      snippet = `标题: ${entry.title}`;
    }

    // 路径匹配
    if (relPath.toLowerCase().includes(q)) {
      score += 5;
      snippet = snippet ? `${snippet} | 路径: ${relPath}` : `路径: ${relPath}`;
    }

    // 标签匹配
    if (entry.tags.some(t => t.toLowerCase().includes(q))) {
      score += 3;
    }

    // 内容匹配（读源文件）
    const fullPath = resolve(entry.sourceDir, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8").toLowerCase();
        const pos = content.indexOf(q);
        if (pos >= 0) {
          score += 1;
          // 提取匹配上下文
          const start = Math.max(0, pos - 60);
          const end = Math.min(content.length, pos + query.length + 80);
          const ctx = content.slice(start, end).replace(/\n/g, " ");
          snippet = snippet
            ? `${snippet} | 内容: ...${ctx}...`
            : `内容: ...${ctx}...`;
        }
        // 多次出现加分
        let count = 0, p = content.indexOf(q);
        while (p >= 0 && count < 10) { count++; p = content.indexOf(q, p + 1); }
        score += Math.min(count - 1, 9);
      } catch { /* skip */ }
    }

    if (score > 0) {
      hits.push({
        relPath: entry.relPath,
        sourceDir: entry.sourceDir,
        title: entry.title,
        tags: entry.tags,
        snippet,
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}
