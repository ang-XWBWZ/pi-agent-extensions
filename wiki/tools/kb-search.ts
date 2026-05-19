// kb-search.ts — kb_search 工具 (v3.0)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolRenderResultOptions, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { search } from "../lib/search.js";
import type { SearchHit } from "../lib/types.js";

export function registerKbSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kb_search",
    label: "Wiki Search",
    description: "搜索 wiki 知识库。对已加载数据源中的 .md 文件进行标题和全文搜索。",
    promptSnippet: "Search the wiki for relevant notes",
    promptGuidelines: [
      "Use kb_search to find relevant notes before answering questions.",
      "Returns matching files with titles, paths, and content snippets.",
      "Set fullContent: true to get complete file contents (up to 3 files, ~3KB each).",
      "Full content is collapsed by default — expand in TUI to view.",
      "If no results, suggest /wiki load to add a data source.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      fullContent: Type.Optional(Type.Boolean({ description: "是否返回完整内容（默认 false）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const hits = search(params.query);
      if (!hits.length) {
        return {
          content: [{ type: "text", text: `🔍 未匹配 "${params.query}"` }],
          details: { hits: 0 },
        };
      }
      const fullMode = params.fullContent === true;
      const limit = fullMode ? 3 : 10;
      const top = hits.slice(0, limit);

      if (fullMode) {
        const lines: string[] = [];
        for (const h of top) {
          lines.push(`📄 **${h.title}** \`${h.relPath}\` (${h.score})`);
          lines.push(`   ${h.snippet}`);
          const fullPath = resolve(h.sourceDir, h.relPath);
          if (existsSync(fullPath)) {
            try {
              const content = readFileSync(fullPath, "utf-8").slice(0, 3000);
              lines.push(`\n---\n${content}\n---\n`);
            } catch { lines.push("   ⚠️ 读取文件失败"); }
          }
        }
        return {
          content: [{ type: "text", text: `🔍 "${params.query}" — ${hits.length} 结果（全文模式，前 ${top.length} 篇）:\n\n${lines.join("\n")}` }],
          details: { query: params.query, hits: hits.length, results: top, fullContent: true },
        };
      }

      const lines = top.map(h =>
        `📄 **${h.title}** \`${h.relPath}\` (${h.score})\n   ${h.snippet}\n`
      );
      return {
        content: [{ type: "text", text: `🔍 "${params.query}" — ${hits.length} 结果:\n\n${lines.join("\n")}` }],
        details: { query: params.query, hits: hits.length, results: top },
      };
    },

    renderResult(result, options, theme, context) {
      const container = (context.lastComponent as Container) ?? new Container();
      container.clear();
      const d = result.details as { query: string; hits: number; results: SearchHit[]; fullContent?: boolean };
      if (!d || !d.results?.length) {
        container.addChild(new Text(theme.fg("muted", "(无结果)"), 0, 0));
        return container;
      }

      // 标题行
      const modeLabel = d.fullContent ? " 全文模式" : "";
      container.addChild(new Text(theme.bold(`🔍 "${d.query}" — ${d.hits} 结果${modeLabel}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", "─".repeat(50)), 0, 0));

      // 摘要列表（始终显示）
      for (let i = 0; i < d.results.length; i++) {
        const h = d.results[i];
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", `${i + 1}. ${h.title}`), 0, 0));
        container.addChild(new Text(theme.fg("dim", `   ${h.relPath}  (匹配度: ${h.score})`), 0, 0));
        if (h.snippet) {
          container.addChild(new Text(theme.fg("muted", `   ${h.snippet.slice(0, 120)}`), 0, 0));
        }
      }

      // 全文模式：折叠/展开
      if (d.fullContent) {
        container.addChild(new Spacer(1));
        if (options.expanded) {
          for (const h of d.results) {
            const fullPath = resolve(h.sourceDir, h.relPath);
            if (existsSync(fullPath)) {
              try {
                const content = readFileSync(fullPath, "utf-8").slice(0, 3000);
                container.addChild(new Text(theme.fg("dim", `─── ${h.relPath} ───`), 0, 0));
                container.addChild(new Text(content, 0, 0));
                container.addChild(new Spacer(1));
              } catch { /* skip */ }
            }
          }
        } else {
          const hint = `💡 展开以查看 ${d.results.length} 篇完整内容（共 ${d.hits} 条匹配）`;
          container.addChild(new Text(theme.fg("dim", hint), 0, 0));
        }
      }

      return container;
    },
  });
}
