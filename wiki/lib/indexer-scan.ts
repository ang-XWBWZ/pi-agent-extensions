// indexer-scan.ts — 文件扫描器 (v5.4)
//
// 递归扫描目录，提取 .md 文件为 FileEntry

import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileEntry } from "./types.js";
import { parseFileEntry } from "./parser.js";
import { setContent } from "./content-cache.js";

/** 递归扫描目录，返回所有 .md 的 FileEntry */
export async function scanDir(sourceDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  await walk(sourceDir, sourceDir, results);
  return results;
}

async function walk(
  root: string,
  dir: string,
  out: FileEntry[],
): Promise<void> {
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }
  for (const name of items) {
    const full = resolve(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      await walk(root, full, out);
    } else if (st.isFile() && name.endsWith(".md")) {
      const entry = parseFileEntry(root, full, st.mtime.toISOString());
      if (entry) {
        out.push(entry);
        try {
          setContent(entry.relPath, readFileSync(full, "utf-8"));
        } catch {
          /* skip */
        }
      }
    }
  }
}
