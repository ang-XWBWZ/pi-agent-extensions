// model-registry.ts — 模型中间层 (v1.0)
//
// 提供内置模型目录 + 选择/查询 API，让 wiki 搜索与具体模型解耦。
// store.ts 只存 currentModelId 字符串，所有模型元信息由此 registry 提供。
//
// 添加新模型: 在 BUILTIN_MODELS 数组中追加一条即可。
// embedder / indexer / management 通过 getCurrentModel() 自动适配。

import { readModelId, writeModelId } from "./store.js";

// ---- 类型 ----

export interface ModelInfo {
  /** 短标识符: "bge-base-zh-v1.5" */
  id: string;
  /** 显示名 */
  name: string;
  /** HuggingFace 仓库 ID（transformers.js 兼容的 ONNX 转换版） */
  hfRepo: string;
  /** 向量维度 */
  dim: number;
  /** 一行描述 */
  description: string;
  /** 支持语言 */
  languages: string[];
  /** 最大输入 token 数 */
  maxTokens: number;
  /** INT8 量化版 ONNX 文件大小 (bytes, 约) */
  int8Size: number;
  /** FP32 全精度 ONNX 文件大小 (bytes, 约) */
  fp32Size: number;
}

// ---- 内置模型目录 ----

export const BUILTIN_MODELS: ModelInfo[] = [
  {
    id: "bge-base-zh-v1.5",
    name: "BGE Base Chinese v1.5",
    hfRepo: "Xenova/bge-base-zh-v1.5",
    dim: 768,
    description: "BAAI 中文优化，MTEB 中文榜单领先，适合中文技术文档语义搜索",
    languages: ["zh", "en"],
    maxTokens: 512,
    int8Size: 130_000_000,   // ~130 MB
    fp32Size: 390_000_000,   // ~390 MB
  },
  {
    id: "bge-large-zh-v1.5",
    name: "BGE Large Chinese v1.5",
    hfRepo: "Xenova/bge-large-zh-v1.5",
    dim: 1024,
    description: "BAAI 中文大模型，1024 维高精度，适合对中文精度有较高要求的笔记 wiki 化",
    languages: ["zh", "en"],
    maxTokens: 512,
    int8Size: 324_000_000,   // ~324 MB
    fp32Size: 1_300_000_000, // ~1.3 GB
  },
  {
    id: "paraphrase-multilingual",
    name: "Paraphrase Multilingual MiniLM",
    hfRepo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    description: "轻量多语言模型，50+ 语言，适合混合语言知识库",
    languages: ["zh", "en", "fr", "de", "ja", "ko", "..."],
    maxTokens: 128,
    int8Size: 118_000_000,   // ~118 MB
    fp32Size: 470_000_000,   // ~470 MB
  },
  {
    id: "bge-m3",
    name: "BGE M3",
    hfRepo: "Xenova/bge-m3",
    dim: 1024,
    description: "BAAI 多语言多粒度模型，100+ 语言，支持长文本 (8192 token)，中英混合笔记首选",
    languages: ["zh", "en", "fr", "de", "ja", "ko", "es", "ru", "ar", "..."],
    maxTokens: 8192,
    int8Size: 340_000_000,   // ~340 MB (O4 量化)
    fp32Size: 2_200_000_000, // ~2.2 GB
  },
];

// ---- 查询 API ----

/** 获取所有内置模型 */
export function getBuiltinModels(): ModelInfo[] {
  return BUILTIN_MODELS;
}

/** 按 id 查找模型 */
export function findModel(id: string): ModelInfo | undefined {
  return BUILTIN_MODELS.find(m => m.id === id);
}

/** 获取当前选中的模型元信息 */
export function getCurrentModel(): ModelInfo {
  const id = readModelId();
  return findModel(id) ?? BUILTIN_MODELS[0];
}

/** 切换模型 — 返回新模型信息，若 id 不存在返回 null */
export function selectModel(id: string): ModelInfo | null {
  const m = findModel(id);
  if (!m) return null;
  writeModelId(m.id);
  return m;
}

/** 默认模型 id */
export function getDefaultModelId(): string {
  return BUILTIN_MODELS[0].id;
}
