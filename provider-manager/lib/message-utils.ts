/**
 * message-utils.ts — 最小化消息转换：pi Message[] → OpenAI Chat Completions messages
 */

import { type Api, type AssistantMessage, calculateCost } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";

export function parseOpenAIUsage(rawUsage: any, model: Model<Api>): AssistantMessage["usage"] {
  const promptTokens = rawUsage?.prompt_tokens ?? 0;
  const outputTokens = rawUsage?.completion_tokens ?? 0;
  const cacheReadTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.prompt_cache_hit_tokens ?? 0;
  const cacheWriteTokens = rawUsage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const usage: AssistantMessage["usage"] = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

export function ensureToolCallId(tc: any, index: number = 0): string {
  if (tc?.id) return String(tc.id);
  const rawName = String(tc?.name || tc?.function?.name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `call_${rawName || "tool"}_${index}`;
}

export function messageIdForUpstream(msg: any, index: number): string {
  if (msg?.id) return String(msg.id);
  if (typeof msg?.timestamp === "number") return `msg_${msg.timestamp}`;
  const role = String(msg?.role || "message").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `msg_${role}_${index}`;
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function finalizeToolCallBlock(block: any): boolean {
  if (!block || typeof block.name !== "string" || block.name.length === 0) return false;
  if (!block.id) block.id = ensureToolCallId(block);

  const rawArgs = typeof block.partialArgs === "string" ? block.partialArgs : undefined;
  if (rawArgs === undefined) {
    block.arguments = parseToolArguments(block.arguments);
    return true;
  }
  if (rawArgs.trim().length === 0) {
    block.arguments = {};
    return true;
  }

  try {
    const parsed = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    block.arguments = parsed;
    return true;
  } catch {
    return false;
  }
}

// ---- 消息规范化 ----

function normalizeMessagesForUpstream(messages: any[]): any[] {
  const result: any[] = [];
  let pendingToolCalls: any[] = [];
  let existingToolResultIds = new Set<string>();

  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length === 0) return;
    for (const tc of pendingToolCalls) {
      const id = ensureToolCallId(tc);
      if (!existingToolResultIds.has(id)) {
        result.push({
          role: "toolResult",
          toolCallId: id,
          toolName: tc.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;

    if (msg.role === "assistant") {
      insertSyntheticToolResults();
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;

      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = content
        .filter((b: any) => b?.type === "toolCall")
        .map((tc: any, idx: number) => ({ ...tc, id: ensureToolCallId(tc, idx) }));
      const normalizedContent = content.map((b: any) => {
        if (b?.type !== "toolCall") return b;
        const matched = toolCalls.shift();
        return matched ?? b;
      });
      const normalizedMsg = { ...msg, content: normalizedContent };
      const normalizedToolCalls = normalizedContent.filter((b: any) => b?.type === "toolCall");
      if (normalizedToolCalls.length > 0) {
        pendingToolCalls = normalizedToolCalls;
        existingToolResultIds = new Set();
      }
      result.push(normalizedMsg);
      continue;
    }

    if (msg.role === "toolResult") {
      const toolCallId = msg.toolCallId || msg.tool_call_id;
      if (toolCallId) existingToolResultIds.add(String(toolCallId));
      result.push(msg);
      continue;
    }

    if (msg.role === "user") {
      insertSyntheticToolResults();
      result.push(msg);
      continue;
    }

    result.push(msg);
  }

  insertSyntheticToolResults();
  return result;
}

export function convertMessagesForUpstream(messages: any[], _model: any): any[] {
  const result: any[] = [];
  const normalizedMessages = normalizeMessagesForUpstream(messages);
  const requiresReasoningContent = !!_model?.reasoning && /deepseek/i.test(`${_model?.provider || ""}/${_model?.id || ""}/${_model?.baseUrl || ""}`);

  for (const msg of normalizedMessages) {
    if (!msg || !msg.role) continue;

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (text) result.push({ role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;

      const textParts = (msg.content || [])
        .filter((b: any) => b?.type === "text" && b.text?.trim()?.length > 0)
        .map((b: any) => b.text);
      const toolCalls = (msg.content || []).filter((b: any) => b?.type === "toolCall");
      const thinkingParts = (msg.content || [])
        .filter((b: any) => b?.type === "thinking" && b.thinking?.trim()?.length > 0);

      const assistantMsg: any = {
        role: "assistant",
        ...(requiresReasoningContent ? { id: messageIdForUpstream(msg, result.length) } : {}),
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: ensureToolCallId(tc),
          type: "function",
          function: { name: tc.name || "tool", arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
        assistantMsg.content = textParts.length > 0 ? textParts.join("\n") : null;
      } else if (textParts.length > 0) {
        assistantMsg.content = textParts.join("\n");
      } else if (thinkingParts.length > 0) {
        assistantMsg.content = thinkingParts.map((b: any) => b.thinking).join("\n");
      } else {
        continue;
      }

      if (requiresReasoningContent && assistantMsg.reasoning_content === undefined) {
        assistantMsg.reasoning_content = "";
      }

      result.push(assistantMsg);
      continue;
    }

    if (msg.role === "toolResult") {
      const toolCallId = msg.toolCallId || msg.tool_call_id;
      if (!toolCallId) continue;
      let content = "";
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      result.push({
        role: "tool",
        ...(requiresReasoningContent ? { id: String(toolCallId) } : {}),
        content: content || "(no result)",
        tool_call_id: toolCallId,
        ...(msg.toolName ? { name: msg.toolName } : {}),
      });
      continue;
    }

    if (msg.role === "tool") {
      result.push(msg);
      continue;
    }
  }

  if (result.length === 0) {
    return [{ role: "user", content: "Hello" }];
  }

  return result;
}
