// indexer-embed.ts — 向量生成 (v5.4)
//
// extractChunks (委托 ast-chunker) + generateEmbeddings + embedSingleFile

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getSemanticEnabled, getEmbeddings, setEmbeddings, getChunkInfo, setChunkInfo, setCentroid } from "./store.js";
import { getCurrentModel } from "./model-registry.js";
import { initialize, isAvailable, embed } from "./embedder.js";
import { extractChunksAST } from "./ast-chunker.js";
import { updateFileState, computeMD5, getFileState } from "./file-manifest.js";
import type { FileEntry } from "./types.js";

/** 标题行正则（仅用于 fallback） */
const HEADING_RE = /^#{1,4} /;

/** 去除 markdown 标记，截断 */
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

/**
 * 按标题将文件分割为多个块。
 * v5.3: 优先 AST 解析，失败降级 regex。
 */
export async function extractChunks(
  filePath: string,
  relPath: string,
  defaultTitle: string,
  maxEmbedLen = 800,
): Promise<{ key: string; heading: string; level: number; embedText: string; rawText: string }[]> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    // 优先 AST
    const astChunks = await extractChunksAST(raw, relPath, defaultTitle, maxEmbedLen);
    if (astChunks.length > 0) {
      return astChunks.map((c) => ({
        key: c.key,
        heading: c.heading,
        level: c.level,
        embedText: c.embedText,
        rawText: c.rawText,
      }));
    }
  } catch {
    /* fall through to regex */
  }

  // fallback: regex
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const chunks: { heading: string; level: number; lines: string[] }[] = [];

    for (const line of lines) {
      const m = line.match(HEADING_RE);
      if (m) {
        const heading = line.trim();
        const level = heading.match(/^#+/)![0].length;
        chunks.push({ heading, level, lines: [] });
      } else if (chunks.length > 0) {
        chunks[chunks.length - 1].lines.push(line);
      } else {
        if (!chunks.length || chunks[chunks.length - 1].heading !== "") {
          chunks.push({ heading: "", level: 0, lines: [] });
        }
        chunks[chunks.length - 1].lines.push(line);
      }
    }

    if (chunks.length === 0) {
      chunks.push({ heading: defaultTitle, level: 0, lines });
    }

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

    const result: { key: string; heading: string; level: number; embedText: string; rawText: string }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      let heading: string;
      let level: number;

      if (i === 0 && ch.heading === "" && ch.level === 0) {
        heading = fmTitle || defaultTitle;
        level = 0;
      } else if (i === 0 && ch.level > 0) {
        heading = fmTitle || defaultTitle;
        level = 0;
      } else {
        heading = ch.heading;
        level = ch.level;
      }

      const headingClean = heading.replace(/^#+\s*/, "");
      const rawText = heading ? `${heading}\n${ch.lines.join("\n")}` : ch.lines.join("\n");
      const pathContext = relPath.replace(/\\/g, "/").replace(/\//g, " > ").replace(/\.md$/i, "");
      const embedText = `[${pathContext}]\n${headingClean}\n${plainText(ch.lines.join("\n"), maxEmbedLen)}`;

      result.push({
        key: `${relPath.replace(/\\/g, "/")}###${i}`,
        heading,
        level,
        embedText,
        rawText,
      });
    }

    return result;
  } catch {
    return [{ key: relPath, heading: defaultTitle, level: 0, embedText: defaultTitle, rawText: defaultTitle }];
  }
}

/**
 * 批量生成 embedding 并持久化到 vectors.json
 */
export async function generateEmbeddings(
  sourceDir: string,
  entries: FileEntry[],
): Promise<number> {
  if (!getSemanticEnabled()) return 0;

  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return 0;
  }

  const model = getCurrentModel();
  const maxEmbedLen = Math.floor(model.maxTokens * 2); // 估算字符上限（中西混合保守值）

  const existing = getEmbeddings();
  const chunkInfo = getChunkInfo();

  let generated = 0;
  const toEmbed: { key: string; heading: string; level: number; text: string }[] = [];

  for (const entry of entries) {
    const fullPath = resolve(sourceDir, entry.relPath);

    // v5.4: 计算 MD5
    let currentMD5 = "";
    try {
      currentMD5 = computeMD5(readFileSync(fullPath, "utf-8"));
    } catch {
      continue;
    }

    try {
      const fileMtime = statSync(fullPath).mtime.toISOString();
      if (existing[entry.relPath] || existing[`${entry.relPath}###0`]) {
        if (fileMtime === entry.mtime) continue;
      }
    } catch {
      continue;
    }

    const chunks = await extractChunks(fullPath, entry.relPath, entry.title, maxEmbedLen);

    // 更新 manifest：记录 MD5 + AST 分块
    updateFileState(entry.relPath, {
      md5: currentMD5,
      astChunkCount: chunks.length,
      astIndexedAt: new Date().toISOString(),
    });

    for (const ch of chunks) {
      toEmbed.push({ key: ch.key, heading: ch.heading, level: ch.level, text: ch.embedText });
    }
  }

  for (const { key, heading, level, text } of toEmbed) {
    try {
      const vec = await embed(text);
      existing[key] = vec;
      chunkInfo[key] = { heading, level };
      generated++;
    } catch {
      /* skip */
    }
  }

  // 清理旧文件级 key
  for (const entry of entries) {
    if (existing[entry.relPath] && existing[`${entry.relPath}###0`]) {
      delete existing[entry.relPath];
      delete chunkInfo[entry.relPath];
    }
  }

  if (generated > 0) {
    const model = getCurrentModel();
    setEmbeddings(existing, model.hfRepo, model.dim);
    setChunkInfo(chunkInfo);
  }

  recomputeCentroid();

  // v5.4: 为所有文件补充 manifest（未重新 embed 的无记录文件也补上）
  for (const entry of entries) {
    if (!getFileState(entry.relPath)) {
      try {
        const fullPath = resolve(sourceDir, entry.relPath);
        const raw = readFileSync(fullPath, "utf-8");
        const md5 = computeMD5(raw);
        const chunks = await extractChunks(fullPath, entry.relPath, entry.title, maxEmbedLen);
        updateFileState(entry.relPath, {
          md5,
          astChunkCount: chunks.length,
          astIndexedAt: new Date().toISOString(),
        });
      } catch { /* skip */ }
    }
  }

  return generated;
}

/**
 * 为单个文件生成/更新 embedding
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

  const model = getCurrentModel();
  const maxEmbedLen = Math.floor(model.maxTokens * 2);

  const fullPath = resolve(sourceDir, relPath);
  if (!existsSync(fullPath)) return false;

  try {
    const chunks = await extractChunks(fullPath, relPath, title, maxEmbedLen);
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
      const model = getCurrentModel();
      setEmbeddings(existing, model.hfRepo, model.dim);
      setChunkInfo(chunkInfo);
      recomputeCentroid();
    }
    return ok;
  } catch {
    return false;
  }
}

/** 计算全部向量的均值（噪声基底），供语义搜索降噪 */
export function recomputeCentroid(): void {
  const embeddings = getEmbeddings();
  const vectors = Object.values(embeddings);
  if (vectors.length === 0) return;
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;
  setCentroid(centroid);
}
