// management-entries.ts — 条目 CRUD 工具 (v5.4)
//
// wiki_create_entry / wiki_get_entry / wiki_rename / wiki_move

import type { ExtensionAPI, ToolRenderResultOptions, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  renameSync, statSync, readdirSync,
} from "node:fs";
import { resolve, relative, dirname, basename, extname } from "node:path";
import {
  getSources, mergeIndex, getIndex, removeEntry,
  updateEntryPath, getEntry,
} from "../lib/store.js";
import { embedSingleFile } from "../lib/indexer.js";
import { parseFileEntry } from "../lib/parser.js";
import { resolveSource, formatSourcesList, frontmatterTemplate } from "./_helpers.js";

export function registerEntryTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_create_entry",
    label: "Wiki Create Entry",
    description:
      "在指定数据源下创建新的 .md 条目（自动生成 frontmatter 模板）。如果路径不以 .md 结尾，自动追加。",
    promptSnippet: "Create a new .md entry in a wiki data source",
    promptGuidelines: [
      "Use to save new knowledge discovered during conversation.",
      "source: the data source path (use wiki_list_sources to discover).",
      "path: relative path within the source, e.g. 'notes/debug/cors-fix.md'.",
      "title: optional, defaults to filename. tags: optional array of strings.",
      "content: optional initial body content.",
      "Automatically creates parent directories if needed.",
      "The new entry is immediately indexed for search.",
      "FORBIDDEN: Do NOT create entries without user confirmation of the content.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "目标数据源路径" }),
      path: Type.String({ description: "条目相对路径（如 notes/debug/cors.md）" }),
      title: Type.Optional(Type.String({ description: "条目标题（默认取文件名）" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "标签列表" })),
      content: Type.Optional(Type.String({ description: "初始正文内容" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src)
        return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}\n${formatSourcesList()}` }] };

      let p = params.path.replace(/\\/g, "/");
      if (!p.endsWith(".md")) p += ".md";
      const fullPath = resolve(src, p);

      if (!fullPath.startsWith(src)) {
        return { content: [{ type: "text", text: `❌ 路径必须在数据源内: ${src}` }] };
      }

      if (existsSync(fullPath)) {
        return { content: [{ type: "text", text: `⚠️ 文件已存在: ${p}` }] };
      }

      const parent = dirname(fullPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

      const title = params.title || basename(p, ".md");
      const tags = params.tags || [];
      const body = params.content || "";
      const fm = frontmatterTemplate(title, tags);
      writeFileSync(fullPath, fm + body + "\n", "utf-8");

      const entry = parseFileEntry(src, fullPath);
      if (entry) mergeIndex([entry]);
      embedSingleFile(src, p, title).catch(() => { /* 非关键路径 */ });

      return {
        content: [{ type: "text", text: `✅ 已创建: ${p}\n📄 ${title}${tags.length ? ` 标签: [${tags.join(", ")}]` : ""}` }],
        details: { source: src, path: p, title, tags },
      };
    },
  });

  pi.registerTool({
    name: "wiki_get_entry",
    label: "Wiki Get Entry",
    description:
      "读取 wiki 中某一条目的完整内容。支持 .md 文件和其他资源文件。",
    promptSnippet: "Get full content of a wiki entry",
    promptGuidelines: [
      "Use to read the full content of a specific entry found via kb_search.",
      "source: the data source path. path: relative path within the source.",
      "Supports both .md and resource files (images, PDFs, etc.).",
      "FORBIDDEN: path MUST be a file, NOT a directory. Directories will fail.",
      "FORBIDDEN: Do NOT call this without user picking a specific entry first. Never auto-read after kb_search.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      path: Type.String({ description: "条目相对路径" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src)
        return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}` }] };

      const p = params.path.replace(/\\/g, "/");
      const fullPath = resolve(src, p);

      if (!existsSync(fullPath)) {
        return { content: [{ type: "text", text: `❌ 条目不存在: ${p}` }] };
      }

      const st = statSync(fullPath);
      if (st.isDirectory()) {
        return { content: [{ type: "text", text: `❌ ${p} 是目录，不是文件。使用 wiki_list_sources 查看。` }] };
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        // 提取 frontmatter
        let fm: Record<string, string> | undefined;
        if (lines[0]?.trim() === "---") {
          const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
          if (fmEnd > 0) {
            fm = {};
            for (let i = 1; i < fmEnd; i++) {
              const ci = lines[i].indexOf(":");
              if (ci > 0) {
                const k = lines[i].slice(0, ci).trim();
                const v = lines[i].slice(ci + 1).trim().replace(/['\"]/g, "");
                fm[k] = v;
              }
            }
          }
        }

        // 统计标题
        const headingCount = lines.filter((l) => /^#{1,4}\s/.test(l)).length;

        const truncated =
          content.length > 10000
            ? content.slice(0, 10000) + "\n\n... (内容已截断，完整文件共 " + content.length + " 字符)"
            : content;
        return {
          content: [{ type: "text", text: truncated }],
          details: {
            source: src, path: p, size: content.length, lineCount: lines.length,
            title: fm?.title || basename(p, ".md"),
            frontmatter: fm, headingCount,
          },
        };
      } catch {
        return { content: [{ type: "text", text: `❌ 无法读取文件: ${p}（可能是二进制文件）` }] };
      }
    },

    renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: ToolRenderContext) {
      const container = (context.lastComponent as InstanceType<typeof Container>) ?? new Container();
      container.clear();
      const d = result.details as { source: string; path: string; size: number; lineCount: number; title?: string; frontmatter?: Record<string, string>; headingCount?: number };
      if (!d) return container;

      const MAX = 120;
      const sizeKB = d.size >= 1024 ? `${(d.size / 1024).toFixed(1)} KB` : `${d.size} B`;

      if (options.expanded) {
        container.addChild(new Text(theme.bold(`📄 ${d.title || d.path}`), 0, 0));
        container.addChild(new Text(theme.fg("dim", `   ${d.path}`.slice(0, MAX)), 0, 0));
        container.addChild(new Text(theme.fg("muted", `   ${sizeKB} · ${d.lineCount} 行 · ${d.headingCount ?? "?"} 标题`), 0, 0));
        if (d.frontmatter) {
          const fmLines = Object.entries(d.frontmatter)
            .filter(([k]) => k !== "title")
            .slice(0, 4)
            .map(([k, v]) => `${k}: ${v}`);
          if (fmLines.length) {
            container.addChild(new Text(theme.fg("muted", `   ${fmLines.join(" · ")}`.slice(0, MAX)), 0, 0));
          }
        }
        container.addChild(new Text(theme.fg("dim", "─".repeat(50)), 0, 0));
        container.addChild(new Text(theme.fg("muted", "📖 内容见下方输出"), 0, 0));
      } else {
        container.addChild(new Text(theme.bold(`📄 ${d.title || d.path}`), 0, 0));
        container.addChild(new Text(theme.fg("dim", `   ${d.path}`.slice(0, MAX)), 0, 0));
        container.addChild(new Text(theme.fg("muted", `   ${sizeKB} · ${d.lineCount} 行 · ${d.headingCount ?? "?"} 标题`), 0, 0));
        if (d.frontmatter) {
          const fmKeys = Object.keys(d.frontmatter).filter((k) => k !== "title");
          if (fmKeys.length) {
            const fmStr = fmKeys.slice(0, 4).map((k) => `${k}: ${d.frontmatter![k]}`).join(" · ");
            container.addChild(new Text(theme.fg("muted", `   ${fmStr}`.slice(0, MAX)), 0, 0));
          }
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "💡 Ctrl+O 展开全文"), 0, 0));
      }

      return container;
    },
  });

  pi.registerTool({
    name: "wiki_rename",
    label: "Wiki Rename",
    description:
      "重命名 wiki 中的文件或目录，自动同步索引。支持 .md 条目和资源文件。",
    promptSnippet: "Rename a wiki file or directory",
    promptGuidelines: [
      "Renames a file or directory within a wiki source.",
      "Automatically updates all index entries for affected files.",
      "Use this for ALL renames — never rename files outside wiki tools.",
      "FORBIDDEN: Do NOT rename wiki files without user confirmation.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      oldPath: Type.String({ description: "当前文件/目录的相对路径" }),
      newPath: Type.String({ description: "新的文件/目录的相对路径" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src)
        return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}` }] };

      const oldP = params.oldPath.replace(/\\/g, "/");
      const newP = params.newPath.replace(/\\/g, "/");
      const oldFull = resolve(src, oldP);
      const newFull = resolve(src, newP);

      if (!existsSync(oldFull))
        return { content: [{ type: "text", text: `❌ 不存在: ${oldP}` }] };
      if (existsSync(newFull))
        return { content: [{ type: "text", text: `❌ 目标已存在: ${newP}` }] };

      const oldIsDir = statSync(oldFull).isDirectory();
      const newParent = dirname(newFull);
      if (!existsSync(newParent)) mkdirSync(newParent, { recursive: true });

      renameSync(oldFull, newFull);

      // 更新索引
      if (oldIsDir) {
        const idx = getIndex();
        const affected = Object.entries(idx).filter(([, e]) =>
          e.relPath.startsWith(oldP + "/"),
        );
        for (const [, entry] of affected) {
          const updatedPath = newP + entry.relPath.slice(oldP.length);
          updateEntryPath(entry.relPath, updatedPath);
        }
      } else {
        updateEntryPath(oldP, newP);
      }

      return {
        content: [{ type: "text", text: `✅ 已重命名: ${oldP} → ${newP}` }],
        details: { source: src, oldPath: oldP, newPath: newP },
      };
    },
  });

  pi.registerTool({
    name: "wiki_move",
    label: "Wiki Move",
    description:
      "移动 wiki 中的文件或目录到其他位置，自动同步索引。支持 .md 条目和资源文件。",
    promptSnippet: "Move a wiki file or directory",
    promptGuidelines: [
      "Moves a file or directory within or between wiki sources.",
      "Automatically updates all index entries for affected files.",
      "Use this for ALL moves — never move files outside wiki tools.",
      "FORBIDDEN: Do NOT move wiki files without user confirmation.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      from: Type.String({ description: "当前文件/目录的相对路径" }),
      to: Type.String({ description: "目标路径（文件或目录）" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src)
        return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}` }] };

      const fromP = params.from.replace(/\\/g, "/");
      const toP = params.to.replace(/\\/g, "/");
      const fromFull = resolve(src, fromP);

      if (!existsSync(fromFull))
        return { content: [{ type: "text", text: `❌ 不存在: ${fromP}` }] };

      // 如果 to 是已存在的目录，文件进入其中
      let toFull = resolve(src, toP);
      const toIsDir = existsSync(toFull) && statSync(toFull).isDirectory();
      if (toIsDir) {
        toFull = resolve(toFull, basename(fromP));
      }

      const toParent = dirname(toFull);
      if (!existsSync(toParent)) mkdirSync(toParent, { recursive: true });

      renameSync(fromFull, toFull);

      // 更新索引
      const finalRelPath = relative(src, toFull).replace(/\\/g, "/");
      const fromIsDir = statSync(toFull).isDirectory();
      if (fromIsDir) {
        const idx = getIndex();
        const affected = Object.entries(idx).filter(([, e]) =>
          e.relPath.startsWith(fromP + "/"),
        );
        for (const [, entry] of affected) {
          const updatedPath = finalRelPath + entry.relPath.slice(fromP.length);
          updateEntryPath(entry.relPath, updatedPath);
        }
      } else {
        updateEntryPath(fromP, finalRelPath);
      }

      return {
        content: [{ type: "text", text: `✅ 已移动: ${fromP} → ${finalRelPath}` }],
        details: { source: src, from: fromP, to: finalRelPath },
      };
    },
  });
}
