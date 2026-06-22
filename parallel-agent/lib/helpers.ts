/**
 * helpers.ts — 通用工具函数（无 pi 依赖）
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

// ---- 文本截断 ----

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  let result = text;
  while (result.length > 0 && visibleWidth(result) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result;
}

// ---- 上下文加载 ----

export async function loadContext(paths: string[], cwd: string): Promise<string> {
  const chunks: string[] = [];
  for (const p of paths) {
    try {
      const abs = resolve(cwd, p);
      await access(abs);
      const content = await readFile(abs, "utf-8");
      chunks.push(`\n--- FILE: ${p} ---\n${content.slice(0, 50_000)}`);
    } catch {
      chunks.push(`\n[无法读取: ${p}]`);
    }
  }
  return chunks.join("\n");
}

// ---- Skill 前端解析（YAML frontmatter + 异常降级） ----

export interface SkillFrontmatter {
  name: string;
  description: string;
  raw: string;
  complete: boolean;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fmText = match[1];
  const lines = fmText.split('\n');
  let name = '';
  let desc = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) { name = nameMatch[1].trim(); continue; }

    const descStart =
      line.match(/^description:\s*[>|]\s*/) ||
      line.match(/^description:\s*(.+)/);
    if (descStart) {
      if (descStart[1]) {
        desc = descStart[1].trim();
      } else {
        const descLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const sub = lines[j];
          if (/^[ \t]/.test(sub)) {
            descLines.push(sub.trim());
          } else {
            break;
          }
        }
        desc = descLines.join(' ');
        i += descLines.length;
      }
    }
  }

  if (!name) return null;
  return { name, description: desc, raw: match[0], complete: !!desc };
}

export function partialReveal(content: string): string {
  const len = content.length;
  const sizeKB = (len / 1024).toFixed(1);

  let partial: string;
  if (len < 1024) {
    partial = content;
  } else if (len < 5120) {
    partial = content.slice(0, 2048);
  } else if (len < 15360) {
    partial = content.slice(0, 3072) + '\n... [截断] ...\n' + content.slice(-1024);
  } else {
    partial = content.slice(0, 1024) + '\n... [截断] ...\n' + content.slice(-512);
  }

  return `\u26a0\ufe0f [partial reveal \u2014 原始文件 ${sizeKB}KB, 未解析到 frontmatter]\n${partial}`;
}

// ---- Skill 文件加载 ----

export async function loadSkill(name: string): Promise<string> {
  const searchPaths = [
    resolve(process.cwd(), "skills", name, "SKILL.md"),
    resolve(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "skills", name, "SKILL.md"),
    resolve(process.env.HOME || process.env.USERPROFILE || ".", ".agents", "skills", name, "SKILL.md"),
  ];

  for (const skillPath of searchPaths) {
    try {
      await access(skillPath);
      const content = await readFile(skillPath, "utf-8");
      return `\n--- SKILL: ${name} ---\n${content.slice(0, 30_000)}`;
    } catch {
      // 尝试下一个路径
    }
  }

  return `\n[无法加载 skill: ${name}]`;
}

// ---- Token 估算 ----

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "M" : v + "M";
  }
  if (n >= 1_000) {
    const v = (n / 1_000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "k" : v + "k";
  }
  return String(Math.round(n));
}

// ---- sessionManager → taskId 映射，用于 send_agent_message 自动识别发送方 ----
export const subAgentIdentity = new WeakMap<object, string>();
