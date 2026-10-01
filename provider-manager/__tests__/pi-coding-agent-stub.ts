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
