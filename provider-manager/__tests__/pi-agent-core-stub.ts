const IMAGE_CHARS = 4_800;

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    if (!block || typeof block !== "object") return total;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return total + value.text.length;
    if (value.type === "image") return total + IMAGE_CHARS;
    return total;
  }, 0);
}

export function estimateTokens(message: any): number {
  let chars = 0;
  switch (message?.role) {
    case "user":
      chars = contentChars(message.content);
      break;
    case "assistant":
      for (const block of message.content ?? []) {
        if (block?.type === "text") chars += String(block.text ?? "").length;
        else if (block?.type === "thinking") chars += String(block.thinking ?? "").length;
        else if (block?.type === "toolCall") chars += String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
      }
      break;
    case "toolResult":
    case "custom":
      chars = contentChars(message.content);
      break;
    default:
      chars = 0;
  }
  return Math.ceil(chars / 4);
}

export function calculateContextTokens(usage: any): number {
  return usage?.totalTokens ||
    Number(usage?.input ?? 0) +
    Number(usage?.output ?? 0) +
    Number(usage?.cacheRead ?? 0) +
    Number(usage?.cacheWrite ?? 0);
}
