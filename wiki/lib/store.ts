// store.ts — 数据层 (v3.0)

import { resolve, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FileEntry } from "./types.js";

function wikiHome(): string {
  return resolve(__dirname, "..");
}

function settingsFile(): string {
  return resolve(wikiHome(), "settings.json");
}

interface WikiSettings {
  sources: string[];
  index: Record<string, FileEntry>; // relPath → FileEntry
  lastScan: string;
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

export function stats() {
  const s = readAll();
  const dirs = new Set(Object.values(s.index).map(e => e.sourceDir));
  return {
    sources: s.sources.length,
    files: Object.keys(s.index).length,
    dirs: dirs.size,
    lastScan: s.lastScan,
  };
}
