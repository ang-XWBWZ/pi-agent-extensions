// types.ts — Wiki 插件类型 (v5.1 语义编译)

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

/** 文档块信息（标题分块 + 语义编译元数据）
 *
 * 基础字段 (索引时自动填充):
 *   heading, level
 *
 * 编译字段 (AI 通过 wiki_store_compiled 填充):
 *   topic, summary, concepts, entities, aliases, keywords,
 *   normalizedText, chunkType, importance, confidence
 */
export interface ChunkInfo {
  // ---- 基础 -------
  heading: string;    // 标题文本（含 # 标记，如 "## 依赖关系"）
  level: number;      // 标题级别 1-4

  // ---- 编译 -------
  topic?: string;            // 核心主题（一句话）
  summary?: string;          // 一句话摘要
  concepts?: string[];       // 核心概念（如 "stale closure", "cache invalidation"）
  entities?: string[];       // 实体（工具名、项目名、人名）
  aliases?: string[];        // 同义表达（中英对照、缩写展开）
  keywords?: string[];       // 检索关键词
  normalizedText?: string;   // 规范化后的文本（补全省略、统一术语）
  chunkType?: string;        // concept | note | code | reference | todo | idea | question | architecture | decision | log | research
  importance?: number;       // 重要性 0-1
  confidence?: number;       // AI 编译置信度 0-1

  // ---- 分类 (程序预提取) ----
  contentClass?: string;     // knowledge | event | conversation | reference (preprocessor 推断)
  temporalAnchor?: string;   // 事件类的时间锚点（preprocessor 正则提取）
}

/** 待编译的原始块（wiki_get_chunks_raw 工具返回） */
export interface RawChunk {
  key: string;         // "relPath###N"
  relPath: string;
  heading: string;     // 原始标题（含 #）
  rawText: string;     // 块原始文本（去 markdown 标记前）
  compiled: boolean;   // 是否已有编译数据
}

/** AI 编译产出（块级，wiki_store_compiled 工具接收） */
export interface CompiledChunk {
  key: string;              // 必须与 RawChunk.key 一致
  topic: string;
  normalizedText: string;
  concepts: string[];
  aliases: string[];
}

/** v5.2 文件级编译: LLM 自行分割的语义片段 */
export interface FileSegment {
  text: string;              // 片段原文（LLM 自行决定边界）
  topic: string;
  normalizedText: string;
  concepts: string[];
  aliases: string[];
}

// ---- v5.4 文件级 LLM 编译 ----

/** LLM 文件级编译输出 */
export interface FileLLMData {
  topic: string;
  normalizedText: string;
  concepts: string[];
  aliases: string[];
}

/** compiled/*.json 文件格式 */
export interface CompiledFileRecord {
  relPath: string;
  compiledAt: string;
  sourceMD5: string;
  model: string;
  result: FileLLMData;
  embeddingText: string;
  vectorKey: string;
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
  /** 全局质心（噪声基底），用于搜索降噪 */
  centroid?: number[];
}
