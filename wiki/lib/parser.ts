// parser.ts — 统一的 .md 文件元信息解析
// 提取 frontmatter (title/tags) + H1 标题
// 供 indexer.ts 和 management.ts 共用

import { readFileSync, statSync } from "node:fs";
import { relative, basename } from "node:path";
import type { FileEntry } from "./types.js";

/**
 * 解析单个 .md 文件为 FileEntry
 * @param root     数据源根目录
 * @param filePath 文件绝对路径
 * @param mtime    文件修改时间（可选；不传则通过 statSync 自动获取）
 */
export function parseFileEntry(
  root: string,
  filePath: string,
  mtime?: string,
): FileEntry | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(root, filePath).replace(/\\/g, "/");
    let title = basename(filePath, ".md");
    const tags: string[] = [];

    // --------------------------------------------------
    // frontmatter
    // --------------------------------------------------
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const ci = line.indexOf(":");
        if (ci < 0) continue;
        const k = line.slice(0, ci).trim();
        const v = line.slice(ci + 1).trim().replace(/['"]/g, "");
        if (k === "title") title = v;
        if (k === "tags" && v.startsWith("[") && v.endsWith("]")) {
          tags.push(
            ...v
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/['"]/g, "")),
          );
        }
      }
    }

    // --------------------------------------------------
    // 无 frontmatter title → 回退到第一个 # 标题
    // --------------------------------------------------
    if (!fmMatch || !raw.match(/^---\n[\s\S]*?\n---\n*\n*# /)) {
      const h1 = raw.match(/^# (.+)$/m);
      if (h1) title = h1[1].trim();
    }

    const finalMtime = mtime ?? statSync(filePath).mtime.toISOString();

    return { title, tags, sourceDir: root, relPath, mtime: finalMtime };
  } catch {
    return null;
  }
}
