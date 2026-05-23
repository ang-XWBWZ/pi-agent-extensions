// query-cmds.ts — search (v4.1)
//
// 用户命令:
//   /wiki-search             → 默认 hybrid（语义启用时）或 keyword
//   /wiki-search-keyword     → 纯关键词搜索
//   /wiki-search-semantic    → 纯语义搜索
//   /wiki-search-hybrid      → 混合搜索
//   /wiki-ask                → 获取匹配文档全文，触发 AI 总结
//   /wiki-close              → 关闭面板

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { keywordSearch } from "../lib/search.js";
import { semanticSearch, hybridSearch } from "../lib/semantic-search.js";
import { getSemanticEnabled } from "../lib/store.js";
import type { SearchHit, SearchMode } from "../lib/types.js";

/** TUI 面板状态 */
let lastResults: { query: string; hits: SearchHit[]; mode: SearchMode } | null = null;

// ============================================================
// 公开命令入口
// ============================================================

/** /wiki-search — 默认搜索（语义启用时 hybrid，否则 keyword） */
export function cmdSearch(raw: string, _pi: ExtensionAPI, ctx: any): string {
  const mode: SearchMode = getSemanticEnabled() ? "hybrid" : "keyword";
  return doSearch(raw, mode, ctx);
}

/** /wiki-search-keyword */
export function cmdSearchKeyword(raw: string, _pi: ExtensionAPI, ctx: any): string {
  return doSearch(raw, "keyword", ctx);
}

/** /wiki-search-semantic */
export function cmdSearchSemantic(raw: string, _pi: ExtensionAPI, ctx: any): string {
  if (!getSemanticEnabled()) return "❌ 语义搜索未启用。对我说「启用 wiki 语义搜索」即可自动配置。";
  return doSearch(raw, "semantic", ctx);
}

/** /wiki-search-hybrid */
export function cmdSearchHybrid(raw: string, _pi: ExtensionAPI, ctx: any): string {
  if (!getSemanticEnabled()) return "❌ 语义搜索未启用。对我说「启用 wiki 语义搜索」即可自动配置。";
  return doSearch(raw, "hybrid", ctx);
}

/** /wiki-close */
export function cmdClose(_raw: string, _pi: ExtensionAPI, ctx: any): string {
  lastResults = null;
  try { ctx.ui.setWidget("wiki-search", undefined); } catch { /* ignore */ }
  return "✅ Wiki 面板已关闭";
}

/** /wiki-ask — 获取匹配文档全文，触发 AI 总结 */
export function cmdAsk(raw: string): string {
  const q = raw.trim();
  if (!q) return "💬 /wiki-ask — 让 AI 基于 wiki 知识库回答你的问题\n用法: /wiki-ask <你的问题>";
  const hits = keywordSearch(q);
  if (!hits.length) return `🔍 未匹配 "${q}"`;
  const top = hits.slice(0, 3);
  const lines = [`🔍 "${q}" — ${hits.length} 结果，返回前 ${top.length} 篇全文:`, ""];
  for (const h of top) {
    lines.push(`📄 **${h.title}** \`${h.relPath}\`\n   ${h.snippet}`);
    const full = resolve(h.sourceDir, h.relPath);
    if (existsSync(full)) {
      try { lines.push(`\n---\n${readFileSync(full, "utf-8").slice(0, 3000)}\n---\n`); } catch {}
    }
  }
  return lines.join("\n");
}

// ============================================================
// 内部
// ============================================================

function modeLabel(m: SearchMode): string {
  return m === "semantic" ? " 语义" : m === "hybrid" ? " 混合" : "";
}

function doSearch(q: string, mode: SearchMode, ctx: any): string {
  if (!q) return usage(mode);

  // 语义/混合模式：异步
  if (mode === "semantic" || mode === "hybrid") {
    const fn = mode === "semantic" ? semanticSearch : hybridSearch;
    fn(q).then(hits => {
      lastResults = { query: q, hits: hits.slice(0, 20), mode };
      renderWidget(ctx);
    }).catch(() => {
      lastResults = { query: q, hits: [], mode };
    });
    lastResults = { query: q, hits: [], mode };
    renderWidget(ctx);
    return `🔍 "${q}" — 语义搜索中...`;
  }

  // keyword：同步
  const hits = keywordSearch(q);
  if (!hits.length) {
    lastResults = { query: q, hits: [], mode };
    return `🔍 未匹配 "${q}"`;
  }
  lastResults = { query: q, hits: hits.slice(0, 20), mode };
  renderWidget(ctx);
  return `🔍 "${q}" — ${hits.length} 结果（面板显示）`;
}

function usage(mode: SearchMode): string {
  const label = modeLabel(mode);
  const base = `🔍 /wiki-search${mode === "keyword" ? "" : mode === "semantic" ? "-semantic" : mode === "hybrid" ? "-hybrid" : ""}`;
  return `${base} — ${label || "关键词"}搜索 wiki${label ? "（基于语义理解）" : ""}\n用法: ${base} <关键词>`;
}

function renderWidget(ctx: any): void {
  try {
    ctx.ui.setWidget("wiki-search", (_tui: any, theme: any) => ({
      render: (width: number) => {
        const r = lastResults;
        const w = Math.max(width - 2, 20);
        const ml = r ? modeLabel(r.mode) : "";
        if (!r || !r.hits.length) {
          const loading = r && r.mode !== "keyword"
            ? [truncateToWidth(theme.fg("muted", "   ⏳ 正在语义搜索..."), w, "…")]
            : [truncateToWidth(theme.fg("muted", "   (无结果)"), w, "…")];
          return [
            truncateToWidth(theme.bold(`🔍 Wiki${ml}搜索: "${r?.query || ""}"`), w, "…"),
            theme.fg("dim", truncateToWidth("─".repeat(60), w, "")),
            ...loading,
          ];
        }
        const lines: string[] = [
          truncateToWidth(theme.bold(`🔍 Wiki${ml}搜索: "${r.query}" — ${r.hits.length} 结果`), w, "…"),
          theme.fg("dim", truncateToWidth("─".repeat(60), w, "")),
        ];
        for (let i = 0; i < Math.min(r.hits.length, 5); i++) {
          const h = r.hits[i];
          const scoreLabel = h.semanticScore != null
            ? `语义 ${Math.round(h.semanticScore * 100)}%`
            : `${h.score}`;
          lines.push(truncateToWidth(theme.fg("accent", `${i + 1}. ${h.title}`), w, "…"));
          lines.push(truncateToWidth(theme.fg("dim", `   ${h.relPath}  (${scoreLabel})`), w, "…"));
          if (h.snippet) lines.push(truncateToWidth(theme.fg("muted", `   ${h.snippet.slice(0, 100)}`), w, "…"));
        }
        if (r.hits.length > 5) lines.push(theme.fg("dim", truncateToWidth(`   ...还有 ${r.hits.length - 5} 个结果`, w, "…")));
        return lines;
      },
      invalidate: () => {},
    }));
  } catch { /* TUI 不可用时忽略 */ }
}

// ============================================================
// /wiki-edit — 搜索 + 读取 + 注入编辑上下文
// ============================================================

/** /wiki-edit <query> — 搜索匹配条目，读取全文，注入 AI 编辑上下文 */
export function cmdEdit(raw: string, pi: any, ctx: any): string {
  const q = raw.trim();
  if (!q) return "💬 /wiki-edit — 修改 wiki 条目\n用法: /wiki-edit <搜索词或文件路径>";

  const hits = keywordSearch(q);
  if (!hits.length) return `🔍 未匹配 "${q}"`;

  if (hits.length > 1) {
    const list = hits.slice(0, 5).map((h, i) =>
      `  ${i + 1}. ${h.title} — ${h.relPath}`
    ).join("\n");
    return `🔍 "${q}" — ${hits.length} 结果，请用更精确的搜索词定位:\n${list}`;
  }

  const h = hits[0];
  const fullPath = resolve(h.sourceDir, h.relPath);
  if (!existsSync(fullPath)) return `❌ 文件不存在: ${h.relPath}`;

  let content: string;
  try { content = readFileSync(fullPath, "utf-8"); } catch {
    return `❌ 无法读取: ${h.relPath}`;
  }

  const msg = [
    `📝 编辑 wiki 条目: **${h.title}**`,
    `   路径: \`${h.relPath}\``,
    `   数据源: \`${h.sourceDir}\``,
    "",
    "--- 当前内容 ---",
    content,
    "--- 结束 ---",
    "",
    "请修改以上内容，然后用 **wiki_edit_modify** 保存：",
    `  wiki_edit_modify(source="${h.sourceDir}", path="${h.relPath}", content=<修改后的全文>)`,
    "",
    "⚠️ content 必须是完整的新全文（含 frontmatter），不是 diff。",
    "   先 wiki_get_entry 确认最新内容，再修改，再 wiki_edit_modify 保存。",
  ].join("\n");

  pi.sendUserMessage(msg);
  return `📝 已加载: ${h.title} (${h.relPath}) — 请 AI 修改后用 wiki_edit_modify 保存`;
}
