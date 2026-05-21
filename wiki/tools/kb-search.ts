// kb-search.ts — kb_search 工具 (v5.0)
// 支持分页、文档摘要、可收缩 TUI 展示
// TUI 最多 5 条，AI 内部最多 10 条/页，返回总数

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolRenderResultOptions, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { keywordSearch } from "../lib/search.js";
import { semanticSearch, hybridSearch } from "../lib/semantic-search.js";
import { getSemanticEnabled } from "../lib/store.js";
import type { SearchHit, SearchMode } from "../lib/types.js";

const AI_LIMIT = 5;        // AI 内部每页最多条目
const TUI_LIMIT = 5;       // TUI 收缩模式最多显示条目
const SUMMARY_LEN = 200;   // 文档摘要长度

import { getContent } from "../lib/content-cache.js";

/** P0-3: 从内存缓存提取摘要，不再读磁盘 */
function extractSummary(_sourceDir: string, relPath: string): string {
  const raw = getContent(relPath);
  if (!raw) return "";
  try {
    // 去掉 frontmatter
    const fmEnd = raw.match(/^---\n[\s\S]*?\n---/);
    const body = fmEnd ? raw.slice(fmEnd[0].length).trim() : raw;
    // 去 markdown 标记取纯文本
    const plain = body
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*|__|\*|_|`|~~/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\n{2,}/g, " ")
      .replace(/\n/g, " ")
      .trim();
    return plain.slice(0, SUMMARY_LEN);
  } catch {
    return "";
  }
}

export function registerKbSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kb_search",
    label: "Wiki Search",
    description:
      "搜索 wiki 知识库。支持 keyword / semantic / hybrid 模式。每页最多 10 条，返回总数。",
    promptSnippet: "Search wiki knowledge base",
    promptGuidelines: [
      // ── 搜索策略：拆解 · 翻译 · 联想 · 组合 ──
      // ── 工作流前置 ──
      "## Wiki Setup (required before searching)",
      "Minimal: wiki_load_source → kb_search works with keyword mode.",
      "Recommended: wiki_load_source → wiki_semantic(action='on') → kb_search (hybrid mode, bge embedding).",
      "Best: above + wiki_compile_file on key notes → wiki_store_file_compiled → kb_search (LLM-normalized concepts).",
      "",
      "Semantic search (wiki_semantic(action='on')) uses bge ONNX to embed raw text directly.",
      "Semantic compilation (wiki_compile_file) uses LLM to normalize text BEFORE embedding — higher quality.",
      "They are independent steps. Compilation is optional but recommended for fragmented/personal notes.",
      "",
      // ── 搜索策略：拆解 · 翻译 · 联想 · 组合 ──
      "BEFORE searching, decompose the user's query: identify abbreviations, mixed-language terms, compound concepts, and domain jargon.",
      "For the FIRST search, construct keyword variants by:",
      "  • Expanding abbreviations to full names",
      "  • Translating between the user's language and the knowledge base's dominant language",
      "  • Splitting compound terms and searching core concepts separately",
      "  • Trying domain synonyms or alternative phrasings",
      "A query that fails on its raw form may succeed on a translated, expanded, or simplified variant. Do NOT re-search with the same query.",
      // ── 模式选择 ──
      "PREFER keyword mode. Semantic/hybrid adds noise on short/technical queries and does NOT understand abbreviations.",
      "Use semantic mode only for vague natural-language intent.",
      "Each page returns up to 5 results (3 when fullContent=true). Check total count — if ≤5, no pagination needed.",
      // ── 刹车 ──
      "STOP after at most 2 kb_search calls. After 2 searches, present results and ASK the user before reading any document.",
      "Never auto-read wiki_get_entry. Wait for the user to pick one.",
      // ── 无结果 ──
      "If no results: try a different variant immediately. If still no results after 2: tell user and STOP.",
      "If no results, suggest loading a data source via wiki_load_source.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      mode: Type.Optional(
        Type.String({ description: "搜索模式: keyword | semantic | hybrid（默认根据语义开关自动选择）" })
      ),
      fullContent: Type.Optional(Type.Boolean({ description: "是否返回完整内容（默认 false）" })),
      page: Type.Optional(Type.Number({ description: "页码（1-based，默认 1）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      // 确定搜索模式
      const validModes: SearchMode[] = ["keyword", "semantic", "hybrid"];
      const reqMode = params.mode as SearchMode | undefined;
      const defaultMode: SearchMode = getSemanticEnabled() ? "hybrid" : "keyword";
      const mode: SearchMode =
        reqMode && validModes.includes(reqMode) ? reqMode : defaultMode;

      // 执行搜索
      let hits: SearchHit[];
      if (mode === "semantic") {
        hits = await semanticSearch(params.query);
      } else if (mode === "hybrid") {
        hits = await hybridSearch(params.query);
      } else {
        hits = keywordSearch(params.query);
      }

      const total = hits.length;

      if (!total) {
        return {
          content: [{ type: "text", text: `🔍 未匹配 "${params.query}"` }],
          details: { query: params.query, hits: 0, mode },
        };
      }

      const fullContent = params.fullContent === true;
      const page = Math.max(1, params.page ?? 1);
      const limit = fullContent ? 3 : AI_LIMIT;
      const start = (page - 1) * limit;
      const pageHits = hits.slice(start, start + limit);

      // 补充文档摘要
      for (const h of pageHits) {
        if (!h.summary) {
          h.summary = extractSummary(h.sourceDir, h.relPath);
        }
      }

      const modeLabel = mode === "semantic" ? " 语义" : mode === "hybrid" ? " 混合" : " 关键词";
      const pageInfo = total > limit ? ` 第${page}页` : "";

      // 构建纯文本结果（给 AI 看）
      const isKeyword = mode === "keyword";
      const lines: string[] = [];
      for (const h of pageHits) {
        const tagStr = h.tags.length > 0 ? ` [${h.tags.join(", ")}]` : "";
        lines.push(`📄 ${h.title}${tagStr}`);
        lines.push(`   ${h.relPath}`);
        if (h.snippet) {
          lines.push(`   ${h.snippet.replace(/\n/g, "\n   ")}`);
        }
        if (h.summary) {
          lines.push(`   ${h.summary.slice(0, 150)}`);
        }
        lines.push("");
      }

      return {
        content: [{
          type: "text",
          text: `🔍 "${params.query}" — ${total} 结果${modeLabel}${pageInfo}\n\n${lines.join("\n")}`,
        }],
        details: {
          query: params.query,
          total,
          page,
          results: pageHits,
          mode,
          fullContent,
        },
      };
    },

    renderResult(result, options, theme, context) {
      const container = (context.lastComponent as Container) ?? new Container();
      container.clear();
      const d = result.details as {
        query: string; total: number; page: number;
        results: SearchHit[]; fullContent?: boolean; mode?: string;
      };
      if (!d || !d.results?.length) {
        container.addChild(new Text(theme.fg("muted", "(无结果)"), 0, 0));
        return container;
      }

      const modeLabel = d.mode === "semantic" ? " 语义"
        : d.mode === "hybrid" ? " 混合"
        : d.fullContent ? " 全文" : " 关键词";
      const pageLabel = d.total > AI_LIMIT ? ` · 第${d.page}页` : "";
      const isKeyword = d.mode === "keyword";
      const MAX_LINE = 100;  // v5.4: 行长限制防崩溃

      container.addChild(new Text(theme.bold(`🔍 "${d.query}" — ${d.total} 结果${modeLabel}${pageLabel}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", "─".repeat(Math.min(50, MAX_LINE))), 0, 0));

      if (options.expanded) {
        // 展开：标题 + snippet/摘要 + 路径（最不显眼）
        for (let i = 0; i < d.results.length; i++) {
          const h = d.results[i];
          container.addChild(new Text(theme.fg("accent", `${i + 1}. ${h.title}`.slice(0, MAX_LINE)), 0, 0));
          // snippet 优先（关键词行上下文 / 语义 chunkHeading）
          if (h.snippet) {
            for (const sl of h.snippet.split("\n").slice(0, 3)) {
              if (sl.trim()) container.addChild(new Text(theme.fg("muted", `   ${sl.slice(0, MAX_LINE)}`), 0, 0));
            }
          }
          // 摘要兜底
          if (h.summary && !h.snippet) {
            container.addChild(new Text(theme.fg("muted", `   ${h.summary.slice(0, MAX_LINE)}`), 0, 0));
          }
          // 路径放在最后，最不显眼
          container.addChild(new Text(theme.fg("dim", `   ${h.relPath}`.slice(0, MAX_LINE)), 0, 0));
        }
      } else {
        // 收缩：单行横排，最多 TUI_LIMIT 条
        const visible = d.results.slice(0, TUI_LIMIT);
        for (let i = 0; i < visible.length; i++) {
          const h = visible[i];
          const raw = `${i + 1}. ${h.title}  —  ${h.relPath}`;
          container.addChild(new Text(theme.fg("accent", raw.slice(0, MAX_LINE)), 0, 0));
        }
        container.addChild(new Spacer(1));
        const more = d.results.length > TUI_LIMIT ? ` (当前页 ${d.results.length} 条，Ctrl+O 展开)` : "";
        container.addChild(new Text(theme.fg("dim", `💡 Ctrl+O 展开详情 (共 ${d.total} 条)${more}`), 0, 0));
      }

      return container;
    },
  });
}
