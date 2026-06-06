// file-manifest.ts — 文件级追踪清单 (v5.4)
//
// manifest.json: 追踪每文件的 md5 / AST 分块状态 / LLM 编译状态
// 用于判断文件是否变更、是否需要重新索引、LLM 编译是否过期
//
// 存储位置: extensions/wiki/manifest.json

import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

// ---- 路径 ----

function wikiHome(): string {
  return resolve(__dirname, "..");
}

function manifestFile(): string {
  return resolve(wikiHome(), "manifest.json");
}

function compiledDir(): string {
  return resolve(wikiHome(), "compiled");
}

// ---- 类型 ----

export interface FileManifestEntry {
  md5: string;
  fileSize: number;         // bytes
  astChunkCount: number;
  astIndexedAt: string;     // ISO timestamp
  llmCompiled: boolean;
  llmCompiledAt?: string;
  compilingSince?: string;     // ISO timestamp — 正在编译中（防并发冲突）
  hasSemanticVectors: boolean; // AST chunks 有向量
  contentClass?: string;       // preprocessor 推断
  deleted?: boolean;           // 标记为已删除（刷新时检测）
}

export interface FileManifest {
  version: 1;
  files: Record<string, FileManifestEntry>;
}

// ---- 统计 ----

export function getManifestStats(): {
  total: number;
  compiled: number;
  withVectors: number;
} {
  const m = getManifest();
  const entries = Object.values(m.files).filter(e => !e.deleted);
  return {
    total: entries.length,
    compiled: entries.filter(e => e.llmCompiled).length,
    withVectors: entries.filter(e => e.hasSemanticVectors).length,
  };
}

// ---- CRUD ----

export function getManifest(): FileManifest {
  try {
    const p = manifestFile();
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    /* ignore */
  }
  return { version: 1, files: {} };
}

function setManifest(m: FileManifest): void {
  writeFileSync(manifestFile(), JSON.stringify(m, null, 2), "utf-8");
}

/** 获取单个文件的状态 */
export function getFileState(
  relPath: string,
): FileManifestEntry | undefined {
  return getManifest().files[relPath];
}

/** 更新单个文件的状态（部分更新） */
export function updateFileState(
  relPath: string,
  patch: Partial<FileManifestEntry>,
): void {
  const m = getManifest();
  const existing = m.files[relPath] || {
    md5: "",
    astChunkCount: 0,
    astIndexedAt: "",
    llmCompiled: false,
  };
  m.files[relPath] = { ...existing, ...patch };
  setManifest(m);
}

/** 删除单个文件的追踪 */
export function removeFileState(relPath: string): void {
  const m = getManifest();
  delete m.files[relPath];
  setManifest(m);
}

/** 清除指定数据源的所有文件追踪 */
export function clearSourceFromManifest(sourceDir: string): void {
  const m = getManifest();
  for (const key of Object.keys(m.files)) {
    // 无法直接从 manifest 知道 sourceDir，需要调用方传
  }
  setManifest(m);
}

// ---- MD5 ----

/** 计算文本内容的 MD5 散列（用于变更检测） */
export function computeMD5(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

// ---- 变更判断 ----

/** 文件内容是否已变更（MD5 不匹配） */
export function isFileChanged(
  relPath: string,
  currentMD5: string,
): boolean {
  const state = getFileState(relPath);
  if (!state) return true; // 无记录 → 视为已变更
  return state.md5 !== currentMD5;
}

/** LLM 编译是否过期（文件 MD5 与编译时 MD5 不匹配） */
export function isCompilationStale(
  relPath: string,
  currentMD5: string,
): boolean {
  const state = getFileState(relPath);
  if (!state || !state.llmCompiled) return true;
  return state.md5 !== currentMD5;
}

// ---- compiled/ 目录 ----

/** 确保 compiled/ 目录存在 */
export function ensureCompiledDir(): void {
  const dir = compiledDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** 获取某文件的 compiled 存储路径 */
export function getCompiledFilePath(relPath: string): string {
  ensureCompiledDir();
  // 把路径分隔符替换为 _，避免子目录冲突
  const safeName = relPath
    .replace(/\\/g, "_")
    .replace(/\//g, "_")
    .replace(/\.md$/i, "") + ".json";
  return resolve(compiledDir(), safeName);
}

// ---- 统计 ----

export function manifestStats(): {
  total: number;
  compiled: number;
  stale: number;
} {
  const m = getManifest();
  const entries = Object.values(m.files);
  return {
    total: entries.length,
    compiled: entries.filter((e) => e.llmCompiled).length,
    stale: 0, // 需传入当前 MD5 才能判断，此处仅计数
  };
}
