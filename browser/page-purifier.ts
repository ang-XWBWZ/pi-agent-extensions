/**
 * extensions/browser/page-purifier.ts — 页面 DOM 提纯与 Markdown 压缩转换器
 *
 * 核心目标：
 * 1. 过滤 script, style, svg, iframe 等噪音；
 * 2. 提取语义结构（标题、段落、代码块、链接、按钮、输入框）；
 * 3. 严格控制 Token 长度，支持 offset 分页续读。
 */

export function purifyHtmlToMarkdown(htmlOrText: string, maxChars = 16_000, offset = 0): {
  markdown: string;
  totalChars: number;
  truncated: boolean;
  nextOffset?: number;
} {
  let text = htmlOrText;

  // 1. 移除无意义的头部与大块噪音标签
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 2. 语义转换常见结构
  // 标题
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n");

  // 代码块
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // 段落与换行
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  text = text.replace(/<br\s*[\/]?>/gi, "\n");
  text = text.replace(/<hr\s*[\/]?>/gi, "\n---\n");

  // 列表项
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  // 可交互元素保留语义标记
  text = text.replace(/<button[^>]*>([\s\S]*?)<\/button>/gi, " [Button: $1] ");
  text = text.replace(/<input[^>]*value=["'](.*?)["'][^>]*>/gi, " [Input: $1] ");
  text = text.replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, " [$2]($1) ");

  // 3. 剥离剩余所有 HTML 标签
  text = text.replace(/<[^>]+>/g, "");

  // 4. HTML 实体转义解码
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // 5. 空白行压缩
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const totalChars = text.length;
  if (offset > 0) {
    text = text.slice(offset);
  }

  const truncated = text.length > maxChars;
  const chunk = text.slice(0, maxChars);
  const nextOffset = truncated ? offset + maxChars : undefined;

  return {
    markdown: chunk,
    totalChars,
    truncated,
    nextOffset,
  };
}
