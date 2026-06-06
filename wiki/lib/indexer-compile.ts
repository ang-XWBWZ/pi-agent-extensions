// indexer-compile.ts — 语义编译存储 (v5.4)
//
// getRawChunks / storeCompiledChunks (v5.1 块级)
// storeFileSegments (v5.2 文件级 segments → 待 v5.4 替换为 storeFileLLMVector)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getIndex, getEmbeddings, setEmbeddings, getChunkInfo, setChunkInfo } from "./store.js";
import { getCurrentModel } from "./model-registry.js";
import { initialize, isAvailable, embed } from "./embedder.js";
import { extractChunks } from "./indexer-embed.js";
import { buildEmbeddingText, buildFileLLMEmbeddingText } from "./semantic-compiler.js";
import type { CompiledChunk, RawChunk, FileSegment, ChunkInfo, FileLLMData, CompiledFileRecord } from "./types.js";
import type { PreprocessedChunk } from "./preprocessor.js";
import { updateFileState, computeMD5, getCompiledFilePath, ensureCompiledDir } from "./file-manifest.js";

/**
 * 获取所有已索引文件的原始块（供 AI 编译）
 */
export async function getRawChunks(
  sourceDir?: string,
  uncompiledOnly = true,
): RawChunk[] {
  const idx = getIndex();
  const chunkInfo = getChunkInfo();
  const entries = Object.values(idx).filter(
    (e) => !sourceDir || e.sourceDir === sourceDir,
  );

  const result: RawChunk[] = [];

  for (const entry of entries) {
    const fullPath = resolve(entry.sourceDir, entry.relPath);
    if (!existsSync(fullPath)) continue;

    const chunks = await extractChunks(fullPath, entry.relPath, entry.title);

    for (const ch of chunks) {
      const ci = chunkInfo[ch.key];
      const compiled = !!(ci?.normalizedText);
      if (uncompiledOnly && compiled) continue;

      result.push({
        key: ch.key,
        relPath: entry.relPath,
        heading: ch.heading,
        rawText: ch.rawText,
        compiled,
      });
    }
  }

  return result;
}

/**
 * 存储块级编译结果并重建 embedding (v5.1 遗留)
 */
export async function storeCompiledChunks(
  compiled: CompiledChunk[],
): Promise<number> {
  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return 0;
  }

  const chunkInfo = getChunkInfo();
  const existing = getEmbeddings();
  const rawChunks = await getRawChunks(undefined, false);
  const rawMap = new Map(rawChunks.map((r) => [r.key, r]));

  let updated = 0;

  for (const cc of compiled) {
    const ci = chunkInfo[cc.key];
    if (!ci) continue;

    Object.assign(ci, {
      topic: cc.topic,
      normalizedText: cc.normalizedText,
      concepts: cc.concepts,
      aliases: cc.aliases,
    });

    const raw = rawMap.get(cc.key);
    const rawText = raw?.rawText ?? "";
    const embeddingText = buildEmbeddingText(
      cc.topic,
      cc.normalizedText,
      cc.concepts,
      cc.aliases,
      ci.keywords ?? [],
      ci.contentClass ?? "reference",
      ci.temporalAnchor,
      rawText,
    );

    try {
      const vec = await embed(embeddingText);
      existing[cc.key] = vec;
      updated++;
    } catch {
      /* skip */
    }
  }

  if (updated > 0) {
    const model = getCurrentModel();
    setEmbeddings(existing, model.hfRepo, model.dim);
    setChunkInfo(chunkInfo);
  }

  return updated;
}

/**
 * 存储文件级编译结果并重建 embedding (v5.2 → v5.4 过渡)
 * v5.4 TODO: 替换为 storeFileLLMVector — 只挂 1 个 ###llm 向量，不删 AST chunks
 */
export async function storeFileSegments(
  relPath: string,
  segments: FileSegment[],
  preprocessed: PreprocessedChunk[],
): Promise<number> {
  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return 0;
  }

  const chunkInfo = getChunkInfo();
  const existing = getEmbeddings();

  // 清除该文件的旧 chunk keys
  const oldKeys = Object.keys(chunkInfo).filter((k) => k.startsWith(relPath));
  for (const key of oldKeys) {
    delete chunkInfo[key];
    delete existing[key];
  }

  let updated = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const key = `${relPath}###${i}`;
    const pp = preprocessed[i] ?? preprocessed[0];

    const ci: ChunkInfo = {
      heading: pp?.heading ?? "",
      level: pp?.level ?? 0,
      topic: seg.topic,
      normalizedText: seg.normalizedText,
      concepts: seg.concepts,
      aliases: seg.aliases,
      chunkType: pp?.chunkType ?? "note",
      contentClass: pp?.contentClass ?? "reference",
      importance: pp?.importance ?? 0.5,
      temporalAnchor: pp?.temporalAnchor,
      confidence: pp?.confidence ?? 0.85,
      summary: pp?.summary,
      keywords: pp?.keywords,
    };

    chunkInfo[key] = ci;

    const embeddingText = buildEmbeddingText(
      seg.topic,
      seg.normalizedText,
      seg.concepts,
      seg.aliases,
      pp?.keywords ?? [],
      pp?.contentClass ?? "reference",
      pp?.temporalAnchor,
      seg.text,
    );

    try {
      const vec = await embed(embeddingText);
      existing[key] = vec;
      updated++;
    } catch {
      /* skip */
    }
  }

  if (updated > 0) {
    const model = getCurrentModel();
    setEmbeddings(existing, model.hfRepo, model.dim);
    setChunkInfo(chunkInfo);
  }

  return updated;
}

// ---- v5.4 文件级 LLM 向量存储 ----

/**
 * 存储文件级 LLM 编译结果：挂载 1 个 ###llm 向量，不删除 AST chunks。
 */
export async function storeFileLLMVector(
  sourceDir: string,
  relPath: string,
  llmData: FileLLMData,
  llmModel?: string,
): Promise<boolean> {
  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return false;
  }

  const fullPath = resolve(sourceDir, relPath);
  let currentMD5 = "";
  try { currentMD5 = computeMD5(readFileSync(fullPath, "utf-8")); } catch { return false; }

  const model = getCurrentModel();
  const maxEmbedLen = Math.floor(model.maxTokens * 2);
  const embeddingText = buildFileLLMEmbeddingText(llmData, relPath, maxEmbedLen);
  let vec: number[];
  try { vec = await embed(embeddingText); } catch { return false; }

  const vectorKey = `${relPath}###llm`;
  const existing = getEmbeddings();
  existing[vectorKey] = vec;

  const chunkInfo = getChunkInfo();
  chunkInfo[vectorKey] = {
    heading: llmData.topic, level: 0,
    topic: llmData.topic, normalizedText: llmData.normalizedText,
    concepts: llmData.concepts, aliases: llmData.aliases,
    chunkType: "llm_summary", contentClass: "knowledge",
    importance: 0.8, confidence: 0.85,
  };

  ensureCompiledDir();
  const compiledFile = getCompiledFilePath(relPath);
  const record: CompiledFileRecord = {
    relPath, compiledAt: new Date().toISOString(), sourceMD5: currentMD5,
    model: llmModel || "unknown", result: llmData, embeddingText, vectorKey,
  };
  writeFileSync(compiledFile, JSON.stringify(record, null, 2), "utf-8");

  const astChunks = await extractChunks(fullPath, relPath, "", maxEmbedLen);
  updateFileState(relPath, {
    md5: currentMD5, astChunkCount: astChunks.length,
    astIndexedAt: new Date().toISOString(),
    llmCompiled: true, llmCompiledAt: new Date().toISOString(),
  });

  // model already obtained above
  setEmbeddings(existing, model.hfRepo, model.dim);
  setChunkInfo(chunkInfo);
  return true;
}
