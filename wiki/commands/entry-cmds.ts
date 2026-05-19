// entry-cmds.ts — 条目管理: add / delete (v2.3)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { repoRoot, resolveSource, readIndex, writeIndex, listSources, withIndexLock } from "../lib/store.js";
import { ensureSkeleton, loadEntryTemplate } from "../lib/skeleton.js";
import { recycleEntry } from "../lib/recycle.js";

function parseParent(parts: string[]): { parent: string | null; consumed: number } {
  const pi = parts.indexOf("--parent");
  if (pi >= 0 && pi + 1 < parts.length) {
    return { parent: parts[pi + 1], consumed: 2 };
  }
  return { parent: null, consumed: 0 };
}

function makeEntryId(title: string, existingIds: Set<string>): string {
  let base = title.replace(/[^\w\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "")
    .toLowerCase().slice(0, 40) || "untitled";
  if (!existingIds.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function cmdAdd(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const { parent: customParent } = parseParent(parts);
  const parentIdx = parts.indexOf("--parent");
  const cleanParts = parentIdx >= 0
    ? parts.filter((_, i) => i !== parentIdx && i !== parentIdx + 1)
    : parts;

  const srcFile = cleanParts[1];
  const title = cleanParts.slice(2).join(" ");
  if (!srcFile || !title) {
    return "用法: /wiki add <源文件路径> <条目标题> [--parent <分类>]\n" +
           "例: /wiki add extensions/wiki.ts \"Wiki 插件\" --parent architecture";
  }

  const srcs = listSources();
  if (!srcs.length) return "❌ 无数据源。先 /wiki load <项目目录>";

  await ensureSkeleton();
  const srcAbs = resolveSource(srcFile);
  if (!srcAbs) {
    return `❌ 源文件未找到: ${srcFile}\n   已加载数据源: ${srcs.map(s => s.path).join(", ")}`;
  }

  const idx = await readIndex();
  const existingIds = new Set(Object.keys(idx.entries));
  const eid = makeEntryId(title, existingIds);
  const parent = customParent || dirname(srcFile).replace(/\\/g, "/").split("/")[0] || "root";

  const ext = extname(srcFile);
  const tags = [ext === ".ts" ? "typescript" : ext === ".md" ? "markdown" : "file"];
  if (srcFile.includes("extension")) tags.push("extension");
  if (srcFile.includes("skill")) tags.push("skill");

  const ep = resolve(repoRoot(), "entries", `${eid}.md`);
  await writeFile(ep, loadEntryTemplate(title, srcFile, parent, tags), "utf-8");

  await withIndexLock(async () => {
    const freshIdx = await readIndex();
    if (!freshIdx.trees[parent]) freshIdx.trees[parent] = { label: parent, entries: [] };
    if (!freshIdx.trees[parent].entries.includes(eid)) freshIdx.trees[parent].entries.push(eid);
    freshIdx.entries[eid] = {
      file: `entries/${eid}.md`, title, source: srcFile, parent,
      tags, status: "draft", updatedAt: new Date().toISOString()
    };
    await writeIndex(freshIdx);
  });

  const baseId = title.replace(/[^\w\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 40);
  const dupNote = baseId !== eid
    ? `\n⚠️ 标题冲突，ID 自动调整为 \`${eid}\`` : "";

  return `✅ 已创建 \`${eid}\` [draft]\n📄 ${ep}\n🔗 源: ${srcFile}\n📂 parent: ${parent}\n🏷 ${tags.join(", ")}${dupNote}\n💡 下一步: /wiki generate ${eid}`;
}

export async function cmdDelete(parts: string[], _ctx: unknown, pi: ExtensionAPI): Promise<string> {
  const eid = parts[1];
  if (!eid) return "用法: /wiki delete <条目id>";
  const idx = await readIndex();
  if (!idx.entries[eid]) return `❌ 条目不存在: ${eid}`;
  const ok = await recycleEntry(eid);
  return ok ? `🗑️ \`${eid}\` → .recycle/` : `❌ 删除失败: ${eid}`;
}
