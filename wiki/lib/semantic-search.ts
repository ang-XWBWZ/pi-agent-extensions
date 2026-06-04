// semantic-search.ts — 语义搜索 & 混合搜索 (v5.1)
//
// semanticSearch:   query → embed → 余弦相似度 → 同文件多块聚合加分
// hybridSearch:     关键词 + 语义并行 → RRF 融合排序 (k=60, Top-50)
//
// 策略:
//   高阈值 0.50 — 只有置信度 ≥50% 的语义匹配才视为有效
//   兜底 — 高阈值结果不足 3 条时，追加 ≤3 条低分结果（标记"弱匹配"）
//   同文件合并 — 一个文件多个块命中时，取最高块相似度 + (块数-1)*0.05 加分（上限 0.25）
//   RRF 融合 — 替代简单线性加权，对异构分数尺度不敏感

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

/** RRF 融合常数 (标准值 60) */
const RRF_K = 60;
/** 各列表参与 RRF 融合的 Top-N 上限 */
const RRF_TOPN = 50;

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
    const chunkMatch = key.match(/^(.*)###(\d+|llm)$/);
    const relPath = chunkMatch ? chunkMatch[1] : key;
    const rawIdx = chunkMatch ? parseInt(chunkMatch[2], 10) : NaN;
    const chunkIdx = isNaN(rawIdx) ? undefined : rawIdx;

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
  const ci = getChunkInfo();
  const strongHits = strong.map(f => makeFileHit(f, idx, ci));

  if (strongHits.length < FALLBACK_COUNT) {
    const weak = files
      .filter(f => f.semanticScore < HIGH_SIMILARITY_THRESHOLD)
      .slice(0, FALLBACK_COUNT);
    const weakHits = weak.map(f => {
      const hit = makeFileHit(f, idx, ci);
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
  chunkInfo?: Record<string, import("./types.js").ChunkInfo>,
): SearchHit {
  const entry = idx[f.relPath]!;

  // 优先展示 LLM 编译结果（summary / topic），其次 AST 块标题
  let snippet = "";
  const llmKey = `${f.relPath}###llm`;
  const llm = chunkInfo?.[llmKey];
  if (llm?.summary) {
    snippet = `💡 ${llm.summary}`;
    if (llm.topic) snippet += ` [${llm.topic}]`;
  } else if (llm?.topic) {
    snippet = `💡 ${llm.topic}`;
  } else if (f.bestChunk.chunkHeading) {
    snippet = `▸ ${f.bestChunk.chunkHeading}`;
  }

  // 多块命中展示（最多 5 个附加标题）
  if (f.chunkCount > 1) {
    const others = f.chunkHeadings
      .filter(h => h !== f.bestChunk.chunkHeading)
      .slice(0, 5);
    if (others.length > 0) {
      snippet += ` | +${f.chunkCount - 1}块: ${others.join(", ")}`;
    } else {
      snippet += ` | +${f.chunkCount - 1}块命中`;
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

/** 混合搜索：关键词 + 语义并行 → RRF 融合排序
 *
 * RRF (Reciprocal Rank Fusion):
 *   RRF(d) = Σ 1/(k + rank_i(d))
 *   各列表取 Top-N 参与融合，未出现在某列表中的项 rank = RRF_K*2
 */
export async function hybridSearch(query: string): Promise<SearchHit[]> {
  const keywordHits = keywordSearch(query);
  const semanticHits = await semanticSearch(query);

  // 按分数排序并取 Top-N
  const kwSorted = [...keywordHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, RRF_TOPN);
  const semSorted = [...semanticHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, RRF_TOPN);

  // 构建 rank 映射 (1-based)
  const kwRank = new Map<string, number>();
  kwSorted.forEach((h, i) => kwRank.set(h.relPath, i + 1));

  const semRank = new Map<string, number>();
  semSorted.forEach((h, i) => semRank.set(h.relPath, i + 1));

  // 收集所有唯一文件
  const allPaths = new Set([
    ...kwSorted.map(h => h.relPath),
    ...semSorted.map(h => h.relPath),
  ]);

  // 构建查找表
  const kwMap = new Map(kwSorted.map(h => [h.relPath, h]));
  const semMap = new Map(semSorted.map(h => [h.relPath, h]));

  // RRF 缺省排名（未出现在某列表中的项用此值）
  const missingRank = RRF_K * 2;

  const merged: SearchHit[] = [];

  for (const relPath of allPaths) {
    const kw = kwMap.get(relPath);
    const sem = semMap.get(relPath);

    const kwR = kwRank.get(relPath) ?? missingRank;
    const semR = semRank.get(relPath) ?? missingRank;

    const rrf = 1 / (RRF_K + kwR) + 1 / (RRF_K + semR);

    // 取最佳信息源构建结果
    const base = sem || kw!;

    // 优先语义结果 snippet（含 LLM 编译内容），其次关键词 snippet
    let snippet = sem?.snippet || "";
    if (!snippet && kw?.snippet) {
      snippet = kw.snippet.replace(/\n/g, " | ");
    }

    merged.push({
      relPath: base.relPath,
      sourceDir: base.sourceDir,
      title: base.title,
      tags: base.tags,
      snippet,
      score: Math.round(rrf * 10000),
      semanticScore: sem?.semanticScore,
      chunkIndex: sem?.chunkIndex,
      chunkHeading: sem?.chunkHeading,
    });
  }

  return merged.sort((a, b) => b.score - a.score);
}
