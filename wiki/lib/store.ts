// store.ts — 数据层：repo/wiki.json / index.json 读写 (v2.3)

import { resolve, basename } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { WikiMeta, WikiIndex } from "./types.js";

/** repo 根: extensions/wiki/repo/ */
export function repoRoot(): string {
  return resolve(__dirname, "..", "repo");
}

// ---- wiki.json ----

export function readMeta(): WikiMeta {
  const p = resolve(repoRoot(), "wiki.json");
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch { /* ignore */ }
  return { name: "wiki", sources: [], created: "", updated: "" };
}

export function writeMeta(meta: WikiMeta): void {
  meta.updated = new Date().toISOString();
  writeFileSync(resolve(repoRoot(), "wiki.json"), JSON.stringify(meta, null, 2), "utf-8");
}

// ---- sources ----

export function loadSource(absPath: string): { name: string; path: string; ok: boolean } {
  const meta = readMeta();
  if (meta.sources.includes(absPath)) return { name: basename(absPath), path: absPath, ok: false };
  meta.sources.unshift(absPath);
  writeMeta(meta);
  return { name: basename(absPath), path: absPath, ok: true };
}

export function unloadSource(target: string): { name: string; path: string } | null {
  const meta = readMeta();
  const idx = meta.sources.findIndex(s => s === target || s.endsWith(target) || basename(s) === target);
  if (idx < 0) return null;
  const removed = meta.sources[idx];
  meta.sources.splice(idx, 1);
  writeMeta(meta);
  return { name: basename(removed), path: removed };
}

export function listSources(): { name: string; path: string }[] {
  return readMeta().sources.map(s => ({ name: basename(s), path: s }));
}

export function resolveSource(relPath: string): string | null {
  const meta = readMeta();
  for (const src of meta.sources) {
    const abs = resolve(src, relPath);
    if (existsSync(abs)) return abs;
  }
  return null;
}

// ---- wiki 模型（从 repo/settings.json 读取） ----

function wikiSettingsPath(): string {
  return resolve(repoRoot(), "settings.json");
}

export function getWikiModel(): string {
  try {
    const p = wikiSettingsPath();
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")).wikiModel || "opencode-go/deepseek-v4-flash";
    }
  } catch { /* ignore */ }
  return "opencode-go/deepseek-v4-flash";
}

export function setWikiModel(model: string): void {
  const p = wikiSettingsPath();
  let s: Record<string, unknown> = {};
  try { if (existsSync(p)) s = JSON.parse(readFileSync(p, "utf-8")); } catch {}
  s.wikiModel = model;
  writeFileSync(p, JSON.stringify(s, null, 2), "utf-8");
}

// ---- index.json（原子写入 + 备份） ----

export async function readIndex(): Promise<WikiIndex> {
  try {
    const raw = await readFile(resolve(repoRoot(), "index.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, updatedAt: "", entryCount: 0, trees: {}, entries: {} };
  }
}

async function backupIndex(): Promise<void> {
  const idx = resolve(repoRoot(), "index.json");
  const bak = resolve(repoRoot(), "index.json.bak");
  try {
    if (existsSync(idx)) writeFileSync(bak, readFileSync(idx));
  } catch { /* ignore */ }
}

export async function writeIndex(idx: WikiIndex): Promise<void> {
  idx.updatedAt = new Date().toISOString();
  idx.entryCount = Object.keys(idx.entries).length;
  await backupIndex();
  const tmp = resolve(repoRoot(), "index.json.tmp");
  const dst = resolve(repoRoot(), "index.json");
  await writeFile(tmp, JSON.stringify(idx, null, 2), "utf-8");
  renameSync(tmp, dst);
}

// ---- 并发锁 ----

let _indexLock = false;

export async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (_indexLock) {
    if (Date.now() - start > 5000) throw new Error("索引锁超时");
    await new Promise(r => setTimeout(r, 10));
  }
  _indexLock = true;
  try {
    return await fn();
  } finally {
    _indexLock = false;
  }
}
