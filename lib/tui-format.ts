/**
 * Pure formatting helpers shared by extension TUI renderers.
 *
 * Keep this module free of Pi runtime imports so presentation rules can be
 * tested without booting an interactive TUI.
 */

type TextContentLike = { type?: unknown; text?: unknown };

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Remove control sequences that can corrupt a line-oriented terminal render. */
export function normalizeToolText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(/\r/g, "")
    .replace(/\t/g, "   ")
    .replace(UNSAFE_CONTROL, "");
}

/** Extract the textual portion of a tool result without leaking terminal control codes. */
export function getToolTextOutput(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is TextContentLike => !!item && typeof item === "object")
    .filter((item) => item.type === "text")
    .map((item) => normalizeToolText(item.text))
    .join("\n")
    .trim();
}

/** Compact an arbitrary tool argument into one terminal-safe display token. */
export function compactToolValue(value: unknown, maxLength = 120): string {
  let text: string;
  if (typeof value === "string") {
    text = normalizeToolText(value).replace(/\n+/g, " ↵ ");
  } else if (value === undefined) {
    return "";
  } else if (value === null) {
    text = "null";
  } else {
    try {
      text = normalizeToolText(JSON.stringify(value));
    } catch {
      text = "[unserializable]";
    }
  }

  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

export function hasDisplayValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
