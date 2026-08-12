export function compactJson(value: unknown, max = 1_200): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable JSON]";
  }
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

export function formatMcpCallCommand(
  server: unknown,
  tool: unknown,
  argumentsValue: unknown,
): string {
  const serverName = typeof server === "string" && server.trim() ? server.trim() : "?";
  const toolName = typeof tool === "string" && tool.trim() ? tool.trim() : "?";
  return `mcp call ${serverName} ${toolName} ${compactJson(argumentsValue ?? {}, 800)}`;
}

export function previewMcpCallResult(
  output: string,
  maxLines: number,
): { lines: string[]; hiddenLineCount: number } {
  const lines = output.replace(/\r/g, "").split("\n");
  if (lines.length <= maxLines) return { lines, hiddenLineCount: 0 };
  return {
    lines: lines.slice(-maxLines),
    hiddenLineCount: lines.length - maxLines,
  };
}
