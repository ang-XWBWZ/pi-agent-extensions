// recycle.ts — 回收站 (v2.3)

import { readFile, access, mkdir, rename, unlink, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { repoRoot, readIndex, writeIndex } from "./store.js";
import { parseFrontmatter } from "./search.js";

export async function recycleEntry(entryId: string): Promise<boolean> {
  const root = repoRoot();
  const src = resolve(root, "entries", `${entryId}.md`);
  const dst = resolve(root, ".recycle", "entries", `${entryId}.md`);
  try {
    await access(src);
    await mkdir(resolve(root, ".recycle", "entries"), { recursive: true });
    await rename(src, dst);
    const idx = await readIndex();
    delete idx.entries[entryId];
    for (const tree of Object.values(idx.trees)) tree.entries = tree.entries.filter(e => e !== entryId);
    await writeIndex(idx);
    return true;
  } catch { return false; }
}

export async function restoreEntry(entryId: string): Promise<boolean> {
  const root = repoRoot();
  const src = resolve(root, ".recycle", "entries", `${entryId}.md`);
  const dst = resolve(root, "entries", `${entryId}.md`);
  try {
    await access(src);
    await rename(src, dst);
    const content = await readFile(dst, "utf-8");
    const { meta } = parseFrontmatter(content);
    const idx = await readIndex();
    const parent = (meta.parent as string) || "root";
    if (!idx.trees[parent]) idx.trees[parent] = { label: parent, entries: [] };
    if (!idx.trees[parent].entries.includes(entryId)) idx.trees[parent].entries.push(entryId);
    idx.entries[entryId] = {
      file: `entries/${entryId}.md`,
      title: (meta.title as string) || entryId,
      source: (meta.source as string) || "",
      parent,
      tags: (meta.tags as string[]) || [],
      status: (meta.status as "draft" | "complete") || "draft",
      updatedAt: new Date().toISOString(),
    };
    await writeIndex(idx);
    return true;
  } catch { return false; }
}

export async function cleanRecycle(): Promise<number> {
  let count = 0;
  try {
    const dir = resolve(repoRoot(), ".recycle", "entries");
    let files: string[];
    try { files = await readdir(dir); } catch { return 0; }
    for (const f of files) { await unlink(resolve(dir, f)); count++; }
  } catch { /* ignore */ }
  return count;
}

export async function listRecycle(): Promise<string[]> {
  try {
    const dir = resolve(repoRoot(), ".recycle", "entries");
    return (await readdir(dir)).filter(f => f.endsWith(".md")).map(f => basename(f, ".md"));
  } catch { return []; }
}
