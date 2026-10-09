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

// Since pi 1.1.0 the compaction token estimators live in pi-coding-agent
// (re-exported from ./core/compaction), no longer in pi-agent-core.
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

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: typeof DEFAULT_COMPACTION_SETTINGS,
): boolean {
  return settings.enabled && contextTokens > contextWindow - settings.reserveTokens;
}

export class SessionManager {
  static inMemory() {
    return new SessionManager();
  }
}

export class ModelRegistry {}

export async function createAgentSession(options: unknown) {
  return {
    session: {
      state: { messages: [] },
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      dispose: async () => {},
      sendUserMessage: async () => {},
    },
  };
}
