// indexer.ts — 文件扫描器 + embedding 生成 (v5.0)
// 递归扫描目录，对每个 .md 提取标题/frontmatter
// 可选：为条目生成语义向量（支持标题分块）
//   - 按 # ~ #### 顶格标题分割文档为多个块
//   - 每个块独立生成 384 维向量
//   - 块 key 格式: relPath###N

import { readFileSync, existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import type { FileEntry, ChunkInfo } from "./types.js";
import { getSemanticEnabled, getEmbeddings, setEmbeddings, getChunkInfo, setChunkInfo } from "./store.js";
import { initialize, isAvailable, embed } from "./embedder.js";

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

// ---- 语义向量生成 ----

/** 标题行正则：行首 1-4 个 # 后紧跟一个空格 */
const HEADING_RE = /^#{1,4} /;

/** 提取一个块的纯文本（去 markdown 标记，截断） */
function plainText(text: string, maxLen: number): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|\*|_|`|~~/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, maxLen);
}

/** 按标题将文件分割为多个块，每块返回 { key, heading, level, embedText } */
export function extractChunks(
  filePath: string,
  relPath: string,
  defaultTitle: string,
): { key: string; heading: string; level: number; embedText: string }[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const chunks: { heading: string; level: number; lines: string[] }[] = [];

    // 扫描标题行，构建块
    for (const line of lines) {
      const m = line.match(HEADING_RE);
      if (m) {
        const heading = line.trim();
        const level = heading.match(/^#+/)![0].length;
        chunks.push({ heading, level, lines: [] });
      } else if (chunks.length > 0) {
        chunks[chunks.length - 1].lines.push(line);
      } else {
        // 第一个标题之前的文本归入一个隐式块
        if (!chunks.length || chunks[chunks.length - 1].heading !== "") {
          chunks.push({ heading: "", level: 0, lines: [] });
        }
        chunks[chunks.length - 1].lines.push(line);
      }
    }

    // 如果整个文件没有标题，作为一个整体块
    if (chunks.length === 0) {
      chunks.push({ heading: defaultTitle, level: 0, lines });
    }

    // 提取 frontmatter 中的 title
    let fmTitle = "";
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const fl of fmMatch[1].split("\n")) {
        const ci = fl.indexOf(":");
        if (ci < 0) continue;
        const k = fl.slice(0, ci).trim();
        if (k === "title") fmTitle = fl.slice(ci + 1).trim().replace(/['"]/g, "");
      }
    }

    // 构建结果：首块用 document title，其余用自身 heading
    const result: { key: string; heading: string; level: number; embedText: string }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      let heading: string;
      let level: number;

      if (i === 0 && ch.heading === "" && ch.level === 0) {
        // 第一个隐式块（标题前的内容），用文档标题
        heading = fmTitle || defaultTitle;
        level = 0;
      } else if (i === 0 && ch.level > 0) {
        // 第一个块就是标题（没有隐式前导内容），用文档标题作为前导
        heading = fmTitle || defaultTitle;
        level = 0;
      } else {
        heading = ch.heading;
        level = ch.level;
      }

      // 取 heading text（去掉 # 标记）作为显示用
      const headingClean = heading.replace(/^#+\s*/, "");
      const embedText = `${headingClean}\n${plainText(ch.lines.join("\n"), 500)}`;

      result.push({
        key: `${relPath.replace(/\\/g, "/")}###${i}`,
        heading,
        level,
        embedText,
      });
    }

    return result;
  } catch {
    return [{ key: relPath, heading: defaultTitle, level: 0, embedText: defaultTitle }];
  }
}

/**
 * 为一批条目生成 embedding 并持久化到 vectors.json
 * 每个文件按标题分块，每个块独立生成向量
 * 仅对新增/变更文件（通过 mtime 比对）重新生成
 */
export async function generateEmbeddings(
  sourceDir: string,
  entries: FileEntry[],
): Promise<number> {
  if (!getSemanticEnabled()) return 0;

  // 确保 embedder 就绪
  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return 0;
  }

  const existing = getEmbeddings();
  const chunkInfo = getChunkInfo();

  let generated = 0;
  const toEmbed: { key: string; heading: string; level: number; text: string }[] = [];

  for (const entry of entries) {
    const fullPath = resolve(sourceDir, entry.relPath);
    // 检查是否需要重新生成
    try {
      const fileMtime = statSync(fullPath).mtime.toISOString();
      if (existing[entry.relPath] || existing[`${entry.relPath}###0`]) {
        if (fileMtime === entry.mtime) continue; // 未变更
      }
    } catch {
      continue;
    }

    const chunks = extractChunks(fullPath, entry.relPath, entry.title);
    for (const ch of chunks) {
      toEmbed.push({
        key: ch.key,
        heading: ch.heading,
        level: ch.level,
        text: ch.embedText,
      });
    }
  }

  // 生成 embedding
  for (const { key, heading, level, text } of toEmbed) {
    try {
      const vec = await embed(text);
      existing[key] = vec;
      chunkInfo[key] = { heading, level };
      generated++;
    } catch {
      // 单条失败不阻断整体
    }
  }

  // 清理旧的文件级 key（迁移到块级）
  for (const entry of entries) {
    if (existing[entry.relPath] && existing[`${entry.relPath}###0`]) {
      delete existing[entry.relPath];
      delete chunkInfo[entry.relPath];
    }
  }

  if (generated > 0) {
    setEmbeddings(existing);
    setChunkInfo(chunkInfo);
  }

  return generated;
}

/**
 * 为单个文件生成/更新 embedding（标题分块）
 */
export async function embedSingleFile(
  sourceDir: string,
  relPath: string,
  title: string,
): Promise<boolean> {
  if (!getSemanticEnabled()) return false;

  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return false;
  }

  const fullPath = resolve(sourceDir, relPath);
  if (!existsSync(fullPath)) return false;

  try {
    const chunks = extractChunks(fullPath, relPath, title);
    const existing = getEmbeddings();
    const chunkInfo = getChunkInfo();

    let ok = false;
    for (const ch of chunks) {
      const vec = await embed(ch.embedText);
      existing[ch.key] = vec;
      chunkInfo[ch.key] = { heading: ch.heading, level: ch.level };
      ok = true;
    }

    if (ok) {
      setEmbeddings(existing);
      setChunkInfo(chunkInfo);
    }
    return ok;
  } catch {
    return false;
  }
}
