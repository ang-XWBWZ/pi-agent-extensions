// indexer.ts — 文件扫描器 (v3.0)
// 递归扫描目录，对每个 .md 提取标题/frontmatter

import { readFileSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import type { FileEntry } from "./types.js";

/** 递归扫描目录，返回所有 .md 的 FileEntry */
export async function scanDir(sourceDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  await walk(sourceDir, sourceDir, results);
  return results;
}

async function walk(root: string, dir: string, out: FileEntry[]): Promise<void> {
  let items: string[];
  try { items = await readdir(dir); } catch { return; }
  for (const name of items) {
    const full = resolve(dir, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    if (st.isDirectory()) {
      // 跳过隐藏目录和 node_modules
      if (name.startsWith(".") || name === "node_modules") continue;
      await walk(root, full, out);
    } else if (st.isFile() && name.endsWith(".md")) {
      const entry = extractEntry(root, full, st.mtime.toISOString());
      if (entry) out.push(entry);
    }
  }
}

function extractEntry(root: string, filePath: string, mtime: string): FileEntry | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(root, filePath).replace(/\\/g, "/");
    let title = basename(filePath, ".md");
    const tags: string[] = [];

    // 尝试解析 frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const ci = line.indexOf(":");
        if (ci < 0) continue;
        const k = line.slice(0, ci).trim();
        const v = line.slice(ci + 1).trim().replace(/['"]/g, "");
        if (k === "title") title = v;
        if (k === "tags" && v.startsWith("[") && v.endsWith("]")) {
          tags.push(...v.slice(1, -1).split(",").map(s => s.trim().replace(/['"]/g, "")));
        }
      }
    }

    // 没有 frontmatter title 就从第一个 # 标题取
    if (!fmMatch || !raw.match(/^---\n[\s\S]*?\n---\n*\n*# /)) {
      const h1 = raw.match(/^# (.+)$/m);
      if (h1) title = h1[1].trim();
    }

    return { title, tags, sourceDir: root, relPath, mtime };
  } catch {
    return null;
  }
}
