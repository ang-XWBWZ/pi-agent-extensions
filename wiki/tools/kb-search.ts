// kb-search.ts — kb_search 工具 (Agent 可调用) (v2.3)
//
// v2.3: 截断保护 (2000行/50KB) + AbortSignal 三段检查 + fullContent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../lib/store.js";
import { searchEntries } from "../lib/search.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export function registerKbSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "kb_search",
    label: "Wiki Search",
    description:
      "搜索 wiki 知识库。支持内容匹配和标题匹配。" +
      "返回匹配的 wiki 条目、关联的原始文件、以及匹配片段。" +
      "设置 fullContent=true 可获取匹配条目的完整内容。",
    promptSnippet: "Search the wiki knowledge base for relevant entries",
    promptGuidelines: [
      "Use kb_search to look up documented knowledge before answering project-related questions.",
      "Returns matching wiki entries with snippets and source file references.",
      "Set fullContent=true to retrieve complete entry contents when snippets are insufficient.",
      "Prefer this over reading raw files when wiki entries exist for the topic.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      mode: Type.Optional(Type.String({ description: "搜索模式: content | title | both（默认 both）" })),
      fullContent: Type.Optional(Type.Boolean({ description: "是否返回条目完整内容（默认 false）" })),
    }),
    async execute(_toolCallId, params, signal) {
      // === AbortSignal 阶段 1: 操作前 ===
      if (signal?.aborted) throw new Error("操作已取消");

      const mode = (params.mode as "content" | "title" | "both") || "both";
      const hits = await searchEntries(params.query, mode);

      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `🔍 未找到匹配 "${params.query}" 的 wiki 条目。\n\n💡 使用 /wiki add 创建新条目。` }],
          details: { query: params.query, hits: 0 },
        };
      }

      if (params.fullContent) {
        const top = hits.slice(0, 3);
        const parts: string[] = [];
        let totalLines = 0, totalBytes = 0, truncated = false;

        for (const h of top) {
          // === AbortSignal 阶段 2: 操作中（每次迭代前） ===
          if (signal?.aborted) throw new Error("操作已取消");

          let content: string;
          try {
            content = await readFile(resolve(repoRoot(), "entries", `${h.entryId}.md`), "utf-8");
          } catch {
            parts.push(`---\n## ${h.title}\n⚠️ 无法读取条目文件\n`);
            continue;
          }

          const header = `---\n## ${h.title} [${h.status}]\n源: ${h.source}\n\n`;
          const headerBytes = Buffer.byteLength(header, "utf-8");
          const bodyBytes = Buffer.byteLength(content, "utf-8");
          const bodyLines = content.split("\n").length;

          if (totalLines + bodyLines > MAX_LINES || totalBytes + headerBytes + bodyBytes > MAX_BYTES) {
            const remainingLines = Math.max(1, MAX_LINES - totalLines);
            const remainingBytes = MAX_BYTES - totalBytes - headerBytes;
            const lines = content.split("\n");
            let sliced = "", byteCount = 0, lineCount = 0;
            for (const l of lines) {
              const lb = Buffer.byteLength(l + "\n", "utf-8");
              if (lineCount >= remainingLines || byteCount + lb > remainingBytes) break;
              sliced += l + "\n";
              byteCount += lb;
              lineCount++;
            }
            parts.push(`${header}${sliced}`);
            parts.push(`... (truncated — ${MAX_LINES}行/${(MAX_BYTES/1024)|0}KB limit)  ` +
              `Use \`read entries/${h.entryId}.md\` to view full entry`);
            truncated = true;
            break;
          }

          parts.push(header + content);
          totalLines += bodyLines + 3;
          totalBytes += headerBytes + bodyBytes;
        }

        const header = `🔍 搜索 "${params.query}" — ${hits.length} 个结果，返回前 ${top.length} 条完整内容:\n`;
        const footer = truncated
          ? `\n⚠️ 输出被截断（${MAX_LINES}行 / ${(MAX_BYTES/1024)|0}KB 限制）。使用 read 工具查看完整条目。`
          : "";

        // === AbortSignal 阶段 3: 返回前 ===
        if (signal?.aborted) throw new Error("操作已取消");

        return {
          content: [{ type: "text", text: header + parts.join("\n\n") + footer }],
          details: { query: params.query, hits: hits.length, fullContent: true, truncated },
        };
      }

      // 默认片段模式（同样截断保护）
      const lines: string[] = [];
      let snippetBytes = 0;
      for (let i = 0; i < hits.length && i < 10; i++) {
        const h = hits[i];
        const line = `📄 **${h.title}** \`${h.entryId}\` [${h.status}] (${h.score})\n   原始文件: ${h.source || "(无)"}\n   匹配: ${h.snippet}\n`;
        const lb = Buffer.byteLength(line, "utf-8");
        if (snippetBytes + lb > MAX_BYTES) {
          lines.push(`... (truncated, ${i} of ${hits.length} shown)`);
          break;
        }
        lines.push(line);
        snippetBytes += lb;
      }

      // === AbortSignal 阶段 3 ===
      if (signal?.aborted) throw new Error("操作已取消");

      return {
        content: [{ type: "text", text: `🔍 搜索 "${params.query}" — ${hits.length} 个结果:\n\n${lines.join("\n")}` }],
        details: { query: params.query, hits: hits.length, results: hits.slice(0, 10) },
      };
    },
  });
}
