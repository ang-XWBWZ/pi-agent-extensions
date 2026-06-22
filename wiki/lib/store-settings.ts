// store-settings.ts — settings.json 持久化层
// 管理: 数据源列表 / 文件索引 / 语义开关 / 模型选择
//
// 拆自 store.ts (P0-2), 仅负责 settings.json 的读写。
// 向量相关已迁至 store-vectors.ts。

import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FileEntry } from "./types.js";
import { getEmbeddings, setEmbeddings } from "./store-vectors.js";

function wikiHome(): string {
  return resolve(__dirname, "..");
}

function settingsFile(): string {
  return resolve(wikiHome(), "settings.json");
}

// ---- 内部类型 ----

interface WikiSettings {
  sources: string[];
  index: Record<string, FileEntry>; // relPath → FileEntry
  lastScan: string;
  semanticEnabled?: boolean;
  currentModelId?: string;
}

// ---- 核心读写 ----

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

// ---- 数据源 ----

export function getSources(): string[] {
  return readAll().sources;
}

export function addSource(absPath: string): boolean {
  const s = readAll();
  if (s.sources.includes(absPath)) return false;
  s.sources.push(absPath);
  writeAll(s);
  return true;
}

/** 移除数据源并清理关联索引和语义向量 */
export function removeSource(target: string): string | null {
  const s = readAll();
  const idx = s.sources.findIndex(
    (p) => p === target || p.endsWith(target),
  );
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
    if (s.index[key] === undefined) {
      delete emb[key];
      embCleaned++;
    }
  }
  if (embCleaned > 0) setEmbeddings(emb);

  return removed;
}

// ---- 索引 ----

export function getIndex(): Record<string, FileEntry> {
  return readAll().index;
}

export function mergeIndex(entries: FileEntry[]): void {
  const s = readAll();
  for (const e of entries) {
    s.index[e.relPath] = e;
  }
  s.lastScan = new Date().toISOString();
  writeAll(s);
}

export function removeEntry(relPath: string): boolean {
  const s = readAll();
  if (!s.index[relPath]) return false;
  delete s.index[relPath];
  writeAll(s);
  return true;
}

export function updateEntryPath(
  oldRelPath: string,
  newRelPath: string,
  entry: FileEntry,
): boolean {
  const s = readAll();
  if (!s.index[oldRelPath]) return false;
  delete s.index[oldRelPath];
  s.index[newRelPath] = entry;
  writeAll(s);
  return true;
}

export function getEntry(relPath: string): FileEntry | null {
  const idx = getIndex();
  return idx[relPath] ?? null;
}

// ---- wiki 对话模型（供 /wiki-ask 使用，与语义模型无关） ----

export function getWikiModel(): string {
  return "opencode-go/deepseek-v4-flash";
}

// ---- 当前语义模型 id ----

export function readModelId(): string | undefined {
  return readAll().currentModelId;
}

export function writeModelId(id: string): void {
  const s = readAll();
  s.currentModelId = id;
  writeAll(s);
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

// ---- 统计 ----

export function sourcesStats(): {
  sources: number;
  files: number;
  lastScan: string;
} {
  const s = readAll();
  return {
    sources: s.sources.length,
    files: Object.keys(s.index).length,
    lastScan: s.lastScan,
  };
}
