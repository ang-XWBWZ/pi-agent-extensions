// semantic-search.ts — 语义搜索 & 混合搜索 (v5.0)
//
// semanticSearch:   query → embed → 余弦相似度 → 同文件多块聚合加分
// hybridSearch:     关键词 + 语义并行 → 加权合并 → 按文件排序
//
// 策略:
//   高阈值 0.50 — 只有置信度 ≥50% 的语义匹配才视为有效
//   兜底 — 高阈值结果不足 3 条时，追加 ≤3 条低分结果（标记"弱匹配"）
//   同文件合并 — 一个文件多个块命中时，取最高块相似度 + (块数-1)*0.05 加分（上限 0.25）

import { getEmbeddings, getSemanticEnabled, getChunkInfo } from "./store.js";
import { getIndex } from "./store.js";
import { embed, initialize, isAvailable, cosineSimilarity } from "./embedder.js";
import { keywordSearch } from "./search.js";
import type { SearchHit } from "./types.js";

/** 高置信度阈值 — ≥50% 视为强匹配 */
const HIGH_SIMILARITY_THRESHOLD = 0.50;

/** 最低阈值 — 低于此值不展示（即使兜底） */
const MIN_SIMILARITY_THRESHOLD = 0.20;

/** 兜底条数 — 强匹配不足时最多追加几条弱匹配 */
const FALLBACK_COUNT = 3;

/** 多块加分：每额外一个命中块 +0.05，上限 0.25 */
const MULTI_CHUNK_BONUS = 0.05;
const MAX_MULTI_CHUNK_BONUS = 0.25;

/** 混合搜索权重 */
const KEYWORD_WEIGHT = 0.4;
const SEMANTIC_WEIGHT = 0.6;

// ---- 内部类型 ----

interface ChunkMatch {
  key: string;
  relPath: string;
  similarity: number;
  chunkHeading?: string;
  chunkIndex?: number;
}

interface FileMatch {
  relPath: string;
  /** 同文件聚合后的语义分数 (0-1) */
  semanticScore: number;
  /** 最高分的块 */
  bestChunk: ChunkMatch;
  /** 命中块数 */
  chunkCount: number;
  /** 所有命中块的标题（用于展示） */
  chunkHeadings: string[];
}

/** 纯语义搜索 */
export async function semanticSearch(query: string): Promise<SearchHit[]> {
  if (!getSemanticEnabled()) return [];

  if (!isAvailable()) {
    const ok = await initialize();
    if (!ok) return [];
  }

  const embeddings = getEmbeddings();
  if (Object.keys(embeddings).length === 0) return [];

  const idx = getIndex();
  const chunkInfo = getChunkInfo();

  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch {
    return [];
  }

  // 1. 计算所有块的相似度
  const allChunks: ChunkMatch[] = [];
  for (const [key, vec] of Object.entries(embeddings)) {
    const chunkMatch = key.match(/^(.*)###(\d+)$/);
    const relPath = chunkMatch ? chunkMatch[1] : key;
    const chunkIdx = chunkMatch ? parseInt(chunkMatch[2], 10) : undefined;

    if (!idx[relPath]) continue;
    const similarity = cosineSimilarity(queryVec, vec);
    if (similarity < MIN_SIMILARITY_THRESHOLD) continue;

    const ci = chunkIdx !== undefined ? chunkInfo[key] : undefined;
    allChunks.push({
      key,
      relPath,
      similarity,
      chunkIndex: chunkIdx,
      chunkHeading: ci ? ci.heading.replace(/^#+\s*/, "") : undefined,
    });
  }

  // 2. 同文件聚合：取最高块 + 多块加分
  const fileMap = new Map<string, FileMatch>();
  for (const ch of allChunks) {
    const existing = fileMap.get(ch.relPath);
    if (!existing) {
      fileMap.set(ch.relPath, {
        relPath: ch.relPath,
        semanticScore: ch.similarity,
        bestChunk: ch,
        chunkCount: 1,
        chunkHeadings: ch.chunkHeading ? [ch.chunkHeading] : [],
      });
    } else {
      // 追踪最高分块
      if (ch.similarity > existing.bestChunk.similarity) {
        existing.bestChunk = ch;
      }
      existing.chunkCount++;
      if (ch.chunkHeading && !existing.chunkHeadings.includes(ch.chunkHeading)) {
        existing.chunkHeadings.push(ch.chunkHeading);
      }
    }
  }

  // 计算最终分数：最高块相似度 + 多块加分
  for (const fm of fileMap.values()) {
    const bonus = Math.min((fm.chunkCount - 1) * MULTI_CHUNK_BONUS, MAX_MULTI_CHUNK_BONUS);
    fm.semanticScore = fm.bestChunk.similarity + bonus;
  }

  const files = [...fileMap.values()].sort((a, b) => b.semanticScore - a.semanticScore);

  // 3. 强匹配（聚合后 ≥50%）/ 弱匹配兜底
  const strong = files.filter(f => f.semanticScore >= HIGH_SIMILARITY_THRESHOLD);
  const strongHits = strong.map(f => makeFileHit(f, idx));

  if (strongHits.length < FALLBACK_COUNT) {
    const weak = files
      .filter(f => f.semanticScore < HIGH_SIMILARITY_THRESHOLD)
      .slice(0, FALLBACK_COUNT);
    const weakHits = weak.map(f => {
      const hit = makeFileHit(f, idx);
      hit.snippet = `⚠️ 弱匹配 (${Math.round(f.semanticScore * 100)}%)`;
      return hit;
    });
    return [...strongHits, ...weakHits];
  }

  return strongHits;
}

function makeFileHit(
  f: FileMatch,
  idx: Record<string, import("./types.js").FileEntry>,
): SearchHit {
  const entry = idx[f.relPath]!;

  let snippet = "";
  if (f.bestChunk.chunkHeading) {
    snippet = `▸ ${f.bestChunk.chunkHeading}`;
    if (f.chunkCount > 1) {
      const others = f.chunkHeadings
        .filter(h => h !== f.bestChunk.chunkHeading)
        .slice(0, 2);
      if (others.length > 0) {
        snippet += ` | +${f.chunkCount - 1}块: ${others.join(", ")}`;
      } else {
        snippet += ` | +${f.chunkCount - 1}块命中`;
      }
    }
  }

  return {
    relPath: entry.relPath,
    sourceDir: entry.sourceDir,
    title: entry.title,
    tags: entry.tags,
    snippet,
    score: Math.round(f.semanticScore * 100),
    semanticScore: f.semanticScore,
    chunkIndex: f.bestChunk.chunkIndex,
    chunkHeading: f.bestChunk.chunkHeading,
  };
}

/** 混合搜索：关键词 + 语义并行 → 加权合并 */
export async function hybridSearch(query: string): Promise<SearchHit[]> {
  const keywordHits = keywordSearch(query);

  // 归一化关键词分数到 0-100
  const maxKwScore = keywordHits.length > 0
    ? Math.max(...keywordHits.map(h => h.score), 1)
    : 1;

  const semanticHits = await semanticSearch(query);

  // 按 relPath 去重合并
  const merged = new Map<string, SearchHit>();

  // 先加入关键词结果
  for (const h of keywordHits) {
    const normalizedScore = (h.score / maxKwScore) * 100;
    merged.set(h.relPath, {
      ...h,
      score: Math.round(normalizedScore * KEYWORD_WEIGHT),
    });
  }

  // 合并语义结果
  for (const h of semanticHits) {
    const existing = merged.get(h.relPath);
    if (existing) {
      // 已存在：加权融合
      existing.score = Math.round(
        existing.score + (h.score * SEMANTIC_WEIGHT),
      );
      existing.semanticScore = h.semanticScore;
      if (h.snippet.startsWith("⚠️")) {
        existing.snippet = existing.snippet.includes("⚠️")
          ? existing.snippet
          : `${existing.snippet} | ${h.snippet}`;
      } else {
        existing.snippet = existing.snippet.includes("⚠️")
          ? h.snippet
          : `${existing.snippet} | ${h.snippet}`;
      }
    } else {
      // 纯语义命中：只取语义权重
      merged.set(h.relPath, {
        ...h,
        score: Math.round(h.score * SEMANTIC_WEIGHT),
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
