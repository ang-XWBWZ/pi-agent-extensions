// management-compile.ts — 语义编译工具 (v5.5)
//
// wiki_get_chunks_raw / wiki_compile_file / wiki_store_file_compiled
// v5.1 块级工具（wiki_compile_batch / wiki_store_compiled）已移除

import type { ExtensionAPI, ToolRenderResultOptions, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getEntry, getIndex } from "../lib/store.js";
import { storeFileLLMVector } from "../lib/indexer.js";
import {
  FILE_COMPILE_SYSTEM_PROMPT, buildFileCompilePrompt, parseFileLLMResult,
} from "../lib/semantic-compiler.js";
import { preprocessFile } from "../lib/preprocessor.js";
import { resolveSource } from "./_helpers.js";
import { updateFileState, getFileState } from "../lib/file-manifest.js";

export function registerCompileTools(pi: ExtensionAPI): void {
  // ---- v5.4 文件级编译状态 ----

  pi.registerTool({
    name: "wiki_get_chunks_raw",
    label: "Wiki File Compile Status",
    description:
      "获取文件级编译状态列表。按文件展示编译/向量状态，支持分页。",
    promptSnippet: "Get file-level compilation status",
    promptGuidelines: [
      "Shows per-FILE compilation status (not per-chunk).",
      "Use to check which files still need LLM semantic compilation.",
      "Pass source to filter by data source, or omit to get all.",
      "Pass uncompiledOnly: false to also see already-compiled files.",
      "Use page/pageSize for pagination.",
      "Then use wiki_compile_file on a specific file to compile it.",
      "FORBIDDEN: Only call this when user explicitly checks compilation status.",
    ],
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "数据源路径（留空获取全部）" })),
      uncompiledOnly: Type.Optional(Type.Boolean({ description: "仅返回未编译的文件（默认 true）" })),
      page: Type.Optional(Type.Number({ description: "页码（1-based，默认 1）" })),
      pageSize: Type.Optional(Type.Number({ description: "每页文件数（默认 20，上限 100）" })),
      action: Type.Optional(Type.String({ description: "操作: reset（清除编译状态）| unlock（清除编译锁）。不传=查看" })),
      relPath: Type.Optional(Type.String({ description: "action 时指定单文件（不传=全部）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      // —— action: reset / unlock ——
      if (params.action === "reset" || params.action === "unlock") {
        const source = params.source ? (resolveSource(params.source) ?? undefined) : undefined;
        const idx = getIndex();
        const entries = Object.values(idx).filter(e => !source || e.sourceDir === source);
        let count = 0;
        for (const entry of entries) {
          if (params.relPath && entry.relPath !== params.relPath) continue;
          if (params.action === "reset") {
            updateFileState(entry.relPath, { llmCompiled: false, compilingSince: undefined });
          } else {
            updateFileState(entry.relPath, { compilingSince: undefined });
          }
          count++;
        }
        const label = params.action === "reset" ? "已重置编译状态" : "已清除编译锁";
        const scope = params.relPath || `${count} 个文件`;
        return { content: [{ type: "text", text: `✅ ${label}: ${scope}` }] };
      }

      const source = params.source ? (resolveSource(params.source) ?? undefined) : undefined;
      const uncompiledOnly = params.uncompiledOnly !== false;
      const page = Math.max(1, params.page ?? 1);
      const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 20));

      const idx = getIndex();
      const entries = Object.values(idx).filter(
        (e) => !source || e.sourceDir === source,
      );

      const files = entries.map((entry) => {
        const state = getFileState(entry.relPath);
        return {
          relPath: entry.relPath,
          title: entry.title,
          astChunkCount: state?.astChunkCount ?? 0,
          llmCompiled: state?.llmCompiled ?? false,
          hasSemanticVectors: state?.hasSemanticVectors ?? false,
          compilingSince: state?.compilingSince,
        };
      });

      const filtered = uncompiledOnly ? files.filter((f) => !f.llmCompiled) : files;
      const totalAll = files.length;
      const compiled = files.filter((f) => f.llmCompiled).length;
      const compiling = files.filter((f) => !!f.compilingSince).length;
      const total = filtered.length;
      const totalPages = Math.ceil(total / pageSize);
      const start = (page - 1) * pageSize;
      const pageItems = filtered.slice(start, start + pageSize);

      const compilingLabel = compiling > 0 ? ` | 🔄 编译中 ${compiling}` : "";
      const lines = [
        `📂 ${totalAll} 文件 | ✅ 已编译 ${compiled} | ⏳ 待编译 ${totalAll - compiled}${compilingLabel}`,
        uncompiledOnly
          ? `   仅显示待编译 · 第 ${page}/${totalPages || 1} 页 (${pageItems.length} 个)`
          : `   全部文件 · 第 ${page}/${totalPages || 1} 页 (${pageItems.length} 个)`,
        "",
      ];

      for (let i = 0; i < pageItems.length; i++) {
        const f = pageItems[i];
        const ci = f.compilingSince ? "🔄" : f.llmCompiled ? "✅" : "❌";
        const ciLabel = f.compilingSince ? "编译中" : f.llmCompiled ? "编译" : "编译";
        const vectorIcon = f.hasSemanticVectors ? "✅" : "❌";
        const num = (page - 1) * pageSize + i + 1;
        lines.push(`${num}. ${f.relPath}`);
        lines.push(`   ${f.astChunkCount} AST块 | ${ci}${ciLabel} | ${vectorIcon}向量${f.compilingSince ? ` (${Math.round((Date.now() - new Date(f.compilingSince).getTime()) / 1000)}s)` : ""}`);
      }

      if (pageItems.length === 0 && uncompiledOnly) {
        lines.push("🎉 所有文件已编译");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { total: totalAll, compiled, uncompiled: totalAll - compiled, compiling, page, pageSize, totalPages: totalPages || 1, items: pageItems },
      };
    },

    renderResult(result: any, options: ToolRenderResultOptions, theme: any, context: ToolRenderContext) {
      const container = (context.lastComponent as InstanceType<typeof Container>) ?? new Container();
      container.clear();
      const d = result.details as { total: number; compiled: number; uncompiled: number; compiling?: number; page: number; pageSize: number; totalPages: number; items: any[] };
      if (!d) return container;

      const MAX = 100;
      const TUI_LIMIT = 5;  // 收缩模式只渲染前 5 条，不影响 details 全量
      const compilingLabel = (d.compiling ?? 0) > 0 ? ` | 🔄 ${d.compiling}` : "";
      container.addChild(new Text(theme.bold(`📂 ${d.total} 文件 | ✅ ${d.compiled} | ⏳ ${d.uncompiled}${compilingLabel}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", `   第 ${d.page}/${d.totalPages} 页 · 每页 ${d.pageSize} 个`), 0, 0));
      container.addChild(new Text(theme.fg("dim", "─".repeat(50)), 0, 0));

      if (options.expanded) {
        for (let i = 0; i < d.items.length; i++) {
          const f = d.items[i];
          const ci = f.compilingSince ? "🔄" : f.llmCompiled ? "✅" : "❌";
          const ciLabel = f.compilingSince ? "编译中" : f.llmCompiled ? "编译" : "编译";
          const vectorIcon = f.hasSemanticVectors ? "✅" : "❌";
          const timeLabel = f.compilingSince ? ` (${Math.round((Date.now() - new Date(f.compilingSince).getTime()) / 1000)}s)` : "";
          container.addChild(new Text(theme.fg("accent", `${i + 1}. ${f.title}`.slice(0, MAX)), 0, 0));
          container.addChild(new Text(theme.fg("dim", `   ${f.relPath}`.slice(0, MAX)), 0, 0));
          container.addChild(new Text(theme.fg("muted", `   ${f.astChunkCount} AST块 | ${ci}${ciLabel} | ${vectorIcon}向量${timeLabel}`.slice(0, MAX)), 0, 0));
        }
      } else {
        const visible = d.items.slice(0, TUI_LIMIT);
        for (let i = 0; i < visible.length; i++) {
          const f = visible[i];
          const prefix = f.compilingSince ? "🔄" : f.llmCompiled ? "✅" : "❌";
          container.addChild(new Text(theme.fg("accent", `${prefix} ${i + 1}. ${f.title}  —  ${f.relPath}`.slice(0, MAX)), 0, 0));
        }
        container.addChild(new Spacer(1));
        const more = d.items.length > TUI_LIMIT ? ` (共 ${d.items.length} 条，Ctrl+O 展开)` : "";
        container.addChild(new Text(theme.fg("dim", `💡 Ctrl+O 展开详情${more}`), 0, 0));
      }

      return container;
    },
  });

  // ---- v5.4 文件级编译 (LLM 挂载单向量) ----

  pi.registerTool({
    name: "wiki_compile_file",
    label: "Wiki Compile File",
    description:
      "对整个文件进行语义编译。LLM 输出全文的 topic/normalizedText/concepts/aliases，挂载为文件级语义向量。",
    promptSnippet: "Compile a whole file into one LLM semantic vector",
    promptGuidelines: [
      "## v5.4 File-Level LLM Vector",
      "LLM reads the FULL file and outputs ONE semantic summary:",
      "  { topic, normalizedText, concepts, aliases }",
      "This vector is stored as `file###llm` alongside AST chunk vectors `file###0..N`.",
      "AST chunks are NEVER deleted — LLM augments, not replaces.",
      "",
      "## Lock & force",
      "Each compile_file locks the file (compilingSince) to prevent parallel conflicts.",
      "If a file shows 🔄编译中 but no agent is actually working on it (crash/timeout):",
      "  → use force=true to clear the stale lock and re-compile.",
      "Locks auto-expire after 10 minutes.",
      "",
      "## Workflow (3 steps)",
      "① wiki_compile_file(source, relPath) → returns system + user prompt",
      "② Send prompt to LLM (spawn sub-agent, Flash model, work mode, timeout 300s)",
      "   LLM outputs: { topic, normalizedText, concepts, aliases }",
      "③ wiki_store_file_compiled(source, relPath, llmResponse) → store + rebuild",
      "",
      "Prefer file-level compilation for full context.",
      "FORBIDDEN: Do NOT compile the same file with both chunk-level and file-level tools.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      relPath: Type.String({ description: "文件相对路径（如 工作/AMI/更新/10.18AMI更新.md）" }),
      force: Type.Optional(Type.Boolean({ description: "强制编译（清除残留的 compilingSince 锁，默认 false）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}` }] };

      const relPath = params.relPath.replace(/\\/g, "/");
      const fullPath = resolve(src, relPath);

      if (!existsSync(fullPath)) {
        return { content: [{ type: "text", text: `❌ 文件不存在: ${relPath}` }] };
      }

      // 防并发冲突：检查是否正在编译中（force 跳过）
      const fileState = getFileState(relPath);
      if (!params.force && fileState?.compilingSince) {
        const elapsed = Date.now() - new Date(fileState.compilingSince).getTime();
        if (elapsed < 10 * 60 * 1000) { // 10 分钟内视为活跃
          return { content: [{ type: "text", text: `⏳ 文件正在编译中 (${Math.round(elapsed / 1000)}s 前开始): ${relPath}\n   请等待编译完成，或使用 force=true 强制重新编译。` }] };
        }
        // 超时自动解除（force 也走这里）
      }

      let raw: string;
      try { raw = readFileSync(fullPath, "utf-8"); } catch {
        return { content: [{ type: "text", text: `❌ 无法读取: ${relPath}` }] };
      }

      // 标记编译中
      updateFileState(relPath, { compilingSince: new Date().toISOString() });

      const entry = getEntry(relPath);
      const defaultTitle = entry?.title || basename(relPath, ".md");
      const preprocessed = await preprocessFile(relPath, raw, defaultTitle);

      // v5.4: 简化 prompt — 不要求 segments
      const userPrompt = buildFileCompilePrompt(relPath, raw, preprocessed);

      const lines = [
        `📄 文件级编译: ${relPath}`,
        `   ${preprocessed.length} 个程序段作为参考`,
        "",
        "=== SYSTEM PROMPT (已生成，见 details.systemPrompt) ===",
        "=== USER PROMPT (已生成，见 details.userPrompt) ===",
        "",
        "=== 使用说明 ===",
        "1. spawn 子 Agent (Flash, work mode) 发送 prompt",
        "2. LLM 返回 JSON 后，调用 wiki_store_file_compiled 存储",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { relPath, preprocessedCount: preprocessed.length, systemPrompt: FILE_COMPILE_SYSTEM_PROMPT, userPrompt, preprocessed },
      };
    },

    renderResult(result: any, _options: ToolRenderResultOptions, theme: any, context: ToolRenderContext) {
      const container = (context.lastComponent as InstanceType<typeof Container>) ?? new Container();
      container.clear();
      const d = result.details as { relPath?: string; preprocessedCount?: number };
      const MAX = 100;
      container.addChild(new Text(theme.bold(`📄 编译: ${d?.relPath || "?"}`), 0, 0));
      container.addChild(new Text(theme.fg("muted", `   ${d?.preprocessedCount || 0} 程序段 → LLM 自判语义边界`), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "💡 prompt 已生成 (details.systemPrompt / details.userPrompt)".slice(0, MAX)), 0, 0));
      container.addChild(new Text(theme.fg("dim", "   子 Agent 编译后调用 wiki_store_file_compiled 存储".slice(0, MAX)), 0, 0));
      return container;
    },
  });

  pi.registerTool({
    name: "wiki_store_file_compiled",
    label: "Wiki Store File Compiled",
    description:
      "存储文件级编译结果（LLM 输出的 segments）并重建语义向量。自动合并预处理器字段。",
    promptSnippet: "Store file-level compiled result and rebuild embedding",
    promptGuidelines: [
      "Call after wiki_compile_file + LLM returns compilation result.",
      "Pass the relPath (same as wiki_compile_file) and the LLM's raw JSON response.",
      "v5.4: stores as single LLM vector (file###llm), does NOT delete AST chunks.",
      "FORBIDDEN: Do NOT fabricate compilation data.",
    ],
    parameters: Type.Object({
      source: Type.String({ description: "数据源路径" }),
      relPath: Type.String({ description: "文件相对路径" }),
      data: Type.String({ description: "LLM 返回的 JSON（含 segments 数组，v5.2 compat; 或直接 topic/normalizedText/concepts/aliases）" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const src = resolveSource(params.source);
      if (!src) return { content: [{ type: "text", text: `❌ 未找到数据源: ${params.source}` }] };

      const relPath = params.relPath.replace(/\\/g, "/");

      // 解析 LLM 结果（兼容 v5.2 segments 和 v5.4 单对象格式）
      const llmData = parseFileLLMResult(params.data);
      if (!llmData) {
        return { content: [{ type: "text", text: "❌ 无法解析编译结果。需要 topic/normalizedText/concepts/aliases 字段。" }] };
      }

      // v5.4: 挂载 ###llm 单向量，不删 AST 向量
      const ok = await storeFileLLMVector(src, relPath, llmData);
      if (!ok) {
        return { content: [{ type: "text", text: `❌ 存储 LLM 向量失败: ${relPath}` }] };
      }

      // 清除编译中锁
      updateFileState(relPath, { compilingSince: undefined });

      return {
        content: [{ type: "text", text: `✅ LLM 向量已存储 (###llm): ${relPath}\n   AST 向量完整保留` }],
        details: { relPath, topic: llmData.topic, concepts: llmData.concepts },
      };
    },
  });
}
