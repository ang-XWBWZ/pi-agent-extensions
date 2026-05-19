// kb-search.ts — kb_search 工具 (v3.0)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { search } from "../lib/search.js";

export function registerKbSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kb_search",
    label: "Wiki Search",
    description: "搜索 wiki 知识库。对已加载数据源中的 .md 文件进行标题和全文搜索。",
    promptSnippet: "Search the wiki for relevant notes",
    promptGuidelines: [
      "Use kb_search to find relevant notes before answering questions.",
      "Returns matching files with titles, paths, and content snippets.",
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
      const top = hits.slice(0, 10);
      const lines = top.map(h =>
        `📄 **${h.title}** \`${h.relPath}\` (${h.score})\n   ${h.snippet}\n`
      );
      return {
        content: [{ type: "text", text: `🔍 "${params.query}" — ${hits.length} 结果:\n\n${lines.join("\n")}` }],
        details: { query: params.query, hits: hits.length, results: top },
      };
    },
  });
}
