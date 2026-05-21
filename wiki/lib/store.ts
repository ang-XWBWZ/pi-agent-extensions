// store.ts — 数据层 barrel (v5.1)
//
// P0-2 拆分后: store-settings.ts + store-vectors.ts
// 本文件保留所有原有导出签名，确保零破坏迁移。
//
// 依赖方向: store-settings → store-vectors (单向)
//           本 barrel 聚合两者

// ---- settings.json ----
export {
  readAll,
  writeAll,
  getSources,
  addSource,
  removeSource,
  getIndex,
  mergeIndex,
  removeEntry,
  updateEntryPath,
  getEntry,
  getWikiModel,
  readModelId,
  writeModelId,
  getSemanticEnabled,
  setSemanticEnabled,
  sourcesStats,
} from "./store-settings.js";

// ---- vectors.json ----
export {
  getEmbeddings,
  setEmbeddings,
  getChunkInfo,
  setChunkInfo,
  removeEmbedding,
  getEmbeddingModel,
  getEmbeddingDim,
  vectorsStats,
} from "./store-vectors.js";

// ---- 聚合统计 ----
import { sourcesStats, getIndex, getSemanticEnabled } from "./store-settings.js";
import { vectorsStats } from "./store-vectors.js";

export function stats() {
  const s = sourcesStats();
  const v = vectorsStats();
  const dirs = new Set(
    Object.values(getIndex()).map((e) => e.sourceDir),
  );
  return {
    sources: s.sources,
    files: s.files,
    dirs: dirs.size,
    lastScan: s.lastScan,
    semanticEnabled: getSemanticEnabled(),
    embeddings: v.embeddings,
  };
}
