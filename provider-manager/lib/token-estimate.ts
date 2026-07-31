/**
 * Conservative request-size estimator used only when an upstream omits usage.
 *
 * It must never be used as a local context-overflow rejection: providers have
 * their own tokenizers.
 */

/** Normal-turn output cap. Pair with compaction.reserveTokens: 32768 in Pi settings. */
export const DEFAULT_NORMAL_MAX_TOKENS = 32_768;

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function estimateSerializedTokens(value: unknown): number {
  let serialized: string;
  if (typeof value === "string") {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value) ?? "";
    } catch {
      serialized = String(value ?? "");
    }
  }

  if (!serialized) return 0;

  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of serialized) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) asciiChars++;
    else nonAsciiChars++;
  }
  return Math.ceil(asciiChars / 3 + nonAsciiChars * 1.5);
}

/**
 * Resolve one fixed normal-turn output cap. This intentionally does not look
 * at estimated request size: compaction has one owner, Pi's reserveTokens setting.
 */
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
