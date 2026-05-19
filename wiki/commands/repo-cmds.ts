// repo-cmds.ts — load / unload / status (v3.0)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { getSources, addSource, removeSource, stats, mergeIndex } from "../lib/store.js";
import { scanDir } from "../lib/indexer.js";

export function cmdLoad(raw: string, ctx: { cwd: string }): string {
  const parts = raw.trim().split(/\s+/);
  const tgt = parts[0];
  if (!tgt) return "📖 /wiki-load — 加载数据源目录，自动递归扫描索引\n用法: /wiki-load <目录路径>";
  const abs = resolve(ctx.cwd, tgt);
  if (!existsSync(abs)) return `❌ 目录不存在: ${abs}`;
  if (!addSource(abs)) return `⚠️ 已加载: ${abs}`;
  scanDir(abs).then(entries => { mergeIndex(entries); });
  return `✅ 已加载，正在后台索引...\n📂 ${abs}`;
}

export function cmdUnload(raw: string, ctx: { cwd: string }): string {
  const parts = raw.trim().split(/\s+/);
  const tgt = parts[0];
  if (!tgt) {
    const srcs = getSources();
    if (!srcs.length) return "📭 无数据源。使用 /wiki-load <目录> 加载。";
    return `📂 已加载数据源:\n${srcs.map((s, i) => `${i + 1}. ${basename(s)}\n   ${s}`).join("\n")}\n\n卸载: /wiki-unload <序号>`;
  }
  const n = parseInt(tgt, 10);
  let removed: string | null = null;
  if (!isNaN(n)) {
    const srcs = getSources();
    if (n >= 1 && n <= srcs.length) removed = removeSource(srcs[n - 1]);
  } else {
    removed = removeSource(resolve(ctx.cwd, tgt));
  }
  if (!removed) return `❌ 未找到: ${tgt}`;
  return `🗑️ 已卸载: ${basename(removed)}`;
}

export function cmdStatus(): string {
  const st = stats();
  return [
    `📊 Wiki 状态`,
    `   数据源: ${st.sources} 个`,
    `   已索引文件: ${st.files} 篇`,
    `   最后扫描: ${st.lastScan || "从未（使用 /wiki-load 加载数据源）"}`,
  ].join("\n");
}
