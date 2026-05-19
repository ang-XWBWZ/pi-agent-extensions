// misc-cmds.ts — 杂项: recycle / rules / model (v2.3)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, getWikiModel, setWikiModel } from "../lib/store.js";
import { listRecycle, restoreEntry, cleanRecycle } from "../lib/recycle.js";

export async function cmdRecycle(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const action = parts[1];
  if (!action || action === "--list") {
    const items = await listRecycle();
    if (!items.length) return "♻️ 回收站为空";
    return `♻️ 回收站 (${items.length}):\n${items.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\n恢复: /wiki recycle --restore <id>\n清空: /wiki recycle --clean`;
  }
  if (action === "--restore") {
    const eid = parts[2];
    if (!eid) return "用法: /wiki recycle --restore <条目id>";
    const ok = await restoreEntry(eid);
    return ok ? `✅ 已恢复 \`${eid}\`` : `❌ 恢复失败: ${eid}`;
  }
  if (action === "--clean") {
    const n = await cleanRecycle();
    return `🗑️ 已清空回收站 (${n} 个文件)`;
  }
  return "用法: /wiki recycle [--list|--restore <id>|--clean]";
}

export async function cmdRules(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  try {
    const rp = resolve(repoRoot(), "RULES.md");
    await access(rp);
    return await readFile(rp, "utf-8");
  } catch {
    return "📭 RULES.md 不存在。请确保 wiki 仓库已初始化。";
  }
}

export function cmdModel(parts: string[], _ctx: unknown, pi: ExtensionAPI): string {
  const arg = parts.slice(1).join(" ");
  if (!arg) {
    return `🧠 Wiki 模型: ${getWikiModel()}\n切换: /wiki model <provider>/<model>`;
  }
  const mp = arg.split("/");
  if (mp.length !== 2) return "❌ 格式: <provider>/<model>";
  setWikiModel(arg);
  return `✅ Wiki 模型: ${arg}`;
}
