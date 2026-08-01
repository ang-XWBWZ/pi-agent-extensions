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
