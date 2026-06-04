// semantic-compiler.ts — 语义编译器 prompt (v5.2)
//
// v5.2: 文件级编译为主，块级编译兜底。
//   LLM 只做 4 件事: topic, normalizedText, concepts, aliases + 自判语义边界
//   程序做其余 7 件事 (→ preprocessor.ts)
//
// 蓝图参考: §24 Agent System Prompt, §25 User Prompt Template, §14 embedding_text

import type { RawChunk, CompiledChunk, FileSegment } from "./types.js";
import type { PreprocessedChunk } from "./preprocessor.js";

// ============================================================
// 常量
// ============================================================

/** 推荐每批处理的 chunk 数（平衡上下文大小和效率） */
export const BATCH_SIZE = 25;

// ============================================================
// System Prompt (蓝图 §24)
// ============================================================

export const COMPILE_SYSTEM_PROMPT = `你是一个"知识语义编译器"。

你的任务不是总结内容。

你的任务是：
将人类随手记录的非结构化笔记，
转换为适合机器语义索引、概念检索、
知识聚类、长期演化的"认知知识单元"。

核心原则：
1. 保留原始信息 — 不删技术细节
2. 不改变原意 — 只规范化表达
3. 补全隐式表达 — 补充省略的主语、展开缩写
4. 统一术语 — 将同义表达归一（如 "状态污染" ↔ "stale closure"）
5. 提取核心概念 — 识别技术关键词
6. 保持单主题 — 一个 chunk 只描述一个认知主题
7. 输出结构化 JSON — 严格遵循 schema

禁止：
1. 过度总结
2. 删除原文
3. 改写逻辑
4. 主观推断
5. 引入不存在的信息

你的角色是："语义标准化器"，不是"内容作者"。`;

// ============================================================
// User Prompt 构建 (蓝图 §25)
// ============================================================

/** 为一批 chunk 构建编译 prompt */
export function buildCompilePrompt(chunks: RawChunk[]): string {
  const chunkBlocks = chunks
    .map((c, i) => {
      const contextLines: string[] = [
        `--- CHUNK #${i + 1} ---`,
        `KEY: ${c.key}`,
        `FILE: ${c.relPath}`,
        `HEADING: ${c.heading || "(无标题)"}`,
      ];
      // E2: 注入文件级上下文
      if (c.fileTags?.length) {
        contextLines.push(`FILE_TAGS: [${c.fileTags.join(", ")}]`);
      }
      if (c.headingPath) {
        contextLines.push(`HEADING_PATH: ${c.headingPath}`);
      }
      if (c.siblingHeadings?.length) {
        contextLines.push(
          `SIBLING_HEADINGS: [${c.siblingHeadings.join(" | ")}]`,
        );
      }
      if (c.totalChunks && c.totalChunks > 1) {
        const pos = `${(c.chunkIndex ?? 0) + 1}/${c.totalChunks}`;
        const role =
          (c.chunkIndex ?? 0) === 0
            ? " (开头)"
            : (c.chunkIndex ?? 0) === c.totalChunks - 1
              ? " (结尾)"
              : " (中间)";
        contextLines.push(`CHUNK_POSITION: ${pos}${role}`);
      }
      contextLines.push("", c.rawText);
      return contextLines.join("\n");
    })
    .join("\n\n");

  return `请分析以下 ${chunks.length} 个笔记块。

## 上下文说明

每个块附带以下上下文信息，请善用以理解块在文件和笔记体系中的位置：
- FILE_TAGS: 文件级别的标签，反映所属领域（如 AMI, DLMS）
- HEADING_PATH: 块的标题层级路径（如 "10.18AMI更新 > 排查过程"）
- SIBLING_HEADINGS: 同一文件内所有块的标题，帮助你理解块之间的前后关系
- CHUNK_POSITION: 本块在文件中的位置和角色（开头/中间/结尾）

## 输出字段

对每个块，输出一个 JSON 对象，包含以下字段：

{
  "key": "块标识（与输入的 KEY 一致）",
  "topic": "核心主题（一句话）",
  "summary": "一句话摘要（≤30 字）",
  "concepts": ["提取的技术概念"],
  "entities": ["实体名称"],
  "aliases": ["同义表达，格式 '中文 ↔ English'"],
  "keywords": ["检索关键词"],
  "normalizedText": "规范化后的文本（补全省略、统一术语、保留所有技术细节）",
  "chunkType": "concept | note | code | reference | todo | idea | question | architecture | decision | log | research",
  "importance": 0.0-1.0,
  "confidence": 0.0-1.0,
  "contentClass": "knowledge | event | conversation | reference",
  "temporalAnchor": "如果内容是事件类，提取时间锚点（如 '2024-10-18'），否则省略",
  "followsChunk": "如果有 SIBLING_HEADINGS 且本块不是第一个，填写前一个块的 KEY",
  "precedesChunk": "如果有 SIBLING_HEADINGS 且本块不是最后一个，填写后一个块的 KEY",
  "siblingHeadings": ["同文件所有块的标题列表（复制 SIBLING_HEADINGS）"]
}

## 关系字段判断指南

contentClass 判断：
- knowledge: 无时间性的技术知识、编码规范、原理说明
- event: 有时间锚点的故障记录、更新日志、会议记录
- conversation: 对话推理链中的片段（隐式引用前文）
- reference: 纯参考列表、配置清单、目录结构

followsChunk/precedesChunk：
- 仅在 SIBLING_HEADINGS 明确显示了前后顺序时填写
- 使用 CHUNK #N 中的 KEY 值
- 如果块之间无明显因果/时序关系，留空

temporalAnchor：
- 仅在 contentClass=event 时尝试提取
- 从 FILE_TAGS、HEADING_PATH 或文本本身提取日期
- 格式: YYYY-MM-DD，无法确定则留空

## 注意事项

- normalizedText 必须保留 ALL 技术细节
- importance: 高价值技术知识 0.8+，TODO/碎片 0.3-，普通笔记 0.5
- confidence: 信息完整明确 0.9+，曖昧 0.5-
- 所有关系字段为可选 —— 如果无法判断，留空而非猜测

返回格式：一个 JSON 数组，包含 ${chunks.length} 个对象。
不要 markdown 代码块包裹，直接输出 JSON 数组。

${chunkBlocks}`;
}

// ============================================================
// embeddingText 构建 (蓝图 §14)
// ============================================================

/**
 * 从编译后的 ChunkInfo 构建最优 embedding 输入
 *
 * 蓝图推荐格式:
 *   [TOPIC] + [CONCEPTS] + [ALIASES] + [KEYWORDS] + [NORMALIZED] + [RAW]
 *
 * 原因: 增强隐式语义，让向量模型在检索时更稳定地匹配
 */
export function buildEmbeddingText(
  topic: string,
  normalizedText: string,
  concepts: string[],
  aliases: string[],
  keywords: string[],
  contentClass: string,
  temporalAnchor: string | undefined,
  rawText: string,
): string {
  const parts: string[] = [];
  if (contentClass) parts.push(`[CLASS] ${contentClass}`);
  if (temporalAnchor) parts.push(`[TIME] ${temporalAnchor}`);
  if (topic) parts.push(`[TOPIC] ${topic}`);
  if (concepts?.length) parts.push(`[CONCEPTS] ${concepts.join("; ")}`);
  if (aliases?.length) parts.push(`[ALIASES] ${aliases.join("; ")}`);
  if (keywords?.length) parts.push(`[KEYWORDS] ${keywords.join("; ")}`);
  if (normalizedText) parts.push(`[NORMALIZED] ${normalizedText}`);
  if (rawText) parts.push(`[RAW] ${rawText.slice(0, 400)}`);
  return parts.join("\n");
}

// ============================================================
// 工具：解析 AI 返回的 JSON 数组
// ============================================================

/** 尝试从 LLM 响应中提取 CompiledChunk 数组 */
export function parseCompiledResult(
  text: string,
): CompiledChunk[] | null {
  try {
    // 去除可能的 markdown 代码块包裹
    let json = text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    // 基本校验
    for (const item of arr) {
      if (!item.key || !item.normalizedText) return null;
    }
    return arr as CompiledChunk[];
  } catch {
    return null;
  }
}

// ============================================================
// v5.2 文件级编译
// ============================================================

/** 文件级编译 System Prompt（只要求 LLM 做 4 件事） */
export const FILE_COMPILE_SYSTEM_PROMPT = `你是一个"知识语义编译器"。

你的任务: 将整篇笔记转换为结构化的语义知识单元。

你需要做的 4 件事:
1. 自行判断语义边界 — 将文件分成若干连续的语义片段（segments）
2. 为每个片段写出 topic（核心主题，一句话）
3. 为每个片段写出 normalizedText（规范化文本：补全省略、统一术语、保留所有技术细节）
4. 为每个片段提取 concepts（技术概念）和 aliases（同义表达，格式 "中文 ↔ English"）

核心原则:
- 保留原始信息 — 不删技术细节（API 名、参数、错误信息、缩写）
- 不改变原意 — 只规范化表达
- 语义边界 = 同一认知主题的自然段或连续段落
- 如果整个文件是单一主题，只输出 1 个 segment

禁止: 过度总结、删除原文、改写逻辑、主观推断、引入不存在的信息。`;

/**
 * 为文件级编译构建 prompt
 * @param relPath      文件路径
 * @param fullText     文件全文
 * @param preprocessed 预处理器输出（仅展示给 LLM 参考）
 */
export function buildFileCompilePrompt(
  relPath: string,
  fullText: string,
  preprocessed: PreprocessedChunk[],
): string {
  const preSummary = preprocessed
    .slice(0, 5)
    .map(
      (p) =>
        `  - ${p.heading || "(无标题)"} [${p.chunkType}, ${p.contentClass}, imp=${p.importance.toFixed(1)}]`,
    )
    .join("\n");

  return `请分析以下笔记文件。

文件: ${relPath}
程序预分析（仅供参考，你不需填写这些字段）:
${preSummary}

你需要输出一个 JSON 对象:

{
  "segments": [
    {
      "text": "片段原文（从文件中截取）",
      "topic": "核心主题（一句话）",
      "normalizedText": "规范化文本",
      "concepts": ["技术概念"],
      "aliases": ["同义表达 (格式: 中文 ↔ English)"]
    }
  ]
}

注意事项:
- segments 按文件顺序排列
- 语义边界你自己判断: 同一认知主题归为一个 segment
- 一个 segment 可以包含多个自然段
- 至少输出 1 个 segment
- normalizedText 必须保留 ALL 技术细节
- 不要 markdown 代码块包裹，直接输出 JSON

=== 文件全文 ===

${fullText}`;
}

/** 从 LLM 响应中提取 FileSegment 数组 */
export function parseFileSegments(text: string): FileSegment[] | null {
  try {
    let json = text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const obj = JSON.parse(json);
    const arr = obj.segments ?? obj;
    if (!Array.isArray(arr)) return null;
    for (const item of arr) {
      if (!item.topic || !item.normalizedText) return null;
    }
    return arr as FileSegment[];
  } catch {
    return null;
  }
}

// ============================================================
// v5.4 文件级编译（简化版：不要求 segments，只要求 1 个文件的 4 字段）
// ============================================================

/** v5.4 文件级 System Prompt（极简版） */
export const FILE_LLM_SYSTEM_PROMPT = `你是一个"知识语义编译器"。

你的任务: 将整篇笔记转换为结构化的语义元数据，用于增强语义搜索。

你需要输出的 4 个字段:
1. topic — 核心主题（一句话概括全文）
2. normalizedText — 规范化文本（补全省略主语、统一术语、保留所有技术细节）
3. concepts — 技术概念列表（3-8 个核心概念）
4. aliases — 同义表达（格式 "中文 ↔ English"，2-5 组）

核心原则:
- 保留所有技术细节（API 名、参数、错误信息、缩写、版本号）
- 不改变原意，只规范化表达
- concepts 提取技术关键词，不是摘要
- aliases 覆盖中英对照和缩写展开

禁止: 过度总结、删除原文、改写逻辑、主观推断、引入不存在的信息。`;

/**
 * v5.4 构建简化文件级编译 prompt
 */
export function buildFileLLMPrompt(
  relPath: string,
  fullText: string,
): string {
  return `请分析以下笔记文件，提取语义元数据。

文件: ${relPath}

输出一个 JSON 对象:

{
  "topic": "核心主题（一句话）",
  "normalizedText": "规范化文本",
  "concepts": ["技术概念1", "技术概念2"],
  "aliases": ["中文 ↔ English"]
}

不要 markdown 代码块包裹，直接输出 JSON。

=== 文件全文 ===

${fullText}`;
}

/**
 * v5.4 解析文件级 LLM 响应（单对象，非 segments 数组）
 */
export function parseFileLLMResult(
  text: string,
): import("../lib/types.js").FileLLMData | null {
  try {
    let json = text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```json?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const obj = JSON.parse(json);
    // 兼容 v5.2 segments 格式 → 取第一个 segment
    if (obj.segments && Array.isArray(obj.segments) && obj.segments.length > 0) {
      const s = obj.segments[0];
      return { topic: s.topic, normalizedText: s.normalizedText, concepts: s.concepts || [], aliases: s.aliases || [] };
    }
    // v5.4 新格式
    if (obj.topic && obj.normalizedText) {
      return {
        topic: obj.topic,
        normalizedText: obj.normalizedText,
        concepts: obj.concepts || [],
        aliases: obj.aliases || [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * v5.4 构建文件级 LLM 向量的 embedding 文本
 */
export function buildFileLLMEmbeddingText(data: import("../lib/types.js").FileLLMData, relPath?: string, maxEmbedLen = 2000): string {
  const parts: string[] = [];
  // 路径语义注入
  if (relPath) {
    const pathContext = relPath.replace(/\\/g, "/").replace(/\//g, " > ").replace(/\.md$/i, "");
    parts.push(`[PATH] ${pathContext}`);
  }
  if (data.topic) parts.push(`[TOPIC] ${data.topic}`);
  if (data.concepts?.length) parts.push(`[CONCEPTS] ${data.concepts.join("; ")}`);
  if (data.aliases?.length) parts.push(`[ALIASES] ${data.aliases.join("; ")}`);
  if (data.normalizedText) parts.push(`[NORMALIZED] ${data.normalizedText.slice(0, maxEmbedLen)}`);
  return parts.join("\n");
}
