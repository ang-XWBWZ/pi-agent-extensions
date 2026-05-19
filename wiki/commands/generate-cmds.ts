// generate-cmds.ts — 条目生成向导 (v2.3 路线 A)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, readIndex, resolveSource } from "../lib/store.js";

export async function cmdGenerate(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const eid = parts[1];
  if (!eid) return "用法: /wiki generate <条目id>\n例: /wiki generate work-mode";

  const idx = await readIndex();
  const entry = idx.entries[eid];
  if (!entry) return `❌ 条目不存在: ${eid}`;

  const entryPath = resolve(repoRoot(), "entries", `${eid}.md`);
  try { await readFile(entryPath, "utf-8"); } catch {
    return `❌ 条目文件不存在: ${entryPath}`;
  }

  const srcAbs = resolveSource(entry.source);
  if (!srcAbs) {
    return `❌ 源文件未找到: ${entry.source}\n   请确认数据源已加载: /wiki sources`;
  }

  return [
    `📝 条目 \`${eid}\` 待填充 [${entry.status}]`,
    ``,
    `   源文件: ${entry.source} → ${srcAbs}`,
    `   条目文件: ${entryPath}`,
    ``,
    `💡 请让 AI 读取源文件后编辑条目：`,
    `   "阅读 ${entry.source}，然后编辑 ${entryPath}，`,
    `    按照 RULES.md 规范填充 _（待补充）_ 部分，`,
    `    并将 status 改为 complete"`,
  ].join("\n");
}
