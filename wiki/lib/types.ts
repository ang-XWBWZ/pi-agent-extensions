// types.ts — Wiki 插件所有类型定义 (v2.3)

/** wiki.json — 仓库元数据（存储在 repo/wiki.json） */
export interface WikiMeta {
  name: string;
  description?: string;
  sources: string[];
  created: string;
  updated: string;
}

/** index.json — wiki 索引 */
export interface WikiIndex {
  version: number;
  updatedAt: string;
  entryCount: number;
  trees: Record<string, WikiTree>;
  entries: Record<string, WikiEntry>;
}

export interface WikiTree {
  label: string;
  entries: string[];
}

export interface WikiEntry {
  file: string;
  title: string;
  source: string;
  parent: string;
  tags: string[];
  status: "draft" | "complete";
  updatedAt: string;
}

export interface SearchHit {
  entryId: string;
  title: string;
  source: string;
  snippet: string;
  score: number;
  status: string;
}
