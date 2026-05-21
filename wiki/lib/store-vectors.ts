// store-vectors.ts — vectors.json 持久化层
// 管理: 语义向量 / chunk 元数据 / 模型维度信息
//
// 拆自 store.ts (P0-2), 仅负责 vectors.json 的读写。

import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingData } from "./types.js";

function wikiHome(): string {
  return resolve(__dirname, "..");
}

function vectorFile(): string {
  return resolve(wikiHome(), "vectors.json");
}

// ---- 向量 ----

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

export function setEmbeddings(
  entries: Record<string, number[]>,
  model?: string,
  dim?: number,
): void {
  const chunkInfo = getChunkInfo();
  const prev = readRaw();
  const v: EmbeddingData = {
    model: model ?? prev?.model ?? "unknown",
    dim: dim ?? prev?.dim ?? 0,
    entries,
    chunkInfo:
      Object.keys(chunkInfo).length > 0 ? chunkInfo : undefined,
  };
  writeFileSync(vectorFile(), JSON.stringify(v), "utf-8");
}

// ---- 块元数据 ----

export function getChunkInfo(): Record<
  string,
  import("./types.js").ChunkInfo
> {
  try {
    const prev = readRaw();
    return prev?.chunkInfo ?? {};
  } catch {
    return {};
  }
}

export function setChunkInfo(
  chunkInfo: Record<string, import("./types.js").ChunkInfo>,
): void {
  const entries = getEmbeddings();
  const prev = readRaw();
  const v: EmbeddingData = {
    model: prev?.model ?? "unknown",
    dim: prev?.dim ?? 0,
    entries,
    chunkInfo:
      Object.keys(chunkInfo).length > 0 ? chunkInfo : undefined,
  };
  writeFileSync(vectorFile(), JSON.stringify(v), "utf-8");
}

// ---- 单条删除 ----

export function removeEmbedding(relPath: string): void {
  const emb = getEmbeddings();
  let removed = false;
  if (emb[relPath]) {
    delete emb[relPath];
    removed = true;
  }
  for (const key of Object.keys(emb)) {
    if (key.startsWith(`${relPath}###`)) {
      delete emb[key];
      removed = true;
    }
  }
  if (removed) setEmbeddings(emb);
}

// ---- 模型元信息 ----

export function getEmbeddingModel(): string | undefined {
  return readRaw()?.model;
}

export function getEmbeddingDim(): number | undefined {
  return readRaw()?.dim;
}

// ---- 统计 ----

export function vectorsStats(): {
  embeddings: number;
  model?: string;
  dim?: number;
} {
  const prev = readRaw();
  const emb = prev?.entries ?? {};
  return {
    embeddings: Object.keys(emb).length,
    model: prev?.model,
    dim: prev?.dim,
  };
}

// ---- 内部 ----

function readRaw(): EmbeddingData | null {
  try {
    const p = vectorFile();
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as EmbeddingData;
    }
  } catch { /* ignore */ }
  return null;
}
