// store.ts — 数据层 (v4.0 语义搜索)

import { resolve, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FileEntry, EmbeddingData } from "./types.js";

/** 语义搜索默认模型 */
export const SEMANTIC_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

function wikiHome(): string {
  return resolve(__dirname, "..");
}

function settingsFile(): string {
  return resolve(wikiHome(), "settings.json");
}

function vectorFile(): string {
  return resolve(wikiHome(), "vectors.json");
}

interface WikiSettings {
  sources: string[];
  index: Record<string, FileEntry>; // relPath → FileEntry
  lastScan: string;
  semanticEnabled?: boolean;
}

export function readAll(): WikiSettings {
  try {
    const p = settingsFile();
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch { /* ignore */ }
  return { sources: [], index: {}, lastScan: "" };
}

export function writeAll(s: WikiSettings): void {
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2), "utf-8");
}

export function getSources(): string[] { return readAll().sources; }

export function addSource(absPath: string): boolean {
  const s = readAll();
  if (s.sources.includes(absPath)) return false;
  s.sources.push(absPath);
  writeAll(s);
  return true;
}

export function removeSource(target: string): string | null {
  const s = readAll();
  const idx = s.sources.findIndex(p => p === target || p.endsWith(target));
  if (idx < 0) return null;
  const removed = s.sources[idx];
  s.sources.splice(idx, 1);
  // 清理该 source 的索引条目
  for (const [key, entry] of Object.entries(s.index)) {
    if (entry.sourceDir === removed) delete s.index[key];
  }
  writeAll(s);
  // 清理该 source 的语义向量
  const emb = getEmbeddings();
  let embCleaned = 0;
  for (const key of Object.keys(emb)) {
    if (s.index[key] === undefined) { delete emb[key]; embCleaned++; }
  }
  if (embCleaned > 0) setEmbeddings(emb);
  return removed;
}

export function getIndex(): Record<string, FileEntry> { return readAll().index; }

export function mergeIndex(entries: FileEntry[]): void {
  const s = readAll();
  for (const e of entries) {
    s.index[e.relPath] = e;
  }
  s.lastScan = new Date().toISOString();
  writeAll(s);
}

/** 从索引移除单条记录 */
export function removeEntry(relPath: string): boolean {
  const s = readAll();
  if (!s.index[relPath]) return false;
  delete s.index[relPath];
  writeAll(s);
  return true;
}

/** 更新条目路径（重命名/移动后同步索引） */
export function updateEntryPath(oldRelPath: string, newRelPath: string, entry: FileEntry): boolean {
  const s = readAll();
  if (!s.index[oldRelPath]) return false;
  delete s.index[oldRelPath];
  s.index[newRelPath] = entry;
  writeAll(s);
  return true;
}

/** 获取单条索引记录 */
export function getEntry(relPath: string): FileEntry | null {
  const idx = getIndex();
  return idx[relPath] ?? null;
}

export function getWikiModel(): string {
  return "opencode-go/deepseek-v4-flash";
}

// ---- 语义搜索开关 ----

export function getSemanticEnabled(): boolean {
  return readAll().semanticEnabled ?? false;
}

export function setSemanticEnabled(enabled: boolean): void {
  const s = readAll();
  s.semanticEnabled = enabled;
  writeAll(s);
}

// ---- 向量存储 (vectors.json) ----

export function getEmbeddings(): Record<string, number[]> {
  try {
    const p = vectorFile();
    if (existsSync(p)) {
      const v: EmbeddingData = JSON.parse(readFileSync(p, "utf-8"));
      return v.entries ?? {};
    }
  } catch { /* ignore */ }
  return {};
}

export function setEmbeddings(entries: Record<string, number[]>): void {
  const chunkInfo = getChunkInfo();
  const v: EmbeddingData = {
    model: SEMANTIC_MODEL,
    dim: 384,
    entries,
    chunkInfo: Object.keys(chunkInfo).length > 0 ? chunkInfo : undefined,
  };
  writeFileSync(vectorFile(), JSON.stringify(v), "utf-8");
}

/** 读取块元数据 */
export function getChunkInfo(): Record<string, import("./types.js").ChunkInfo> {
  try {
    const p = vectorFile();
    if (existsSync(p)) {
      const v: EmbeddingData = JSON.parse(readFileSync(p, "utf-8"));
      return v.chunkInfo ?? {};
    }
  } catch { /* ignore */ }
  return {};
}

/** 写入块元数据（与 embeddings 合并存储） */
export function setChunkInfo(chunkInfo: Record<string, import("./types.js").ChunkInfo>): void {
  const entries = getEmbeddings();
  const v: EmbeddingData = {
    model: SEMANTIC_MODEL,
    dim: 384,
    entries,
    chunkInfo: Object.keys(chunkInfo).length > 0 ? chunkInfo : undefined,
  };
  writeFileSync(vectorFile(), JSON.stringify(v), "utf-8");
}

export function removeEmbedding(relPath: string): void {
  const emb = getEmbeddings();
  let removed = false;
  // 删除旧格式的文件级 key
  if (emb[relPath]) { delete emb[relPath]; removed = true; }
  // 删除所有块级 key: relPath###N
  for (const key of Object.keys(emb)) {
    if (key.startsWith(`${relPath}###`)) { delete emb[key]; removed = true; }
  }
  if (removed) setEmbeddings(emb);
}

export function getEmbeddingModel(): string {
  try {
    const p = vectorFile();
    if (existsSync(p)) {
      const v: EmbeddingData = JSON.parse(readFileSync(p, "utf-8"));
      return v.model || SEMANTIC_MODEL;
    }
  } catch { /* ignore */ }
  return SEMANTIC_MODEL;
}

export function getSemanticModel(): string {
  return SEMANTIC_MODEL;
}

// ---- 统计 ----

export function stats() {
  const s = readAll();
  const dirs = new Set(Object.values(s.index).map(e => e.sourceDir));
  const emb = getEmbeddings();
  return {
    sources: s.sources.length,
    files: Object.keys(s.index).length,
    dirs: dirs.size,
    lastScan: s.lastScan,
    semanticEnabled: s.semanticEnabled ?? false,
    embeddings: Object.keys(emb).length,
  };
}
