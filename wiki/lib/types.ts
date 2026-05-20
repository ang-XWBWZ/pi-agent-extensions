// types.ts — Wiki 插件类型 (v4.0 语义搜索)

/** 搜索模式 */
export type SearchMode = "keyword" | "semantic" | "hybrid";

/** 索引中的单个文件条目 */
export interface FileEntry {
  /** 从第一个 # 标题提取，或取文件名 */
  title: string;
  /** frontmatter tags（如果存在） */
  tags: string[];
  /** 所属数据源目录 */
  sourceDir: string;
  /** 相对于 sourceDir 的文件路径 */
  relPath: string;
  /** 文件修改时间 */
  mtime: string;
}

/** 文档块信息（标题分块） */
export interface ChunkInfo {
  heading: string;    // 标题文本（含 # 标记，如 "## 依赖关系"）
  level: number;      // 标题级别 1-4
}

/** 搜索结果 */
export interface SearchHit {
  relPath: string;
  sourceDir: string;
  title: string;
  tags: string[];
  snippet: string;
  score: number;
  /** 文档摘要（纯文本前 200 字符） */
  summary?: string;
  /** 语义相似度 (0-1)，仅 semantic/hybrid 模式 */
  semanticScore?: number;
  /** 块索引（标题分块时使用） */
  chunkIndex?: number;
  /** 块标题（标题分块时使用） */
  chunkHeading?: string;
}

/** 向量存储结构 */
export interface EmbeddingData {
  model: string;
  dim: number;
  entries: Record<string, number[]>;    // key: relPath 或 relPath###N
  /** 块元数据（仅标题分块文件有） */
  chunkInfo?: Record<string, ChunkInfo>;  // key: relPath###N → ChunkInfo
}
