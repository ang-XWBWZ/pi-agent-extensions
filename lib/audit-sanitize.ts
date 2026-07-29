const SECRET_FIELD =
  /(?:api[_-]?key|token|password|secret|authorization|credential)/i;
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|token|password|secret|authorization|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer\s+)?[^\s;&]+)/gi;
const BEARER_TOKEN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;

export function redactAuditText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]");
}

export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactAuditText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_FIELD.test(key)
        ? "[redacted]"
        : sanitizeAuditValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function compactAuditValue(value: unknown, limit = 800): string {
  let text: string;
  try {
    text = JSON.stringify(sanitizeAuditValue(value)) ?? String(value);
  } catch {
    text = redactAuditText(String(value));
  }
  return text.length > limit ? text.slice(0, limit) + "...[truncated]" : text;
}

export function auditTextPreview(
  content: Array<{ type: string; text?: string }> | undefined,
  limit = 600,
): string | undefined {
  const value = (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  if (!value) return undefined;
  return redactAuditText(
    value.length > limit ? value.slice(0, limit) + "...[truncated]" : value,
  );
}
