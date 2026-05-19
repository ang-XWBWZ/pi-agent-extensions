// types.ts — Wiki 插件类型 (v3.0 极简版)

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

/** 搜索结果 */
export interface SearchHit {
  relPath: string;
  sourceDir: string;
  title: string;
  tags: string[];
  snippet: string;
  score: number;
}
