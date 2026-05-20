/**
 * management.ts — Wiki AI 管理工具 (v4.0)
 *
 * 面向 AI 的全套 wiki 生命周期管理工具。用户只管消费（/wiki-search），
 * AI 通过以下工具接管增删改查、索引同步、文件系统操作。
 *
 * 数据源:    wiki_load_source / wiki_unload_source / wiki_list_sources / wiki_refresh
 * 条目:      wiki_create_entry / wiki_get_entry
 * 文件系统:  wiki_rename / wiki_move
 */

import type { ExtensionAPI, ToolRenderResultOptions, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  renameSync, statSync, readdirSync,
} from "node:fs";
import { resolve, relative, dirname, basename, extname } from "node:path";
import { execSync } from "node:child_process";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import {
  getSources, addSource, removeSource, mergeIndex,
  getIndex, removeEntry, updateEntryPath, getEntry, stats,
  getSemanticEnabled, setSemanticEnabled, getEmbeddings,
} from "../lib/store.js";
import { scanDir, generateEmbeddings, embedSingleFile } from "../lib/indexer.js";
import { search } from "../lib/search.js";
import {
  initialize, isAvailable, getModelName, getInitError,
  getLocalModelInfo, getModelSource, isDependencyInstalled,
} from "../lib/embedder.js";
import type { FileEntry } from "../lib/types.js";

// ============================================================
// Helpers
// ============================================================

function resolvePath(raw: string): string {
  return resolve(process.cwd(), raw);
}

function frontmatterTemplate(title: string, tags: string[]): string {
  const tagList = tags.length ? `[${tags.join(", ")}]` : "[]";
  const now = new Date().toISOString();
  return [
    "---",
    `title: ${title}`,
    `tags: ${tagList}`,
    `created: ${now}`,
    "---",
    "",
  ].join("\n");
}

/** 解析 source 参数：支持绝对路径或已注册源的名称匹配 */
function resolveSource(raw: string): string | null {
  if (existsSync(raw) && getSources().includes(raw)) return raw;
  // 尝试按名称末尾匹配
  const srcs = getSources();
  const match = srcs.find(s => s === raw || s.endsWith(raw) || basename(s) === raw);
  return match || null;
}

/** 扫描单条文件并生成 FileEntry */
function extractSingle(root: string, filePath: string): FileEntry | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const relPath = relative(root, filePath).replace(/\\/g, "/");
    let title = basename(filePath, ".md");
    const tags: string[] = [];

    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const ci = line.indexOf(":");
        if (ci < 0) continue;
        const k = line.slice(0, ci).trim();
        const v = line.slice(ci + 1).trim().replace(/['"]/g, "");
        if (k === "title") title = v;
        if (k === "tags" && v.startsWith("[") && v.endsWith("]")) {
          tags.push(...v.slice(1, -1).split(",").map(s => s.trim().replace(/['"]/g, "")));
        }
      }
    }
    if (!fmMatch || !raw.match(/^---\n[\s\S]*?\n---\n*\n*# /)) {
      const h1 = raw.match(/^# (.+)$/m);
      if (h1) title = h1[1].trim();
    }

    return { title, tags, sourceDir: root, relPath, mtime: statSync(filePath).mtime.toISOString() };
  } catch {
    return null;
  }
}

function formatSourcesList(): string {
  const srcs = getSources();
  const st = stats();
  if (!srcs.length) return "📭 无已加载数据源。使用 wiki_load_source 加载。";
  const lines = [
    `📂 已加载 ${st.sources} 个数据源（共 ${st.files} 篇，最后扫描: ${st.lastScan || "无"}）`,
    "",
  ];
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i];
    const count = Object.values(getIndex()).filter(e => e.sourceDir === src).length;
    lines.push(`  ${i + 1}. ${basename(src)} — ${count} 篇`);
    lines.push(`     ${src}`);
  }
  return lines.join("\n");
}

// ============================================================
// Registration
// ============================================================

export function registerManagementTools(pi: ExtensionAPI): void {
  // ---- 数据源 ----

  pi.registerTool({
    name: "wiki_load_source",
    label: "Wiki Load Source",
    description:
      "加载一个目录作为 wiki 数据源。自动递归扫描该目录下所有 .md 文件并建立搜索索引。",
    promptSnippet: "Load a directory as wiki data source",
    promptGuidelines: [
      "Use to add new knowledge base directories to the wiki.",
      "The directory path can be absolute or relative to the project root.",
      "Returns the number of .md files indexed.",
      "Use wiki_list_sources to see what's already loaded.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "数据源目录路径（绝对路径或相对路径）" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const abs = resolvePath(params.path);
      if (!existsSync(abs)) return { content: [{ type: "text", text: `❌ 目录不存在: ${abs}` }] };
      if (!addSource(abs)) return { content: [{ type: "text", text: `⚠️ 已加载: ${abs}` }] };
      const entries = await scanDir(abs);
      mergeIndex(entries);
      // 语义搜索：生成向量
      const embCount = await generateEmbeddings(abs, entries);
      const semHint = embCount > 0
        ? `\n🧠 已生成 ${embCount} 条语义向量`
        : getSemanticEnabled() ? "" : "\n💡 语义搜索未启用。对我说「启用 wiki 语义搜索」即可自动配置。";
      return {
        content: [{ type: "text", text: `✅ 已加载并索引 ${entries.length} 篇${semHint}\n📂 ${abs}` }],
        details: { source: abs, indexed: entries.length, embeddings: embCount },
      };
    },
  });

  pi.registerTool({
    name: "wiki_unload_source",
    label: "Wiki Unload Source",
    description: "卸载一个 wiki 数据源。不传路径时列出所有已加载的数据源。",
    promptSnippet: "Unload a wiki data source or list all sources",
    promptGuidelines: [
      "Pass no argument to list all loaded sources.",
      "Pass the source path (or its basename) to unload.",
      "Unloading removes the source and its index entries.",
      "The original files on disk are NOT deleted.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "要卸载的数据源路径（留空列出所有）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.path) {
        return { content: [{ type: "text", text: formatSourcesList() }] };
      }
      const removed = removeSource(params.path);
      if (!removed) {
        // 尝试模糊匹配
        const src = resolveSource(params.path);
        if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.path}\n${formatSourcesList()}` }] };
        const r2 = removeSource(src);
        if (!r2) return { content: [{ type: "text", text: `❌ 卸载失败: ${src}` }] };
        return { content: [{ type: "text", text: `🗑️ 已卸载: ${basename(r2)}` }] };
      }
      return { content: [{ type: "text", text: `🗑️ 已卸载: ${basename(removed)}` }] };
    },
  });

  pi.registerTool({
    name: "wiki_list_sources",
    label: "Wiki List Sources",
    description: "列出所有已加载的 wiki 数据源及其状态（文件数、最后扫描时间）。",
    promptSnippet: "List all wiki data sources",
    promptGuidelines: [
      "Call before wiki_create_entry or wiki_get_entry to discover available sources.",
      "Returns source paths, file counts, and last scan time.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      return { content: [{ type: "text", text: formatSourcesList() }] };
    },
  });

  pi.registerTool({
    name: "wiki_refresh",
    label: "Wiki Refresh Index",
    description:
      "重新扫描数据源以更新索引。不传 source 时刷新所有数据源。用于源文件在外部变更后同步索引。",
    promptSnippet: "Refresh wiki index for one or all sources",
    promptGuidelines: [
      "Call after making file changes (rename, create, delete) outside wiki tools.",
      "Call when you suspect the index is stale.",
      "Pass the source path to refresh a single source, or omit to refresh all.",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "要刷新的数据源路径（留空刷新全部）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const sources = params.source
        ? [resolveSource(params.source)].filter(Boolean) as string[]
        : getSources();

      if (!sources.length) {
        return { content: [{ type: "text", text: "📭 无数据源可刷新。先用 wiki_load_source 加载。" }] };
      }

      let total = 0;
      let embTotal = 0;
      for (const src of sources) {
        const entries = await scanDir(src);
        mergeIndex(entries);
        total += entries.length;
        // 语义搜索：增量生成向量
        const embCount = await generateEmbeddings(src, entries);
        embTotal += embCount;
      }
      const embHint = embTotal > 0 ? `，${embTotal} 条向量更新` : "";
      return {
        content: [{ type: "text", text: `🔄 已刷新 ${sources.length} 个数据源，共索引 ${total} 篇${embHint}` }],
        details: { sources: sources.length, indexed: total, embeddings: embTotal },
      };
    },
  });

  // ---- 条目生命周期 ----

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
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}\n${formatSourcesList()}` }] };

      let p = params.path.replace(/\\/g, "/");
      if (!p.endsWith(".md")) p += ".md";
      const fullPath = resolve(src, p);

      // 安全检查：确保路径在数据源内部
      if (!fullPath.startsWith(src)) {
        return { content: [{ type: "text", text: `❌ 路径必须在数据源内: ${src}` }] };
      }

      if (existsSync(fullPath)) {
        return { content: [{ type: "text", text: `⚠️ 文件已存在: ${p}` }] };
      }

      // 创建父目录
      const parent = dirname(fullPath);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

      const title = params.title || basename(p, ".md");
      const tags = params.tags || [];
      const body = params.content || "";
      const fm = frontmatterTemplate(title, tags);
      writeFileSync(fullPath, fm + body + "\n", "utf-8");

      // 索引新条目
      const entry = extractSingle(src, fullPath);
      if (entry) mergeIndex([entry]);

      // 语义搜索：为新文件生成向量
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
      "Binary files will be read as text — use for small text-based resources only.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      path: Type.String({ description: "条目相对路径" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}\n${formatSourcesList()}` }] };

      const p = params.path.replace(/\\/g, "/");
      const fullPath = resolve(src, p);

      if (!fullPath.startsWith(src)) {
        return { content: [{ type: "text", text: `❌ 路径必须在数据源内: ${src}` }] };
      }

      if (!existsSync(fullPath)) {
        return { content: [{ type: "text", text: `❌ 文件不存在: ${p}` }] };
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        const entry = getEntry(p);
        const truncated = content.length > 8000
          ? content.slice(0, 8000) + `\n\n... (截断，全文 ${content.length} 字符。使用 offset 续读)`
          : content;

        // 提取预览摘要（前 300 字符或第一段）
        const preview = content.slice(0, 300).replace(/\n/g, " ").trim();

        return {
          content: [{
            type: "text",
            text: `📄 **${entry?.title || basename(p, extname(p))}** \`${p}\` (${content.length} 字符)\n\n${truncated}`,
          }],
          details: {
            source: src,
            path: p,
            size: content.length,
            title: entry?.title || basename(p, extname(p)),
            tags: entry?.tags || [],
            mtime: entry?.mtime || "",
            content,
            preview,
            truncated: content.length > 8000,
          },
        };
      } catch {
        return { content: [{ type: "text", text: `⚠️ 无法以 UTF-8 读取: ${p}（可能是二进制文件）` }] };
      }
    },

    renderResult(result, options, theme, context) {
      const container = (context.lastComponent as Container) ?? new Container();
      container.clear();
      const d = result.details as {
        source: string; path: string; size: number;
        title: string; tags: string[]; mtime: string;
        content: string; preview: string; truncated: boolean;
      };
      if (!d) {
        container.addChild(new Text(theme.fg("muted", "(无内容)"), 0, 0));
        return container;
      }

      // 标题行
      container.addChild(new Text(theme.bold(`📄 ${d.title}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", `   ${d.path}  (${d.size} 字符)`), 0, 0));

      // 元信息行
      const meta: string[] = [];
      if (d.tags.length) meta.push(`标签: [${d.tags.join(", ")}]`);
      if (d.mtime) meta.push(`修改: ${d.mtime.slice(0, 10)}`);
      if (d.truncated) meta.push("⚠ 内容已截断（8000 字符上限）");
      if (meta.length) {
        container.addChild(new Text(theme.fg("muted", `   ${meta.join("  ·  ")}`), 0, 0));
      }
      container.addChild(new Text(theme.fg("dim", "─".repeat(50)), 0, 0));
      container.addChild(new Spacer(1));

      // 摘要（始终显示）
      container.addChild(new Text(theme.fg("muted", d.preview + (d.content.length > 300 ? "…" : "")), 0, 0));
      container.addChild(new Spacer(1));

      // 折叠/展开全文
      if (options.expanded) {
        container.addChild(new Text(theme.fg("dim", `─── 全文 ───`), 0, 0));
        container.addChild(new Text(d.content, 0, 0));
        if (d.truncated) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "⚠ 内容已截断至 8000 字符。使用 wiki_get_entry 带 offset 可续读。"), 0, 0));
        }
      } else {
        const hint = `💡 Ctrl+O 展开查看完整内容（${d.size} 字符）`;
        container.addChild(new Text(theme.fg("dim", hint), 0, 0));
      }

      return container;
    },
  });

  // ---- 文件系统操作 ----

  pi.registerTool({
    name: "wiki_rename",
    label: "Wiki Rename",
    description:
      "重命名 wiki 中的文件或目录，自动同步索引。支持 .md 条目和资源文件。",
    promptSnippet: "Rename a file or directory in a wiki source, keeping index in sync",
    promptGuidelines: [
      "Use to rename .md entries or resource files within a wiki source.",
      "source: the data source path. oldPath / newPath: relative paths within the source.",
      "The index is automatically updated — no need to call wiki_refresh afterward.",
      "For directories, all contained entries are re-indexed after rename.",
      "If oldPath is a directory, newPath must also be a directory path.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      oldPath: Type.String({ description: "当前文件/目录的相对路径" }),
      newPath: Type.String({ description: "新的文件/目录的相对路径" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}\n${formatSourcesList()}` }] };

      const oldRel = params.oldPath.replace(/\\/g, "/");
      const newRel = params.newPath.replace(/\\/g, "/");
      const oldFull = resolve(src, oldRel);
      const newFull = resolve(src, newRel);

      if (!oldFull.startsWith(src) || !newFull.startsWith(src)) {
        return { content: [{ type: "text", text: `❌ 路径必须在数据源内: ${src}` }] };
      }
      if (!existsSync(oldFull)) {
        return { content: [{ type: "text", text: `❌ 源文件不存在: ${oldRel}` }] };
      }
      if (existsSync(newFull)) {
        return { content: [{ type: "text", text: `❌ 目标已存在: ${newRel}` }] };
      }

      // 创建目标父目录
      const newParent = dirname(newFull);
      if (!existsSync(newParent)) mkdirSync(newParent, { recursive: true });

      const isDir = statSync(oldFull).isDirectory();

      // 收集需要更新索引的条目
      const oldEntries: { oldKey: string; entry: FileEntry }[] = [];
      if (isDir) {
        const idx = getIndex();
        for (const [key, entry] of Object.entries(idx)) {
          if (entry.sourceDir === src && key.startsWith(oldRel + "/")) {
            oldEntries.push({ oldKey: key, entry });
          }
        }
      } else {
        const entry = getEntry(oldRel);
        if (entry) oldEntries.push({ oldKey: oldRel, entry });
      }

      // 执行重命名
      renameSync(oldFull, newFull);

      // 更新索引
      if (isDir) {
        // 目录重命名：更新所有子条目的路径
        for (const { oldKey, entry } of oldEntries) {
          const newKey = newRel + oldKey.slice(oldRel.length);
          const newEntry = extractSingle(src, resolve(src, newKey));
          if (newEntry) {
            updateEntryPath(oldKey, newKey, newEntry);
          } else {
            removeEntry(oldKey);
          }
        }
      } else if (oldEntries.length > 0) {
        // 单文件重命名
        const newEntry = extractSingle(src, newFull);
        if (newEntry) {
          updateEntryPath(oldRel, newRel, newEntry);
        } else {
          removeEntry(oldRel);
          // 即使 extractSingle 失败（非 .md），也保持索引追踪
          if (oldEntries[0].entry) {
            const updatedEntry = { ...oldEntries[0].entry, relPath: newRel };
            updateEntryPath(oldRel, newRel, updatedEntry);
          }
        }
      }

      const type = isDir ? "📁 目录" : "📄 文件";
      return {
        content: [{ type: "text", text: `✅ ${type}已重命名: ${oldRel} → ${newRel}` }],
        details: { source: src, oldPath: oldRel, newPath: newRel, isDir },
      };
    },
  });

  pi.registerTool({
    name: "wiki_move",
    label: "Wiki Move",
    description:
      "移动 wiki 中的文件或目录到其他位置，自动同步索引。支持 .md 条目和资源文件。",
    promptSnippet: "Move a file or directory within a wiki source, keeping index in sync",
    promptGuidelines: [
      "Use to reorganize files and directories within a wiki source.",
      "source: the data source path. from / to: relative paths within the source.",
      "The index is automatically updated.",
      "If 'to' is an existing directory, the file is moved inside it (keeping its name).",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      from: Type.String({ description: "当前文件/目录的相对路径" }),
      to: Type.String({ description: "目标路径（文件或目录）" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}\n${formatSourcesList()}` }] };

      const fromRel = params.from.replace(/\\/g, "/");
      const toRel = params.to.replace(/\\/g, "/");
      const fromFull = resolve(src, fromRel);
      const toFull = resolve(src, toRel);

      if (!fromFull.startsWith(src) || !toFull.startsWith(src)) {
        return { content: [{ type: "text", text: `❌ 路径必须在数据源内: ${src}` }] };
      }
      if (!existsSync(fromFull)) {
        return { content: [{ type: "text", text: `❌ 源文件不存在: ${fromRel}` }] };
      }

      // 如果 to 是已存在的目录，则移动进该目录
      let targetPath = toRel;
      let targetFull = toFull;
      if (existsSync(toFull) && statSync(toFull).isDirectory()) {
        const name = basename(fromRel);
        targetPath = toRel.replace(/\/$/, "") + "/" + name;
        targetFull = resolve(src, targetPath);
      }

      if (existsSync(targetFull)) {
        return { content: [{ type: "text", text: `❌ 目标已存在: ${targetPath}` }] };
      }

      // 创建目标父目录
      const targetParent = dirname(targetFull);
      if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });

      const isDir = statSync(fromFull).isDirectory();

      // 收集索引条目
      const oldEntries: { oldKey: string; entry: FileEntry }[] = [];
      if (isDir) {
        const idx = getIndex();
        for (const [key, entry] of Object.entries(idx)) {
          if (entry.sourceDir === src && key.startsWith(fromRel + "/")) {
            oldEntries.push({ oldKey: key, entry });
          }
        }
      } else {
        const entry = getEntry(fromRel);
        if (entry) oldEntries.push({ oldKey: fromRel, entry });
      }

      // 执行移动
      renameSync(fromFull, targetFull);

      // 更新索引
      if (isDir) {
        for (const { oldKey, entry } of oldEntries) {
          const newKey = targetPath + oldKey.slice(fromRel.length);
          const newEntry = extractSingle(src, resolve(src, newKey));
          if (newEntry) {
            updateEntryPath(oldKey, newKey, newEntry);
          } else {
            removeEntry(oldKey);
          }
        }
      } else if (oldEntries.length > 0) {
        const newEntry = extractSingle(src, targetFull);
        if (newEntry) {
          updateEntryPath(fromRel, targetPath, newEntry);
        } else {
          removeEntry(fromRel);
          if (oldEntries[0].entry) {
            const updatedEntry = { ...oldEntries[0].entry, relPath: targetPath };
            updateEntryPath(fromRel, targetPath, updatedEntry);
          }
        }
      }

      const type = isDir ? "📁 目录" : "📄 文件";
      return {
        content: [{ type: "text", text: `✅ ${type}已移动: ${fromRel} → ${targetPath}` }],
        details: { source: src, from: fromRel, to: targetPath, isDir },
      };
    },
  });

  // ---- 语义搜索管理 ----

  pi.registerTool({
    name: "wiki_enable_semantic",
    label: "Wiki Enable Semantic",
    description:
      "启用语义搜索。可选自动安装 @huggingface/transformers 依赖。启用后自动为所有已索引文件生成语义向量。",
    promptSnippet: "Enable semantic search for wiki",
    promptGuidelines: [
      "Call this when the user wants to enable semantic search.",
      "Set autoInstall: true to auto-trigger npm install to wiki/node_modules/",
      "",
      "📦 依赖: @huggingface/transformers（transformers.js）",
      "   安装: npm install @huggingface/transformers（安装至 extensions/wiki/node_modules/）",
      "   体积: ~500MB（含 ONNX runtime 原生二进制）",
      "",
      "🧠 模型: Xenova/paraphrase-multilingual-MiniLM-L12-v2（多语言 384 维）",
      "   来源: HuggingFace Hub → https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      "   镜像: https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/",
      "   精度: INT8 量化 ~118MB（推荐） ｜ FP32 全精度 ~470MB",
      "   文件: config.json · tokenizer.json · tokenizer_config.json · onnx/model_quantized.onnx",
      "   本地: wiki/models/paraphrase-multilingual-MiniLM-L12-v2/（存在即优先离线加载）",
      "",
      "🔧 一键初始化（网络受限时）:",
      "   分两步初始化（三平台通用）:",
      "     ① npm 依赖: init-wiki-deps.bat / .ps1 / .sh",
      "     ② 模型下载: init-wiki-model.bat / .ps1 / .sh",
      "",
      "⚠️ 常见坑:",
      "   ① embedder.ts 的 model_file_name 只需主干名 \"model_quantized\"，",
      "      transformers.js 自动补 onnx/ + .onnx，勿写完整路径",
      "   ② 部署 robocopy 加 /XD wiki\\models 避免覆盖已下载的模型",
      "   ③ 启用前确保 wiki_load_source 已加载数据源",
      "",
      "This will re-index all sources to generate embeddings.",
      "Use wiki_semantic_status to check progress/results.",
    ],
    parameters: Type.Object({
      autoInstall: Type.Optional(Type.Boolean({ description: "是否自动安装 @huggingface/transformers（默认 true）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const doInstall = params.autoInstall !== false;

      // 先尝试初始化，如果依赖未安装则自动处理
      let ok = await initialize();
      if (!ok) {
        const err = getInitError() || "";
        const isMissingDep = err.includes("Cannot find module")
          || err.includes("Failed to resolve")
          || err.includes("Module not found");

        if (!isMissingDep) {
          // 非依赖缺失错误（如网络问题），直接报告
          return { content: [{ type: "text", text: `❌ 初始化失败: ${err}` }] };
        }

        if (!doInstall) {
          return { content: [{ type: "text", text: `❌ 语义搜索依赖 @huggingface/transformers 未安装。\n设置 autoInstall: true 自动安装，或手动运行:\n  npm install @huggingface/transformers` }] };
        }

        // 自动安装依赖到 wiki 本地 node_modules/，Node.js 原生 import 即可找到
        const wikiDir = resolve(__dirname, "..");
        try {
          execSync(
            `npm install @huggingface/transformers`,
            { encoding: "utf-8", timeout: 180_000, cwd: wikiDir },
          );
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `❌ 安装失败: ${e?.stderr || e?.message || String(e)}\n\n请手动运行:\n  cd extensions\\wiki && npm install @huggingface/transformers` }],
          };
        }

        // 安装后重试初始化
        ok = await initialize();
        if (!ok) {
          return { content: [{ type: "text", text: `❌ 初始化 embedder 失败: ${getInitError() || "未知错误"}` }] };
        }
      }

      // 启用
      setSemanticEnabled(true);

      // 为所有数据源生成 embedding
      const sources = getSources();
      let total = 0;
      for (const src of sources) {
        const entries = Object.values(getIndex()).filter(e => e.sourceDir === src);
        const count = await generateEmbeddings(src, entries);
        total += count;
      }

      return {
        content: [{ type: "text", text: `✅ 语义搜索已启用\n🧠 模型: ${getModelName()}\n📊 已为 ${total} 篇文档生成语义向量` }],
        details: { enabled: true, model: getModelName(), embeddings: total },
      };
    },
  });

  pi.registerTool({
    name: "wiki_disable_semantic",
    label: "Wiki Disable Semantic",
    description: "关闭语义搜索（保留已生成的向量数据，下次启用时无需重新生成）。",
    promptSnippet: "Disable semantic search for wiki",
    promptGuidelines: [
      "Call when user wants to disable semantic search.",
      "Embeddings are preserved — re-enabling won't require regeneration.",
      "Keyword search remains fully functional.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!getSemanticEnabled()) {
        return { content: [{ type: "text", text: "⚠️ 语义搜索未启用" }] };
      }
      setSemanticEnabled(false);
      const embCount = Object.keys(getEmbeddings()).length;
      return {
        content: [{ type: "text", text: `🔒 语义搜索已关闭（${embCount} 条向量保留，重新启用时无需重新生成）` }],
      };
    },
  });

  pi.registerTool({
    name: "wiki_semantic_status",
    label: "Wiki Semantic Status",
    description: "查看语义搜索状态：是否启用、依赖是否安装、向量数量、模型名。",
    promptSnippet: "Check semantic search status",
    promptGuidelines: [
      "Call to check if semantic search is set up correctly.",
      "Returns enabled state, dependency status, embedding count, model name.",
      "If not enabled, suggest wiki_enable_semantic to set up.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const enabled = getSemanticEnabled();
      const embCount = Object.keys(getEmbeddings()).length;
      const depReady = isAvailable();
      const depInstalled = await isDependencyInstalled();
      const model = getModelName();
      const modelSrc = isAvailable() ? getModelSource() : "未加载";
      const localInfo = getLocalModelInfo();

      const lines = [
        `🧠 语义搜索状态`,
        `   状态: ${enabled ? "✅ 已启用" : "⏸ 未启用"}`,
        `   依赖: ${depInstalled ? (depReady ? "✅ 已就绪" : "⏳ 已安装但未加载") : "❌ 未安装 @huggingface/transformers"}`,
        `   模型: ${model}`,
        `   来源: ${modelSrc}`,
      ];
      if (localInfo) {
        lines.push(`   精度: ${localInfo.variant.toUpperCase()} (${localInfo.onnxSize > 0 ? (localInfo.onnxSize / 1_000_000).toFixed(0) + " MB" : "未知"})`);
      }
      lines.push(`   向量: ${embCount} 条`);
      if (!enabled) {
        lines.push("", "💡 对我说『启用 wiki 语义搜索』即可自动配置。");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
