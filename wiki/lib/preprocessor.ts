// preprocessor.ts — 程序化元数据提取 (v5.2)
//
// 原则: 程序做能做的一切，LLM 只做需要语义理解的活。
//
// 7 个字段由规则/启发式/正则自动提取:
//   chunkType, contentClass, importance, temporalAnchor,
//   confidence, summary, keywords
//
// LLM 只负责 4 个语义字段:
//   topic, normalizedText, concepts, aliases

import type { ChunkInfo } from "./types.js";
import { extractChunksAST } from "./ast-chunker.js";

// ============================================================
// 推断规则
// ============================================================

/** chunkType: markdown 特征推断 */
export function inferChunkType(text: string, heading: string): string {
  if (/```[\s\S]*?```/.test(text)) return "code";
  if (/^\s*[-*]\s*\[ \]/m.test(text)) return "todo";
  if (/^\s*[-*]\s*\[x\]/im.test(text)) return "log";
  if (/^#{1,4}\s*(架构|拓扑|结构|方案)/.test(heading))
    return "architecture";
  if (/^#{1,4}\s*(决定|决策|结论|决议)/.test(heading))
    return "decision";
  if (/^#{1,4}\s*(参考|链接|相关|资源|附录)/.test(heading))
    return "reference";
  if (/^#{1,4}\s*(问题|排查|故障|报错|异常)/.test(heading))
    return "question";
  if (/^#{1,4}\s*(日志|记录|日报|周报|流水)/.test(heading))
    return "log";
  if (/^#{1,4}\s*(想法|思路|灵感|idea)/i.test(heading))
    return "idea";
  if (
    /^#{1,4}\s*(研究|调研|分析|探索)/.test(heading)
  )
    return "research";
  if (text.length < 50) return "reference";
  return "note";
}

/** contentClass: 文件路径推断 */
export function inferContentClass(relPath: string): string {
  if (
    /chatgpt|聊天|对话|conversation/i.test(relPath)
  )
    return "conversation";
  if (
    /日报|更新|会议|流水|日志|记录|周报/i.test(
      relPath,
    )
  )
    return "event";
  if (
    /知识点|规范|标准|原理|手册|指南|教程|总结/i.test(
      relPath,
    )
  )
    return "knowledge";
  return "reference";
}

/** importance: 启发式打分 (0.1-1.0) */
export function inferImportance(
  text: string,
  heading: string,
): number {
  let score = 0.3;
  if (text.length > 200) score += 0.2;
  if (text.length > 500) score += 0.1;
  if (/```/.test(text)) score += 0.15;
  if (/^#{1,3}\s/.test(heading)) score += 0.1;
  if (
    /错误|异常|故障|问题|解决|修复|排查/.test(text)
  )
    score += 0.1;
  if (
    /TODO|待办|以后|FIXME|临时|暂存/i.test(text)
  )
    score -= 0.3;
  return Math.max(0.1, Math.min(1, score));
}

/** temporalAnchor: 正则提取第一个 YYYY-MM-DD */
export function inferTemporalAnchor(
  text: string,
): string | undefined {
  const m = text.match(
    /\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\b/,
  );
  return m ? m[1].replace(/\//g, "-") : undefined;
}

/** confidence: 基于文本长度的预设置信度 */
export function inferConfidence(text: string): number {
  if (text.length < 20) return 0.3;
  if (text.length < 80) return 0.6;
  return 0.85;
}

/** summary: 清洗后取前 30 字 */
export function inferSummary(text: string): string {
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, "[代码]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|\*|_|`|~~/g, "")
    .replace(/\n/g, " ")
    .trim();
  return cleaned.slice(0, 30);
}

/** keywords: 英文标识符 + 中文高频词预提取 */
export function inferKeywords(
  text: string,
): string[] {
  const en =
    text.match(/\b[a-z_]{3,}\b/gi) || [];
  const zh =
    text.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  const all = [...new Set([...en, ...zh])];
  // 停用词过滤
  const stop = new Set([
    "可以",
    "一个",
    "这个",
    "不是",
    "还是",
    "如果",
    "因为",
    "所以",
    "但是",
    "而且",
    "或者",
    "以及",
    "就是",
    "没有",
    "已经",
    "什么",
    "怎么",
    "这样",
    "那样",
    "时候",
    "问题",
    "需要",
    "通过",
    "进行",
    "使用",
    "用于",
    "可能",
    "应该",
    "然后",
    "the",
    "and",
    "for",
    "from",
    "with",
    "that",
    "this",
    "are",
    "not",
    "but",
    "has",
    "was",
  ]);
  return all.filter((w) => !stop.has(w)).slice(0, 8);
}

// ============================================================
// 文件级预处理: 对全文做基础分块 + 提取元数据
// ============================================================

/** 预处理器对文件全文的输出 */
export interface PreprocessedChunk {
  /** 程序切分的块（按标题简单切，仅作兜底） */
  heading: string;
  level: number;
  text: string; // 块原文
  /** 程序提取的元数据 */
  chunkType: string;
  contentClass: string;
  importance: number;
  temporalAnchor?: string;
  confidence: number;
  summary: string;
  keywords: string[];
}

/**
 * 对文件全文做预处理: AST 分块 + 提取每段元数据。
 * v5.3: 复用 ast-chunker 替代 regex 逐行扫描。
 * 这是兜底分块 — LLM 在文件级编译时可能输出不同的 segments。
 */
export async function preprocessFile(
  relPath: string,
  fullText: string,
  defaultTitle: string,
): Promise<PreprocessedChunk[]> {
  // v5.3: 优先 AST 分块
  const astChunks = await extractChunksAST(fullText, relPath, defaultTitle);

  // 如果 AST 成功，直接映射
  if (astChunks.length > 0) {
    return astChunks.map((c) => ({
      heading: c.heading,
      level: c.level,
      text: c.rawText,
      chunkType: c.chunkTypeHint || inferChunkType(c.rawText, c.heading),
      contentClass: inferContentClass(relPath),
      importance: inferImportance(c.rawText, c.heading),
      temporalAnchor: inferTemporalAnchor(c.rawText),
      confidence: inferConfidence(c.rawText),
      summary: inferSummary(c.rawText),
      keywords: inferKeywords(c.rawText),
    }));
  }

  // ── fallback: regex 逐行扫描 ──
  const lines = fullText.split("\n");
  const sections: { heading: string; level: number; lines: string[] }[] = [];

  for (const line of lines) {
    const m = line.match(/^#{1,4}\s/);
    if (m) {
      const heading = line.trim();
      const level = heading.match(/^#+/)![0].length;
      sections.push({ heading, level, lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    } else {
      sections.push({ heading: defaultTitle, level: 0, lines: [] });
      sections[0].lines.push(line);
    }
  }

  if (sections.length === 0) {
    sections.push({ heading: defaultTitle, level: 0, lines });
  }

  // 跳过 frontmatter
  if (sections[0]?.lines[0]?.trim() === "---" || sections[0]?.heading === "---") {
    const fmEnd = sections[0].lines.findIndex((l) => l.trim() === "---", 1);
    if (fmEnd > 0) sections[0].lines = sections[0].lines.slice(fmEnd + 1);
  }

  return sections.map((s) => {
    const text = s.lines.join("\n").trim();
    return {
      heading: s.heading,
      level: s.level,
      text,
      chunkType: inferChunkType(text, s.heading),
      contentClass: inferContentClass(relPath),
      importance: inferImportance(text, s.heading),
      temporalAnchor: inferTemporalAnchor(text),
      confidence: inferConfidence(text),
      summary: inferSummary(text),
      keywords: inferKeywords(text),
    };
  });
}
