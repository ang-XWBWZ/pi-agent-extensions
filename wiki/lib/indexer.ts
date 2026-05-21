// indexer.ts — 索引导入 barrel (v5.4)
//
// 聚合 scan / embed / compile 三个子模块。

export { scanDir } from "./indexer-scan.js";
export { extractChunks, generateEmbeddings, embedSingleFile } from "./indexer-embed.js";
export { getRawChunks, storeCompiledChunks, storeFileSegments, storeFileLLMVector } from "./indexer-compile.js";
