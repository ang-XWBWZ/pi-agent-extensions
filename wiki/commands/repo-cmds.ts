// repo-cmds.ts — 数据源管理 (v2.3)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { loadSource, unloadSource, listSources, repoRoot, readMeta, readIndex } from "../lib/store.js";
import { ensureSkeleton } from "../lib/skeleton.js";

export function cmdLoad(parts: string[], ctx: { cwd: string }, pi: ExtensionAPI): string {
  const tgt = parts[1];
  if (!tgt) return "用法: /wiki load <项目目录>\n例: /wiki load /home/li/pi-agent-extensions";
  const abs = resolve(ctx.cwd, tgt);
  if (!existsSync(abs)) return `❌ 目录不存在: ${abs}`;
  const result = loadSource(abs);
  if (!result.ok) return `⚠️ 已加载: ${abs}`;
  return `✅ 数据源已加载: ${abs}`;
}

export function cmdUnload(parts: string[], ctx: { cwd: string }, pi: ExtensionAPI): string {
  const tgt = parts[1];
  if (!tgt || tgt === "--list") {
    const srcs = listSources();
    if (!srcs.length) return "📭 无数据源";
    return `📂 已加载 ${srcs.length} 个数据源:\n${srcs.map((s, i) => `${i + 1}. ${s.name} → ${s.path}`).join("\n")}`;
  }
  const n = parseInt(tgt, 10);
  let removed: { name: string; path: string } | null = null;
  if (!isNaN(n) && n >= 1) {
    const srcs = listSources();
    if (n <= srcs.length) removed = unloadSource(srcs[n - 1].path);
  } else {
    removed = unloadSource(resolve(ctx.cwd, tgt));
  }
  if (!removed) return `❌ 未找到: ${tgt}`;
  return `🗑️ 已卸载: ${removed.name} (${removed.path})`;
}

export function cmdSources(parts: string[], ctx: { cwd: string }, pi: ExtensionAPI): string {
  const srcs = listSources();
  if (!srcs.length) return "📭 无数据源。使用 /wiki load <项目目录> 加载。";
  return `📂 ${srcs.length} 个数据源:\n${srcs.map((s, i) => `${i + 1}. ${s.name}\n   ${s.path}`).join("\n")}`;
}

export async function cmdStatus(parts: string[], ctx: { cwd: string }, pi: ExtensionAPI): Promise<string> {
  const idx = await readIndex();
  const meta = readMeta();
  const root = repoRoot();
  const srcs = listSources();
  const lines = [
    "📊 Wiki 仓库状态",
    `   仓库: ${root}`,
    `   名称: ${meta.name}`,
    `   条目: ${idx.entryCount} 条, ${Object.keys(idx.trees).length} 分类`,
    `   数据源: ${srcs.length} 个`,
  ];
  if (srcs.length) {
    lines.push(`\n📂 数据源:`);
    for (const s of srcs) lines.push(`   ${s.name} → ${s.path}`);
  }
  if (idx.entryCount > 0) {
    const at = new Set<string>();
    for (const e of Object.values(idx.entries)) for (const t of e.tags || []) at.add(t);
    lines.push(`\n🏷 标签: ${[...at].join(", ")}`);
  }
  return lines.join("\n");
}
