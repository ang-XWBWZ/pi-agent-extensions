/**
 * Conservative fallback for compatible providers that omit streaming usage.
 * ASCII-heavy code is budgeted at roughly three characters per token, while
 * non-ASCII text is weighted higher so CJK conversations do not look empty.
 */
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
