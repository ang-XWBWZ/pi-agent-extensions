/** Default per-request output cap for custom provider requests. */
export const DEFAULT_NORMAL_MAX_TOKENS = 32_768;

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/** Resolve the requested output limit without consulting context-usage data. */
export function resolveRequestMaxTokens(
  model: { maxTokens?: number },
  explicitMaxTokens?: number,
  normalMaxTokens: number = DEFAULT_NORMAL_MAX_TOKENS,
): number {
  const configuredCap = positiveInteger(model.maxTokens);
  const explicitCap = positiveInteger(explicitMaxTokens);
  const desiredCap = explicitCap ?? normalMaxTokens;
  return configuredCap === undefined ? desiredCap : Math.min(desiredCap, configuredCap);
}
