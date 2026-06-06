// management-sources.ts — 数据源管理工具 (v5.5)
//
// wiki_DANGER_load / wiki_DANGER_unload / wiki_read_sources / wiki_DANGER_refresh

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  getSources, addSource, removeSource, mergeIndex,
  getSemanticEnabled, getIndex, removeEntry,
  getEmbeddings, setEmbeddings, getChunkInfo, setChunkInfo,
} from "../lib/store.js";
import { scanDir, generateEmbeddings } from "../lib/indexer.js";
import { resolvePath, resolveSource, formatSourcesList } from "./_helpers.js";
import { getManifest, updateFileState, getManifestStats, computeMD5, getFileState } from "../lib/file-manifest.js";
import { getCurrentModel } from "../lib/model-registry.js";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

export function registerSourceTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_DANGER_load",
    label: "Wiki Load Source",
    description:
      "加载一个目录作为 wiki 数据源。自动递归扫描该目录下所有 .md 文件并建立搜索索引。",
    promptSnippet: "Load wiki source (path)",
    promptGuidelines: [
      "## Quick Start (minimum viable)",
      "① wiki_DANGER_load(path) → ② wiki_read_search(query)  // keyword-only, substring match",
      "",
      "## Best Quality (recommended)",
      "① wiki_DANGER_load(path) → ② wiki_DANGER_semantic(action='on') → ③ wiki_read_search(query)  // hybrid RRF, bge embedding",
      "",
      "## Ultimate Quality (for fragmented/personal notes)",
      "① wiki_DANGER_load(path) → ② wiki_DANGER_semantic(action='on') → ③ wiki_DANGER_compile on key files",
      "→ ④ spawn sub-agent (Flash, work mode) to compile → ⑤ wiki_DANGER_store → ⑥ wiki_read_search(query)",
      "",
      "Use to add new knowledge base directories to the wiki.",
      "The directory path can be absolute or relative to the project root.",
      "FORBIDDEN: Do NOT auto-enable semantic search after loading. Ask the user first.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "数据源目录路径（绝对路径或相对路径）" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const abs = resolvePath(params.path);
      if (!existsSync(abs))
        return { content: [{ type: "text", text: `❌ 目录不存在: ${abs}` }] };
      if (!addSource(abs))
        return { content: [{ type: "text", text: `⚠️ 已加载: ${abs}` }] };
      const entries = await scanDir(abs);
      mergeIndex(entries);
      const embCount = await generateEmbeddings(abs, entries);
      const semHint =
        embCount > 0
          ? `\n🧠 已生成 ${embCount} 条语义向量`
          : getSemanticEnabled()
            ? ""
            : "\n💡 语义搜索未启用。对我说「启用 wiki 语义搜索」即可自动配置。";
      return {
        content: [{ type: "text", text: `✅ 已加载并索引 ${entries.length} 篇${semHint}\n📂 ${abs}` }],
        details: { source: abs, indexed: entries.length, embeddings: embCount },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const p = args.path ?? "";
      text.setText(theme.fg("toolTitle", theme.bold(`wiki_load(${p ? `“${p.slice(0, 50)}”` : ""})`)));
      return text;
    },
  });

  pi.registerTool({
    name: "wiki_DANGER_unload",
    label: "Wiki Unload Source",
    description: "卸载一个 wiki 数据源。不传路径时列出所有已加载的数据源。",
    promptSnippet: "Unload wiki source (path?) — omit to list all",
    promptGuidelines: [
      "Pass no argument to list all loaded sources.",
      "Pass the source path (or its basename) to unload.",
      "Unloading removes the source and its index entries.",
      "The original files on disk are NOT deleted.",
      "FORBIDDEN: Do NOT unload a source without user confirmation.",
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
        const src = resolveSource(params.path);
        if (!src)
          return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.path}\n${formatSourcesList()}` }] };
        const r2 = removeSource(src);
        if (!r2) return { content: [{ type: "text", text: `❌ 卸载失败: ${src}` }] };
        return { content: [{ type: "text", text: `🗑️ 已卸载: ${basename(r2)}` }] };
      }
      return { content: [{ type: "text", text: `🗑️ 已卸载: ${basename(removed)}` }] };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const p = args.path ?? "";
      text.setText(theme.fg("toolTitle", theme.bold(`wiki_unload(${p ? `“${p.slice(0, 50)}”` : ""})`)));
      return text;
    },
  });

  pi.registerTool({
    name: "wiki_read_sources",
    label: "Wiki List Sources",
    description: "列出所有已加载的 wiki 数据源及其状态（文件数、最后扫描时间）。",
    promptSnippet: "List all wiki data sources",
    promptGuidelines: [
      "Call before wiki_edit_create or wiki_read_entry to discover available sources.",
      "Returns source paths, file counts, and last scan time.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      return { content: [{ type: "text", text: formatSourcesList() }] };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`wiki_sources()`)));
      return text;
    },
  });

  pi.registerTool({
    name: "wiki_DANGER_refresh",
    label: "Wiki Refresh Index",
    description:
      "重新扫描数据源以更新索引。不传 source 时刷新所有数据源。用于源文件在外部变更后同步索引。",
    promptSnippet: "Refresh wiki index (source?, rebuildVectors?, relPath?)",
    promptGuidelines: [
      "Call after making file changes (rename, create, delete) outside wiki tools.",
      "Call when you suspect the index is stale.",
      "Pass the source path to refresh a single source, or omit to refresh all.",
      "FORBIDDEN: Do NOT refresh without user request or explicit need (e.g. after wiki_edit_create, index is already auto-updated).",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "要刷新的数据源路径（留空刷新全部）" })),
      rebuildVectors: Type.Optional(Type.Boolean({ description: "重建 AST 语义向量（保留 LLM 编译向量，默认 false）" })),
      relPath: Type.Optional(Type.String({ description: "rebuildVectors 时指定单文件路径（不传=全部）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const sources = params.source
        ? ([resolveSource(params.source)].filter(Boolean) as string[])
        : getSources();

      if (!sources.length) {
        return { content: [{ type: "text", text: "📭 无数据源可刷新。先用 wiki_DANGER_load 加载。" }] };
      }

      let total = 0, embTotal = 0, newFiles = 0, changedFiles = 0, deletedFiles = 0, clearedVectors = 0;
      const prevManifest = getManifest();
      const prevKeys = new Set(Object.keys(prevManifest.files).filter(k => !prevManifest.files[k].deleted));
      const scannedKeys = new Set<string>();

      // rebuildVectors: 清 AST 向量（###数字），保留 LLM 向量（###llm）
      if (params.rebuildVectors === true) {
        const existingEmb = getEmbeddings();
        const existingCI = getChunkInfo();
        const model = getCurrentModel();
        for (const key of Object.keys(existingEmb)) {
          if (!/###\d+$/.test(key)) continue;
          if (params.relPath) {
            const filePath = key.replace(/###\d+$/, "");
            if (filePath !== params.relPath) continue;
          }
          delete existingEmb[key];
          delete existingCI[key];
          clearedVectors++;
        }
        setEmbeddings(existingEmb, model.hfRepo, model.dim);
        setChunkInfo(existingCI);
      }

      for (const src of sources) {
        const entries = await scanDir(src);
        mergeIndex(entries);
        total += entries.length;

        // v5.4: 检测文件变化
        for (const entry of entries) {
          scannedKeys.add(entry.relPath);
          const fullPath = pathResolve(src, entry.relPath);
          try {
            const raw = readFileSync(fullPath, "utf-8");
            const md5 = computeMD5(raw);
            const prev = getFileState(entry.relPath);
            if (!prev) {
              newFiles++;
            } else if (prev.md5 !== md5) {
              changedFiles++;
              // 文件内容变了 → 标记 LLM 过期
              updateFileState(entry.relPath, { md5, llmCompiled: false });
            }
          } catch { /* skip */ }
        }

        const embCount = await generateEmbeddings(src, entries);
        embTotal += embCount;
      }

      // 检测已删除的文件（在 manifest 中但不在磁盘上）
      for (const key of prevKeys) {
        if (!scannedKeys.has(key)) {
          deletedFiles++;
          updateFileState(key, { deleted: true });
          removeEntry(key);
        }
      }

      // 修复性清理：manifest 中标记 deleted 但 BM25 索引残留的
      const mfNow = getManifest();
      const idx = getIndex();
      for (const key of Object.keys(mfNow.files)) {
        if (mfNow.files[key].deleted && idx[key]) {
          removeEntry(key);
        }
      }

      const embHint = embTotal > 0 ? `，${embTotal} 条向量更新` : "";
      const rebuildHint = params.rebuildVectors
        ? (params.relPath
          ? `\n🔁 已清 ${clearedVectors} 条 AST 向量 (${params.relPath})`
          : clearedVectors > 0 ? `\n🔁 已清 ${clearedVectors} 条旧 AST 向量，重建中...` : "")
        : "";
      const mf = getManifestStats();
      const delta = [];
      if (newFiles > 0) delta.push(`+${newFiles} 新增`);
      if (changedFiles > 0) delta.push(`~${changedFiles} 变更`);
      if (deletedFiles > 0) delta.push(`-${deletedFiles} 删除`);
      const deltaStr = delta.length > 0 ? ` (${delta.join(", ")})` : "";

      return {
        content: [{ type: "text", text: `🔄 已刷新 ${sources.length} 个数据源，共 ${total} 篇${deltaStr}${embHint}${rebuildHint}
📝 LLM 已编译: ${mf.compiled}/${mf.total} 文件` }],
        details: { sources: sources.length, indexed: total, embeddings: embTotal, newFiles, changedFiles, deletedFiles, manifest: mf, clearedVectors },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const src = args.source ? `“${args.source.slice(0, 40)}”` : "";
      const rebuild = args.rebuildVectors ? " rebuild" : "";
      text.setText(theme.fg("toolTitle", theme.bold(`wiki_refresh(${src}${rebuild})`)));
      return text;
    },
  });
}
