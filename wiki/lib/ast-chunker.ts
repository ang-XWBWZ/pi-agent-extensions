// ast-chunker.ts — Markdown AST 分块器 (v5.3)
//
// 使用 unified + remark-parse 替代 regex 标题分割。
// 蓝图 Phase 1 L1 文档解析层的核心实现。
//
// 核心能力:
//   1. 精确标题识别 — code block / blockquote 内的 # 不误判
//   2. heading_path 构建 — 层级路径 ["React", "Cache", "Strategy"]
//   3. wikilink [[...]] 提取 — Obsidian 互操作
//   4. 代码块分离 — code chunk ↔ commentary chunk 分治
//   5. chunkTypeHint 预判 — AST 特征 → 类型提示

import type { Root, Content, Parent, Heading, Code, Text, List, ListItem } from "mdast";

// ── 懒加载 npm 依赖（避免 node_modules 缺失时扩展加载崩溃）──
let _unified: typeof import("unified").unified | null = null;
let _remarkParse: any = null;
let _visit: typeof import("unist-util-visit").visit | null = null;
let _depsAttempted = false;

async function _ensureDeps(): Promise<boolean> {
  if (_visit) return true;
  if (_depsAttempted) return false;
  _depsAttempted = true;
  try {
    const [uni, rp, uv] = await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("unist-util-visit"),
    ]);
    _unified = uni.unified;
    _remarkParse = rp.default || rp;
    _visit = uv.visit;
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 类型
// ============================================================

/** AST 分块结果（兼容旧 extractChunks 接口 + 新字段） */
export interface ChunkResult {
  key: string;                // "relPath###N"
  heading: string;            // 原始标题（含 # 标记，如 "## 排查过程"）
  level: number;              // 标题级别 1-4
  embedText: string;          // 去标记纯文本 → embedding 输入
  rawText: string;            // 原始 markdown 文本

  // ── v5.3 AST 新增 ──
  headingPath: string[];      // 层级路径，如 ["React", "Cache Strategy"]
  chunkTypeHint: string;      // 预判类型: code | todo | architecture | decision | reference | log | idea | note
  wikilinks: string[];        // [[target]] 中的 target 列表
  startLine: number;          // 在原文中的起始行号 (1-based)
  endLine: number;            // 结束行号
}

/** 内部: AST 遍历产生的 section */
interface ASTSection {
  heading: string;
  level: number;
  headingPath: string[];
  nodes: Content[];           // 属于该 section 的顶层 AST 节点
  startLine: number;
}

// ============================================================
// 主入口: AST 分块
// ============================================================

/**
 * 使用 unified + remark-parse 解析 markdown，按标题切分为语义块。
 *
 * @param raw          原始 markdown 文本
 * @param relPath      文件相对路径（用于 key 生成）
 * @param defaultTitle 无标题时的默认标题
 * @returns 分块结果数组，AST 解析失败时返回空数组（调用方应降级 regex）
 */
export async function extractChunksAST(
  raw: string,
  relPath: string,
  defaultTitle: string,
  maxEmbedLen = 800,
): Promise<ChunkResult[]> {
  // 0. 确保依赖已加载
  if (!(await _ensureDeps())) return [];

  // 1. 解析 AST
  let root: Root;
  try {
    const processor = _unified!().use(_remarkParse);
    root = processor.parse(raw) as Root;
  } catch {
    return []; // 解析失败 → 调用方降级 regex
  }

  // 2. 按 heading 分组顶层节点
  const sections = splitByHeading(root);

  // 3. 提取 frontmatter 中的 title（用于首个隐式块）
  const fmTitle = extractFrontmatterTitle(raw);

  // 4. 构建 headingPath 栈
  const headingStack: string[] = [];
  const pathCache: string[][] = [];

  for (const sec of sections) {
    if (sec.level > 0) {
      pushHeadingStack(headingStack, sec.heading, sec.level);
      pathCache.push([...headingStack]);
    } else {
      pathCache.push([]);
    }
  }

  // 5. 为每个 section 构建 ChunkResult
  const results: ChunkResult[] = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];

    // 决定该块的 heading 和 level
    let chunkHeading: string;
    let chunkLevel: number;
    let chunkHeadingPath: string[];

    if (i === 0 && sec.level === 0) {
      // 首个隐式块（标题前的内容），使用文档标题
      chunkHeading = fmTitle || defaultTitle;
      chunkLevel = 0;
      chunkHeadingPath = [];
    } else if (i === 0 && sec.level > 0) {
      // 第一个块就是标题（没有前导无标题内容）
      chunkHeading = fmTitle || defaultTitle;
      chunkLevel = 0;
      chunkHeadingPath = [];
    } else {
      chunkHeading = sec.heading;
      chunkLevel = sec.level;
      chunkHeadingPath = pathCache[i] ?? [];
    }

    // 提取 wikilinks
    const wikis = extractWikilinks(sec.nodes);

    // chunkTypeHint
    const typeHint = guessChunkType(sec, raw);

    // 构建文本
    const rawText = buildRawTextFromNodes(sec.nodes, raw, sec.startLine);
    const headingClean = chunkHeading.replace(/^#+\s*/, "");
    const bodyEmbed = buildEmbedText(headingClean, sec.nodes, maxEmbedLen);
    // 文件路径语义注入：目录结构携带领域信息
    const pathContext = relPath.replace(/\//g, " > ").replace(/\.md$/i, "");
    const embedText = `[${pathContext}]\n${bodyEmbed}`;

    const normalizedRelPath = relPath.replace(/\\/g, "/");
    results.push({
      key: `${normalizedRelPath}###${i}`,
      heading: chunkHeading,
      level: chunkLevel,
      embedText,
      rawText,
      headingPath: chunkHeadingPath,
      chunkTypeHint: typeHint,
      wikilinks: wikis,
      startLine: sec.startLine,
      endLine: findEndLine(sec.nodes, sec.startLine, raw),
    });
  }

  // 如果整个文件没有标题，作为单个整体块
  if (results.length === 0) {
    const rawText = raw.trim();
    const clean = defaultTitle;
    const pathContext = normalizedRelPath.replace(/\//g, " > ").replace(/\.md$/i, "");
    results.push({
      key: `${normalizedRelPath}###0`,
      heading: defaultTitle,
      level: 0,
      embedText: `[${pathContext}]\n${clean}\n${stripMarkdown(rawText, maxEmbedLen)}`,
      rawText,
      headingPath: [],
      chunkTypeHint: "note",
      wikilinks: [],
      startLine: 1,
      endLine: raw.split("\n").length,
    });
  }

  return results;
}

// ============================================================
// 内部: heading 分割
// ============================================================

/**
 * 遍历 AST 顶层节点，按 heading (depth≤4) 分组。
 * 代码块自动独立成 section。
 */
function splitByHeading(root: Root): ASTSection[] {
  const sections: ASTSection[] = [];
  let currentNodes: Content[] = [];
  let currentStartLine = 1;
  let lineCounter = 1; // remark 节点有 position 信息

  for (const node of root.children) {
    const nodeStartLine = (node as any).position?.start?.line ?? lineCounter;

    if (node.type === "heading" && (node as Heading).depth <= 4) {
      // 先保存当前 section（如果有内容或标题）
      if (currentNodes.length > 0 || sections.length === 0) {
        sections.push({
          heading: sections.length === 0 ? "" : (sections[sections.length - 1] as any)._pendingHeading ?? "",
          level: sections.length === 0 ? 0 : (sections[sections.length - 1] as any)._pendingLevel ?? 0,
          headingPath: [],
          nodes: [...currentNodes],
          startLine: currentStartLine,
        });
      }

      // 开始新的 section
      currentNodes = [];
      currentStartLine = nodeStartLine;

      const h = node as Heading;
      const headingText = "#".repeat(h.depth) + " " + extractTextContent(h);

      sections.push({
        heading: headingText,
        level: h.depth,
        headingPath: [],
        nodes: [],
        startLine: nodeStartLine,
      });
    } else if (node.type === "code") {
      // 代码块独立成 section
      sections.push({
        heading: "",
        level: 0,
        headingPath: [],
        nodes: [node],
        startLine: nodeStartLine,
      });
    } else if (node.type === "yaml" || node.type === "toml") {
      // frontmatter — 跳过
      lineCounter = (node as any).position?.end?.line ?? lineCounter;
      if (currentNodes.length === 0 && sections.length === 0) {
        currentStartLine = lineCounter + 1;
      }
      continue;
    } else if (node.type === "thematicBreak" || node.type === "html") {
      // 分隔线 / HTML — 跳过（不产生内容块）
      lineCounter = (node as any).position?.end?.line ?? lineCounter;
      continue;
    } else {
      // 其他节点（paragraph, list, blockquote, table 等）→ 追加到当前 section
      if (sections.length === 0) {
        // 第一个节点就是非标题内容 → 隐式块
        sections.push({
          heading: "",
          level: 0,
          headingPath: [],
          nodes: [],
          startLine: nodeStartLine,
        });
      }

      const lastSection = sections[sections.length - 1];

      // 如果上一个 section 有 heading 且已经有内容，检查是否应该合并
      // 连续的非 heading 节点合并到同一个 section
      lastSection.nodes.push(node);
    }

    lineCounter = (node as any).position?.end?.line ?? lineCounter + 1;
  }

  // 最后，合并相邻的非 heading section
  return mergeAdjacentSections(sections);
}

/**
 * 合并相邻的无标题 section，避免过度碎片化。
 * 例如: 两个连续的非 heading 节点不应分成两个 section。
 */
function mergeAdjacentSections(sections: ASTSection[]): ASTSection[] {
  const merged: ASTSection[] = [];

  for (const sec of sections) {
    const last = merged[merged.length - 1];

    if (
      last &&
      last.level === 0 &&
      sec.level === 0 &&
      last.heading === "" &&
      sec.heading === ""
    ) {
      // 两个连续的无标题 section → 合并
      last.nodes.push(...sec.nodes);
    } else {
      merged.push(sec);
    }
  }

  return merged;
}

// ============================================================
// 内部: heading stack
// ============================================================

function pushHeadingStack(
  stack: string[],
  heading: string,
  depth: number,
): void {
  const clean = heading.replace(/^#+\s*/, "");
  // 弹出所有 depth >= 当前 depth 的
  while (stack.length >= depth) stack.pop();
  stack.push(clean);
}

// ============================================================
// 内部: 文本提取
// ============================================================

/** 递归提取 AST 节点的纯文本 */
function extractTextContent(node: Content | Parent): string {
  if (node.type === "text") return (node as Text).value;
  if (node.type === "inlineCode") return (node as Text).value;
  if (node.type === "code") return ""; // 代码块不纳入
  if (node.type === "html") return "";
  if (node.type === "yaml" || node.type === "toml") return "";

  if ("children" in node) {
    return (node as Parent).children
      .map((c) => extractTextContent(c as Content))
      .join("")
      .trim();
  }

  return "";
}

/** 去除 markdown 标记，截断到 maxLen */
function stripMarkdown(text: string, maxLen: number): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|\*|_|`|~~/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, maxLen);
}

/** 为 embedding 构建 embedText */
function buildEmbedText(
  headingClean: string,
  nodes: Content[],
  maxLen = 800,
): string {
  const bodyText = nodes
    .map((n) => {
      if (n.type === "code") {
        // 代码块：仅保留 lang 标记，不嵌入完整代码
        const lang = (n as Code).lang || "";
        return lang ? `[代码: ${lang}]` : "[代码]";
      }
      return extractTextContent(n);
    })
    .filter(Boolean)
    .join("\n");

  const plain = stripMarkdown(bodyText, maxLen);
  return headingClean ? `${headingClean}\n${plain}` : plain;
}

/** 从 AST nodes 还原原始 markdown 文本 */
function buildRawTextFromNodes(
  nodes: Content[],
  fullRaw: string,
  startLine: number,
): string {
  if (nodes.length === 0) return "";

  const allLines = fullRaw.split("\n");
  const endLine = findEndLine(nodes, startLine, fullRaw);

  // 直接按行截取
  const lines = allLines.slice(startLine - 1, endLine);
  return lines.join("\n").trim();
}

/** 找到 nodes 在原文中的结束行号 */
function findEndLine(
  nodes: Content[],
  startLine: number,
  raw: string,
): number {
  if (nodes.length === 0) return startLine;

  let maxEnd = startLine;
  for (const node of nodes) {
    const end = (node as any).position?.end?.line;
    if (end && end > maxEnd) maxEnd = end;
  }

  // 如果没有 position 信息，用全文末尾
  if (maxEnd === startLine) {
    maxEnd = raw.split("\n").length;
  }

  return maxEnd;
}

// ============================================================
// 内部: wikilink 提取
// ============================================================

/**
 * 从 AST 节点中提取 [[target]] 或 [[target|alias]]。
 * 使用 visit 遍历所有 text 节点，正则匹配。
 * 不引入 remark-wiki-link 额外依赖。
 */
function extractWikilinks(nodes: Content[]): string[] {
  const targets: string[] = [];

  for (const node of nodes) {
    _visit!(
      node,
      "text",
      (textNode: Text) => {
        const matches = textNode.value.matchAll(
          /\[\[([^\]|#]+)(?:[#|][^\]]+)?\]\]/g,
        );
        for (const m of matches) {
          const target = m[1].trim();
          if (target && !targets.includes(target)) {
            targets.push(target);
          }
        }
      },
    );
  }

  return targets;
}

// ============================================================
// 内部: chunkTypeHint 预判
// ============================================================

/**
 * 根据 AST 节点特征预判 chunk 类型。
 * 不依赖 LLM，纯 AST 启发式。
 */
function guessChunkType(section: ASTSection, raw: string): string {
  const heading = section.heading.replace(/^#+\s*/, "").toLowerCase();
  const hasCode = section.nodes.some((n) => n.type === "code");
  const allText = section.nodes
    .map((n) => extractTextContent(n))
    .join(" ")
    .toLowerCase();

  // 代码块
  if (hasCode) return "code";

  // TODO 列表
  for (const node of section.nodes) {
    if (node.type === "list") {
      const list = node as List;
      for (const item of list.children) {
        const text = extractTextContent(item as Content);
        if (/^\s*\[ \]/.test(text)) return "todo";
      }
    }
  }

  // 标题特征
  if (/架构|拓扑|结构|方案|架构图/.test(heading)) return "architecture";
  if (/决定|决策|结论|决议/.test(heading)) return "decision";
  if (/参考|链接|相关|资源|附录/.test(heading)) return "reference";
  if (/日志|记录|日报|周报|流水/.test(heading)) return "log";
  if (/想法|思路|灵感|idea/i.test(heading)) return "idea";
  if (/问题|排查|故障|报错|异常/.test(heading) || /\?|吗$|怎么|如何|为什么/.test(allText))
    return "question";
  if (/研究|调研|分析|探索/.test(heading)) return "research";

  // 低信息密度 → reference
  if (allText.length < 50) return "reference";

  return "note";
}

// ============================================================
// 内部: frontmatter
// ============================================================

/**
 * 从原始文本中提取 frontmatter title。
 * AST 会跳过 yaml/toml 节点，所以这里用 regex。
 */
function extractFrontmatterTitle(raw: string): string {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";

  for (const line of fmMatch[1].split("\n")) {
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const k = line.slice(0, ci).trim();
    if (k === "title") {
      return line.slice(ci + 1).trim().replace(/['"]/g, "");
    }
  }
  return "";
}
