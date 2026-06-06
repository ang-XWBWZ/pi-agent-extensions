// _helpers.ts — 跨 management 子模块的共享函数 (v5.4)
//
// 从 management.ts 提取，供 management-sources/entries/semantic/compile 共用。

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolve } from "node:path";
import { getSources, getIndex, stats } from "../lib/store.js";
import { getManifestStats } from "../lib/file-manifest.js";

/** 解析用户输入的路径为绝对路径 */
export function resolvePath(raw: string): string {
  return resolve(process.cwd(), raw);
}

/** 生成 frontmatter 模板 */
export function frontmatterTemplate(title: string, tags: string[]): string {
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

/** 解析 source 参数：支持绝对路径或已注册源的名称/末尾匹配 */
export function resolveSource(raw: string): string | null {
  if (existsSync(raw) && getSources().includes(raw)) return raw;
  const srcs = getSources();
  const match = srcs.find(
    (s) => s === raw || s.endsWith(raw) || basename(s) === raw,
  );
  return match || null;
}

/** 格式化数据源列表（含 manifest 编译统计） */
export function formatSourcesList(): string {
  const srcs = getSources();
  const st = stats();
  const mf = getManifestStats();
  if (!srcs.length) return "📭 无已加载数据源。使用 wiki_load_source 加载。";
  const lines = [
    `📂 已加载 ${st.sources} 个数据源（共 ${st.files} 篇，最后扫描: ${st.lastScan || "无"}）`,
    `🧠 语义: ${st.semanticEnabled ? "✅" : "⏸"} | 📝 LLM 编译: ${mf.compiled}/${mf.total} 文件`,
    "",
  ];
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i];
    const count = Object.values(getIndex()).filter(
      (e) => e.sourceDir === src,
    ).length;
    lines.push(`  ${i + 1}. ${basename(src)} — ${count} 篇`);
    lines.push(`     ${src}`);
  }
  return lines.join("\n");
}
