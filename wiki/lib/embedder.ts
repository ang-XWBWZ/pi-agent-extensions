// embedder.ts — transformers.js 语义向量封装 (v4.2)
//
// 设计原则:
//   1. 懒加载 — 首次调用 initialize() 时才 import 和下载模型
//   2. 优雅降级 — @huggingface/transformers 未安装时 isAvailable() 返回 false
//   3. 单例 — 全局共享一个 FeatureExtractionPipeline
//   4. 多语言 — Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384-dim, 50+ 语言)
//   5. 本地优先 — wiki/models/ 本地模型优先于 HuggingFace Hub 远程下载
//   6. 精度自适应 — 优先加载 INT8 量化版 (~118MB)，回退 FP32 (~470MB)
//
// 本地模型目录结构:
//   wiki/models/paraphrase-multilingual-MiniLM-L12-v2/
//   ├── config.json
//   ├── tokenizer.json
//   ├── tokenizer_config.json
//   └── onnx/
//       ├── model.onnx             ← FP32 全精度 (~470 MB) — 回退选项
//       └── model_quantized.onnx   ← INT8 量化 (~118 MB) — 优先加载
//
// 下载指引:
//   基础 URL: https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/
//   国内镜像: https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/
//   所需文件: config.json, tokenizer.json, tokenizer_config.json,
//            onnx/model_quantized.onnx (推荐 INT8)  或  onnx/model.onnx (FP32)

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SEMANTIC_MODEL } from "./store.js";

// ---- 模型信息 ----

export interface LocalModelInfo {
  path: string;
  variant: "fp32" | "int8" | "none";
  /** ONNX 文件大小 (bytes) */
  onnxSize: number;
  /** 其他文件总大小 (bytes) */
  otherSize: number;
}

// ---- 状态 ----

let pipeline: any = null;
let currentModel: string = SEMANTIC_MODEL;
let initPromise: Promise<boolean> | null = null;
let initError: string | null = null;
let loadedVariant: string = "unknown";

/** wiki 模块根目录 */
function wikiHome(): string {
  return resolve(__dirname, "..");
}

/** 本地模型目录: <wiki>/models/<model_name>/ */
function localModelDir(): string {
  const name = currentModel.split("/").pop() || currentModel;
  return resolve(wikiHome(), "models", name);
}

/** 检测本地模型：config.json + onnx 目录存在即可 */
function hasLocalModel(): boolean {
  const dir = localModelDir();
  if (!existsSync(dir)) return false;
  if (!existsSync(resolve(dir, "config.json"))) return false;
  if (!existsSync(resolve(dir, "onnx"))) return false;
  // 至少有 model.onnx 或 model_quantized.onnx 之一
  const onnxDir = resolve(dir, "onnx");
  return existsSync(resolve(onnxDir, "model.onnx"))
      || existsSync(resolve(onnxDir, "model_quantized.onnx"));
}

/** 获取本地模型详情（精度、大小） */
export function getLocalModelInfo(): LocalModelInfo | null {
  if (!hasLocalModel()) return null;
  const dir = localModelDir();
  const onnxDir = resolve(dir, "onnx");

  // 优先量化版，回退全精度
  const quantFile = resolve(onnxDir, "model_quantized.onnx");
  const fullFile = resolve(onnxDir, "model.onnx");
  let variant: "fp32" | "int8" = "fp32";
  let onnxFile = fullFile;
  if (existsSync(quantFile)) {
    variant = "int8";
    onnxFile = quantFile;
  } else if (existsSync(fullFile)) {
    // 通过文件大小推断精度: > 300MB 大概率是 FP32
    try { variant = statSync(fullFile).size > 300_000_000 ? "fp32" : "int8"; } catch {}
  }

  let onnxSize = 0;
  let otherSize = 0;
  try { onnxSize = statSync(onnxFile).size; } catch {}
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
    try { otherSize += statSync(resolve(dir, f)).size; } catch {}
  }

  return { path: dir, variant, onnxSize, otherSize };
}

/** 格式化字节 */
function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 获取模型加载路径：本地路径优先，否则用 HuggingFace ID */
function resolveModelPath(): string {
  if (hasLocalModel()) {
    return localModelDir();
  }
  return currentModel;
}

// ---- 公开 API ----

/** 初始化 embedder（幂等，已初始化时立即返回 true） */
export async function initialize(model?: string): Promise<boolean> {
  if (pipeline) return true;
  if (initPromise) return initPromise;
  if (model) currentModel = model;
  initPromise = doInit();
  return initPromise;
}

/** 检查 embedder 是否就绪（不触发初始化） */
export function isAvailable(): boolean {
  return pipeline !== null;
}

/** 检查 @huggingface/transformers 是否已安装（尝试 import 但不加载模型） */
export async function isDependencyInstalled(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

/** 获取初始化错误信息 */
export function getInitError(): string | null {
  return initError;
}

/** 获取当前模型名 */
export function getModelName(): string {
  return currentModel;
}

/** 获取当前模型来源 + 精度 */
export function getModelSource(): string {
  if (!pipeline) return "未加载";
  const info = getLocalModelInfo();
  if (info) return `本地 (${info.variant.toUpperCase()}, ${fmtSize(info.onnxSize)})`;
  return `远程 (HuggingFace Hub)`;
}

/** 获取加载的精度变体 */
export function getLoadedVariant(): string {
  return loadedVariant;
}

/** 对单条文本生成 embedding (384-dim 归一化向量) */
export async function embed(text: string): Promise<number[]> {
  const pipe = await ensurePipeline();
  const result = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(result.data) as number[];
}

/** 批量生成 embeddings */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await ensurePipeline();
  const results: number[][] = [];
  for (const text of texts) {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    results.push(Array.from(result.data) as number[]);
  }
  return results;
}

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---- 内部 ----

async function doInit(): Promise<boolean> {
  try {
    const { pipeline: transformersPipeline, env } = await import(
      "@huggingface/transformers"
    );

    const isLocal = hasLocalModel();
    if (isLocal) {
      env.allowLocalModels = true;
    }

    const modelPath = resolveModelPath();
    // 本地模型：若仅有量化版，需显式指定 model_file_name
    const pipelineOpts: any = {};
    if (isLocal) {
      const onnxDir = resolve(localModelDir(), "onnx");
      if (!existsSync(resolve(onnxDir, "model.onnx"))
          && existsSync(resolve(onnxDir, "model_quantized.onnx"))) {
        // transformers.js 自动追加 onnx/ 前缀 + .onnx 后缀，这里只需给文件名主干
        pipelineOpts.model_file_name = "model_quantized";
      }
      pipelineOpts.progress_callback = null;
    }

    pipeline = await transformersPipeline(
      "feature-extraction",
      modelPath,
      pipelineOpts,
    );

    // 记录加载的精度
    const info = getLocalModelInfo();
    loadedVariant = info?.variant ?? "remote";

    initError = null;
    return true;
  } catch (e: any) {
    initError = e?.message || String(e);
    pipeline = null;
    return false;
  } finally {
    initPromise = null;
  }
}

async function ensurePipeline(): Promise<any> {
  if (pipeline) return pipeline;
  const ok = await initialize();
  if (!ok) throw new Error(`Embedder 未初始化: ${initError || "未知错误"}`);
  return pipeline;
}
