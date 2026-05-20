// search.ts — 关键词搜索 (v5.0)
// 标题/路径/标签/内容匹配 → 行级上下文展示

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getIndex } from "./store.js";
import type { FileEntry, SearchHit } from "./types.js";

/** 提取匹配行的上下文（前一行、匹配行、后一行） */
function lineContext(content: string, query: string, maxLen = 100): string {
  const lower = content.toLowerCase();
  const q = query.toLowerCase();
  const pos = lower.indexOf(q);
  if (pos < 0) return "";

  // 找到匹配位置所在行号
  const before = content.slice(0, pos);
  const lineNum = before.split("\n").length; // 1-indexed
  const lines = content.split("\n");

  const prev = lineNum > 1 ? lines[lineNum - 2].trim() : "";
  const curr = lines[lineNum - 1].trim();
  const next = lineNum < lines.length ? lines[lineNum].trim() : "";

  const parts: string[] = [];
  if (prev) parts.push(`L${lineNum - 1}: ${prev.slice(0, maxLen)}`);
  parts.push(`L${lineNum}: ${curr.slice(0, maxLen)}`);
  if (next) parts.push(`L${lineNum + 1}: ${next.slice(0, maxLen)}`);

  return parts.join("\n");
}

/** 关键词搜索（同步，纯子串匹配 + 加权打分） */
export function keywordSearch(query: string): SearchHit[] {
  const idx = getIndex();
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const [relPath, entry] of Object.entries(idx)) {
    let score = 0;
    const parts: string[] = [];

    // 标题匹配
    if (entry.title.toLowerCase().includes(q)) {
      score += 10;
    }

    // 路径匹配
    if (relPath.toLowerCase().includes(q)) {
      score += 5;
    }

    // 标签匹配
    if (entry.tags.some(t => t.toLowerCase().includes(q))) {
      score += 3;
    }

    // 内容匹配（读源文件，取行上下文）
    const fullPath = resolve(entry.sourceDir, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const lower = content.toLowerCase();

        let count = 0, p = lower.indexOf(q);
        while (p >= 0 && count < 5) {
          count++;
          if (count === 1) score += 1;

          // 取该匹配位置的行上下文
          const ctx = lineContext(content, query);
          if (ctx && !parts.some(pp => pp.includes(ctx.slice(0, 30)))) {
            parts.push(ctx);
          }
          p = lower.indexOf(q, p + 1);
        }

        // 多次出现加分
        score += Math.min(count - 1, 9);
      } catch { /* skip */ }
    }

    if (score > 0) {
      hits.push({
        relPath: entry.relPath,
        sourceDir: entry.sourceDir,
        title: entry.title,
        tags: entry.tags,
        snippet: parts.join("\n"),
        score,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}

/** 向后兼容别名 */
export const search = keywordSearch;
