/**
 * path-guard.ts — 受保护路径检测 & Glob 匹配工具
 */

import { resolve, isAbsolute } from "node:path";
import { PROTECTED_PATH_PATTERNS } from "./types.js";

export function isProtectedPath(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(normalized));
}

export function wildcardMatch(pattern: string, target: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    .replace(/\x00/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(target.trim());
}

export function isUnder(base: string, target: string): boolean {
  const b = (base.endsWith("/") ? base : base + "/").replace(/\\/g, "/");
  const t = (isAbsolute(target) ? target : resolve(base, target)).replace(/\\/g, "/");
  return t.toLowerCase().startsWith(b.toLowerCase());
}

export function resolvePath(base: string, p: string): string {
  const clean = p.replace(/^@/, "");
  return isAbsolute(clean) ? clean : resolve(base, clean);
}

export function guessPathPattern(raw: string): string {
  const parts = raw.split(/[\\/]/);
  if (parts.length <= 2) return raw + "\\*";
  return parts.slice(0, -1).join("\\") + "\\*";
}

export function guessCmdPattern(raw: string): string {
  return raw
    .replace(/"[^"]*"/g, "*")
    .replace(/'[^']*'/g, "*")
    .replace(/\S+/g, (w) =>
      /^[a-zA-Z0-9_./:-]+$/.test(w) ? w : "*",
    );
}
