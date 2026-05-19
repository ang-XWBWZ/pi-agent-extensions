// skeleton.ts — 仓库骨架创建 + 模板加载 (v2.3)

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot, writeMeta, readIndex, writeIndex } from "./store.js";

function loadResource(filename: string): string {
  const paths = [
    resolve(__dirname, "..", "resources", filename),
    resolve(process.cwd(), "wiki-dev", "resources", filename),
  ];
  for (const p of paths) if (existsSync(p)) return readFileSync(p, "utf-8");
  return filename === "rules-template.md" ? FALLBACK_RULES : FALLBACK_ENTRY;
}

export function loadEntryTemplate(title: string, sourceRel: string, parent: string, tags: string[]): string {
  const now = new Date().toISOString().split("T")[0];
  return loadResource("entry-template.md")
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{source\}\}/g, sourceRel)
    .replace(/\{\{parent\}\}/g, parent)
    .replace(/\{\{tags\}\}/g, `[${tags.join(", ")}]`)
    .replace(/\{\{status\}\}/g, "draft")
    .replace(/\{\{created\}\}/g, now)
    .replace(/\{\{updated\}\}/g, now);
}

export async function ensureSkeleton(): Promise<void> {
  const root = repoRoot();
  await mkdir(resolve(root, "entries"), { recursive: true });
  await mkdir(resolve(root, ".recycle"), { recursive: true });
  if (!existsSync(resolve(root, "wiki.json"))) {
    writeMeta({ name: "wiki", sources: [], created: new Date().toISOString().split("T")[0], updated: "" });
  }
  if (!existsSync(resolve(root, "RULES.md"))) {
    await writeFile(resolve(root, "RULES.md"), loadResource("rules-template.md"), "utf-8");
  }
  const idx = await readIndex();
  if (!idx.trees) idx.trees = {};
  if (!idx.entries) idx.entries = {};
  await writeIndex(idx);
}

const FALLBACK_RULES = [
  "# Wiki 写作规范 & AI 操作指引",
  "", "## AI 如何添加条目",
  "1. 用 `/wiki add <源文件路径> <条目标题>` 创建条目",
  "2. 源文件路径相对于已加载的数据源",
  "", "## 条目模板", "```markdown",
  "---", "source: extensions/work-mode.ts", "parent: extensions",
  "tags: [extension, state-machine]", "created: YYYY-MM-DD", "---",
  "# 标题", "## 概述", "## 核心内容", "## 关联", "```",
  "", "## 规则", "- 标题 ≤ 3 级", "- source 指向数据源下的原始文件",
  "- tags ≥ 2 个", "- 条目间用 [[条目id]] 互相引用",
].join("\n");

const FALLBACK_ENTRY = [
  "---", "source: {{source}}", "parent: {{parent}}",
  "tags: {{tags}}", "status: {{status}}",
  "created: {{created}}", "updated: {{updated}}", "---",
  "", "# {{title}}", "", "## 概述",
  "_（待补充）_", "", "## 核心内容", "_（待补充）_", "",
  "## 关联", "- 原始文件: [{{source}}]({{source}})", "",
].join("\n");
