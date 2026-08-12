import type { McpServerPolicy } from "./config.js";

export type McpToolEffect =
  | "read"
  | "progress"
  | "workspace_write"
  | "persistent"
  | "destructive"
  | "unknown";

const PWIKI_READ_TOOLS = new Set([
  "wiki_search",
  "wiki_read_entry",
  "wiki_read_chunk",
  "wiki_read_context",
  "wiki_compile_status",
  "wiki_get_compile_prompt",
  "wiki_llm_status",
  "wiki_status",
  "wiki_list_models",
]);

const PWIKI_PERSISTENT_TOOLS = new Set([
  "wiki_load",
  "wiki_refresh",
  "wiki_create_entry",
  "wiki_modify_entry",
  "wiki_rename_entry",
  "wiki_move_entry",
  "wiki_enable_semantic",
  "wiki_generate_embeddings",
  "wiki_store_compiled",
  "wiki_compile",
  "wiki_compile_all",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A policy is local configuration, never data supplied by the model or server.
 * Servers without an explicitly trusted policy stay unknown and require a gate.
 */
export function classifyMcpToolEffect(
  policy: McpServerPolicy,
  tool: string,
  argumentsValue: unknown = {},
): McpToolEffect {
  if (policy !== "pwiki") return "unknown";
  if (PWIKI_READ_TOOLS.has(tool)) return "read";
  if (PWIKI_PERSISTENT_TOOLS.has(tool)) return "persistent";
  if (tool === "wiki_unload") {
    const path = isRecord(argumentsValue) ? argumentsValue.path : undefined;
    return typeof path === "string" && path.trim() ? "destructive" : "read";
  }
  return "unknown";
}
