/**
 * provider-manager.ts — 自定义供应商管理
 *
 * 独立负责自定义供应商的注册、持久化、启动恢复。
 * Openai 兼容流全部复用 pi-main 内置 provider，只通过 tolerant wrapper
 * 处理供应商缺少 finish_reason 的兼容问题。
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

interface CustomProviderEntry {
  baseUrl: string;
  apiKey: string;
  apiStyle: "openai" | "anthropic";
  models: DiscoveredModel[];
  createdAt: number;
  /** 旧字段兼容：customStream 被 streamCompatMode 替代 */
  customStream?: boolean;
  customStreamExplicit?: boolean;
  supportsUsageInStreaming?: boolean;
  streamCompatMode?: "builtin" | "finish-reason-fallback";
}

interface DiscoveredModel {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface TestResult {
  ok: boolean;
  error?: string;
  detectedApi?: "openai" | "anthropic";
  needsFinishReasonFallback?: boolean;
}

const CUSTOM_PROVIDERS_KEY = "customProviders";
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

function sp(): string {
  return path.join(process.env.USERPROFILE ?? ".", ".pi", "agent", "settings.json");
}

function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(sp(), "utf-8")); } catch { return {}; }
}

function writeSettingsRaw(data: Record<string, unknown>): void {
  fs.writeFileSync(sp(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function readCustomProviders(): Record<string, CustomProviderEntry> {
  const s = readSettings();
  const providers = s[CUSTOM_PROVIDERS_KEY] as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== "object") return {};
  const result: Record<string, CustomProviderEntry> = {};
  for (const [key, val] of Object.entries(providers)) {
    const v = val as Record<string, unknown>;
    if (v && typeof v.baseUrl === "string" && typeof v.apiKey === "string") {
      const streamCompatVal = v.streamCompatMode;
      const streamCompatMode: "builtin" | "finish-reason-fallback" | undefined =
        streamCompatVal === "builtin" || streamCompatVal === "finish-reason-fallback"
          ? streamCompatVal
          : undefined;
      result[key] = {
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        apiStyle: (v.apiStyle as "openai" | "anthropic") || "openai",
        models: Array.isArray(v.models) ? (v.models as DiscoveredModel[]) : [],
        createdAt: (v.createdAt as number) || Date.now(),
        customStream: v.customStream === true,
        customStreamExplicit: v.customStreamExplicit === true,
        streamCompatMode,
        supportsUsageInStreaming: typeof v.supportsUsageInStreaming === "boolean"
          ? v.supportsUsageInStreaming
          : undefined,
      };
    }
  }
  return result;
}

function writeCustomProviders(providers: Record<string, CustomProviderEntry>): void {
  const s = readSettings();
  if (Object.keys(providers).length > 0) s[CUSTOM_PROVIDERS_KEY] = providers;
  else delete s[CUSTOM_PROVIDERS_KEY];
  writeSettingsRaw(s);
}

function normalizeBaseUrl(url: string): string {
  let u = url.replace(/\/+$/, "");
  u = u.replace(/\/v1$/, "");
  return u;
}

function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function parseOpenAIUsage(rawUsage: any, model: Model<Api>): AssistantMessage["usage"] {
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

/**
 * 创建直连 fetch-based tolerant stream handler。
 *
 * 不依赖 pi-main 内置 provider 的流处理，直接发送 HTTP 请求到上游，
 * 手动解析 SSE chunks。这样完全避开 pi-main 对 provider/baseUrl 的自动检测。
 *
 * 关键兼容处理：
 * 1. reasoning_content 当作 thinking block 处理
 * 2. 缺少 finish_reason 但已有输出时补 "stop"
 * 3. content 始终 null 的上游（DeepSeek 思考模式）能正常出字
 * 4. real HTTP 400 / timeout 原样报错
 */
function createOpenAITolerantStream() {
  return function tolerantStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const outer = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }

        // 内置 convertMessages + transformMessages 复刻（最小化，只做必要转换）
        const messages = convertMessagesForUpstream(context.messages, model);

        const reqBody: any = {
          model: model.id,
          messages,
          stream: true,
          max_tokens: options?.maxTokens || model.maxTokens || 4096,
        };

        const cacheRetention = options?.cacheRetention || "short";
        const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
        const promptCacheKey = clampOpenAIPromptCacheKey(cacheSessionId);
        if (promptCacheKey) {
          reqBody.prompt_cache_key = promptCacheKey;
        }
        if (cacheRetention === "long") {
          reqBody.prompt_cache_retention = "24h";
        }

        if (options?.temperature !== undefined) {
          reqBody.temperature = options.temperature;
        }

        // 思考级别 → 上游 reasoning_effort
        const reasoning = options?.reasoning;
        if (reasoning && reasoning !== "off" && model.reasoning) {
          // DeepSeek 格式需同时发 thinking
          if (/deepseek/i.test(model.id)) {
            reqBody.thinking = { type: "enabled" };
          }
          reqBody.reasoning_effort = reasoning;
        }

        // 发送 tools
        if (context.tools && context.tools.length > 0) {
          reqBody.tools = context.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }));
        }

        const baseUrl = model.baseUrl.replace(/\/+$/, "");
        let url = baseUrl;
        if (!url.endsWith("/chat/completions")) {
          if (!url.endsWith("/v1")) url += "/v1";
          url += "/chat/completions";
        }

        const controller = new AbortController();
        if (options?.signal) {
          if (options.signal.aborted) throw new Error("Request was aborted");
          options.signal.addEventListener("abort", () => controller.abort());
        }
        const timeoutMs = options?.timeoutMs || 120000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const reqHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          ...(options?.headers || {}),
        };
        if (cacheSessionId) {
          reqHeaders.session_id = reqHeaders.session_id ?? cacheSessionId;
          reqHeaders["x-client-request-id"] = reqHeaders["x-client-request-id"] ?? cacheSessionId;
          reqHeaders["x-session-affinity"] = reqHeaders["x-session-affinity"] ?? cacheSessionId;
        }

        const response = await fetch(url, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "Unknown error");
          throw new Error(`API request failed: ${response.status} - ${errText.slice(0, 500)}`);
        }
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let hasFinishReason = false;
        let finishReason: string | null = null;
        let textBlock: any = null;
        let thinkingBlock: any = null;
        const toolCallBlocks: any[] = [];
        const toolCallBlocksById = new Map<string, any>();
        const toolCallBlocksByIndex = new Map<number, any>();

        const getIdx = (b: any) => output.content.indexOf(b);
        const ensureTextBlock = () => {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            output.content.push(textBlock);
            outer.push({ type: "text_start", contentIndex: getIdx(textBlock), partial: output });
          }
          return textBlock;
        };
        const ensureThinkingBlock = (signature: string) => {
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
            output.content.push(thinkingBlock);
            outer.push({ type: "thinking_start", contentIndex: getIdx(thinkingBlock), partial: output });
          }
          return thinkingBlock;
        };
        const emitNonStreamingFallback = async (): Promise<string | null> => {
          const fallbackBody = { ...reqBody, stream: false };
          delete fallbackBody.stream_options;
          const fallbackHeaders = { ...reqHeaders, Accept: "application/json" };
          const fallbackResponse = await fetch(url, {
            method: "POST",
            headers: fallbackHeaders,
            body: JSON.stringify(fallbackBody),
            signal: controller.signal,
          });
          if (!fallbackResponse.ok) {
            const errText = await fallbackResponse.text().catch(() => "Unknown error");
            throw new Error(`API request failed: ${fallbackResponse.status} - ${errText.slice(0, 500)}`);
          }

          const data: any = await fallbackResponse.json();
          if (data.usage) {
            output.usage = parseOpenAIUsage(data.usage, model);
          }

          const choice = data.choices?.[0];
          const message = choice?.message;
          if (!message) return choice?.finish_reason ?? null;

          for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
            const val = message[field];
            if (typeof val === "string" && val.length > 0) {
              const block = ensureThinkingBlock(field);
              block.thinking += val;
              outer.push({ type: "thinking_delta", contentIndex: getIdx(block), delta: val, partial: output });
              break;
            }
          }

          if (typeof message.content === "string" && message.content.length > 0) {
            const block = ensureTextBlock();
            block.text += message.content;
            outer.push({ type: "text_delta", contentIndex: getIdx(block), delta: message.content, partial: output });
          }

          if (Array.isArray(message.tool_calls)) {
            for (const tc of message.tool_calls) {
              const block = {
                type: "toolCall",
                id: tc.id || ensureToolCallId(tc),
                name: tc.function?.name || "",
                arguments: parseToolArguments(tc.function?.arguments),
              };
              toolCallBlocks.push(block);
              output.content.push(block);
              outer.push({ type: "toolcall_start", contentIndex: getIdx(block), partial: output });
            }
          }

          return choice?.finish_reason ?? (output.content.length > 0 ? "stop" : null);
        };

        outer.push({ type: "start", partial: output });

        while (true) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const raw of events) {
            const trimmed = raw.trim();
            if (!trimmed || trimmed === "data: [DONE]" || !trimmed.startsWith("data: ")) continue;
            let data: any;
            try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

            if (data.usage) {
              output.usage = parseOpenAIUsage(data.usage, model);
            }

            if (!data.choices?.length) continue;
            const choice = data.choices[0];
            if (!choice || !choice.delta) continue;

            if (choice.finish_reason) {
              hasFinishReason = true;
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;

            // reasoning_content → thinking block
            for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
              const val = delta[field];
              if (typeof val === "string" && val.length > 0) {
                const block = ensureThinkingBlock(field);
                block.thinking += val;
                outer.push({ type: "thinking_delta", contentIndex: getIdx(block), delta: val, partial: output });
                break;
              }
            }

            // content → text block
            const content = delta.content;
            if (typeof content === "string" && content.length > 0) {
              const block = ensureTextBlock();
              block.text += content;
              outer.push({ type: "text_delta", contentIndex: getIdx(block), delta: content, partial: output });
            }

            // tool_calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                let block = tc.id ? toolCallBlocksById.get(tc.id) : undefined;
                if (!block && tc.index !== undefined) block = toolCallBlocksByIndex.get(tc.index);
                if (!block) {
                  block = { type: "toolCall", id: tc.id || "", name: tc.function?.name || "", arguments: {}, partialArgs: "" };
                  toolCallBlocks.push(block);
                  output.content.push(block);
                  outer.push({ type: "toolcall_start", contentIndex: getIdx(block), partial: output });
                }
                if (tc.id) toolCallBlocksById.set(tc.id, block);
                if (tc.index !== undefined) toolCallBlocksByIndex.set(tc.index, block);
                if (!block.name && tc.function?.name) block.name = tc.function.name;
                if (tc.function?.arguments) {
                  block.partialArgs = (block.partialArgs ?? "") + tc.function.arguments;
                  try { block.arguments = JSON.parse(block.partialArgs); } catch { /* partial */ }
                  outer.push({ type: "toolcall_delta", contentIndex: getIdx(block), delta: tc.function.arguments, partial: output });
                }
              }
            }
          }
        }

        // 收尾
        clearTimeout(timeoutId);

        const hasOutput = !!thinkingBlock || !!textBlock || toolCallBlocks.length > 0;

        // 补 finish_reason
        if (!hasFinishReason) {
          if (hasOutput) {
            finishReason = "stop";
          } else {
            finishReason = await emitNonStreamingFallback();
            if (!finishReason && output.content.length === 0) {
              throw new Error("Stream ended without finish_reason and no content");
            }
          }
        }

        if (thinkingBlock) {
          outer.push({ type: "thinking_end", contentIndex: getIdx(thinkingBlock), content: thinkingBlock.thinking, partial: output });
        }
        if (textBlock) {
          outer.push({ type: "text_end", contentIndex: getIdx(textBlock), content: textBlock.text, partial: output });
        }
        for (const b of toolCallBlocks) {
          delete (b as any).partialArgs;
          outer.push({ type: "toolcall_end", contentIndex: getIdx(b), toolCall: b, partial: output });
        }

        let mapped: string = "stop";
        if (finishReason === "length") mapped = "length";
        else if (finishReason === "tool_calls") mapped = "toolUse";
        else if (finishReason === "end" || finishReason === "stop") mapped = "stop";

        output.stopReason = mapped as any;
        outer.push({ type: "done", reason: mapped as any, message: output });
        outer.end();
      } catch (err: any) {
        const msg = err?.message || String(err);
        const aborted = err?.name === "AbortError" || msg === "Request was aborted";
        outer.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: { ...output, stopReason: aborted ? "aborted" : "error", errorMessage: msg },
        });
        outer.end();
      }
    })();

    return outer;
  };
}

/**
 * 最小化消息转换：pi Message[] → OpenAI Chat Completions messages。
 * 不需要完整复刻 pi-main，只处理 user/assistant/tool 三种核心角色。
 */
function convertMessagesForUpstream(messages: any[], _model: any): any[] {
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
        continue; // empty
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

function ensureToolCallId(tc: any, index: number = 0): string {
  if (tc?.id) return String(tc.id);
  const rawName = String(tc?.name || tc?.function?.name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `call_${rawName || "tool"}_${index}`;
}

function messageIdForUpstream(msg: any, index: number): string {
  if (msg?.id) return String(msg.id);
  if (typeof msg?.timestamp === "number") return `msg_${msg.timestamp}`;
  const role = String(msg?.role || "message").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `msg_${role}_${index}`;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
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

async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  apiStyle: string = "auto",
  testModel?: string,
): Promise<TestResult> {
  const clean = normalizeBaseUrl(baseUrl);

  async function pickOpenAIModel(): Promise<string | undefined> {
    if (testModel) return testModel;
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      return data.data?.find((m) => m.id && !m.id.startsWith("ft:"))?.id;
    } catch {
      return undefined;
    }
  }

  async function openAIChatHasFinishReason(model: string): Promise<boolean> {
    try {
      const resp = await fetch(`${clean}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
          stream: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok || !resp.body) return false;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (/"finish_reason"\s*:\s*"(?!null)[^"]+"/.test(buf)) return true;
          if (buf.includes("[DONE]") || buf.length > 16_000) return false;
        }
      } finally {
        try { await reader.cancel(); } catch {}
      }
    } catch {
      return false;
    }
    return false;
  }

  if (apiStyle === "openai" || apiStyle === "auto") {
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) {
        const model = await pickOpenAIModel();
        const hasFinishReason = model ? await openAIChatHasFinishReason(model) : false;
        return { ok: true, detectedApi: "openai", needsFinishReasonFallback: !hasFinishReason };
      }
      if (apiStyle === "openai") {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `OpenAI 测试失败 (HTTP ${resp.status}): ${body.slice(0, 200)}` };
      }
    } catch (e: unknown) {
      if (apiStyle === "openai") return { ok: false, error: `OpenAI 连接失败: ${(e as Error).message}` };
    }
  }

  if (apiStyle === "anthropic" || apiStyle === "auto") {
    try {
      const resp = await fetch(`${clean}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: testModel || "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) return { ok: true, detectedApi: "anthropic" };
      return { ok: false, error: `Anthropic 测试失败 (HTTP ${resp.status})` };
    } catch (e: unknown) {
      return { ok: false, error: `Anthropic 连接失败: ${(e as Error).message}` };
    }
  }

  return { ok: false, error: `未知 API 风格: ${apiStyle}` };
}

async function discoverModelsFromProvider(baseUrl: string, apiKey: string, apiStyle: string): Promise<DiscoveredModel[]> {
  const clean = normalizeBaseUrl(baseUrl);

  if (apiStyle === "openai") {
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      if (!data.data || !Array.isArray(data.data)) return [];
      return data.data.filter((m) => m.id && !m.id.startsWith("ft:")).map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return [];
    }
  }

  if (apiStyle === "anthropic") {
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: Array<{ id: string; display_name?: string }> };
        if (data.data && Array.isArray(data.data)) return data.data.map((m) => ({ id: m.id, name: m.display_name || m.id }));
      }
    } catch {
      // fall through
    }
    return [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
      { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
    ];
  }

  return [];
}

function detectContextWindow(modelId: string): number {
  if (/v4-flash|v4-pro|1m|1000k|minimax-m3|mimo/i.test(modelId)) return 1000000;
  if (/gpt-5\.5/i.test(modelId)) return 272000;
  if (/gpt-5\.4$/i.test(modelId)) return 500000;
  if (/kimi-k2\.6|kimi-k2\.5|qwen3\.7|qwen3-7|glm-5\.1|glm-5|command-a/i.test(modelId)) return 262144;
  if (/claude|haiku|sonnet|opus/i.test(modelId)) return 200000;
  return 256000;
}

function buildModelConfigs(
  models: DiscoveredModel[],
  contextWindow?: number,
  maxTokens?: number,
  compat?: Record<string, unknown>,
) {
  return models.map((m) => {
    const isReasoning = m.reasoning !== false;
    return {
      id: m.id,
      name: m.name || m.id,
      reasoning: isReasoning,
      thinkingLevelMap: isReasoning
        ? { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }
        : undefined,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextWindow: m.contextWindow ?? contextWindow ?? detectContextWindow(m.id),
      maxTokens: m.maxTokens ?? maxTokens ?? (isReasoning ? 16384 : 4096),
      ...(compat && Object.keys(compat).length > 0 ? { compat } : {}),
    };
  });
}

function registerCustomProvider(
  pi: ExtensionAPI,
  providerName: string,
  baseUrl: string,
  apiKey: string,
  apiStyle: "openai" | "anthropic",
  modelConfigs: ReturnType<typeof buildModelConfigs>,
  streamCompatMode: "builtin" | "finish-reason-fallback",
): void {
  const hdrs: Record<string, string> = {};
  let authHeader = false;
  if (apiStyle === "anthropic") {
    hdrs["x-api-key"] = apiKey;
    hdrs["anthropic-version"] = "2023-06-01";
  } else {
    authHeader = true;
  }

  if (streamCompatMode === "finish-reason-fallback" && apiStyle === "openai") {
    // 注册自定义 API（tolerant wrapper），复用 pi-main 消息转换
    const tolerantApiName = `${providerName}-openai-tolerant`;
    for (const m of modelConfigs) (m as any).api = tolerantApiName;
    pi.registerProvider(providerName, {
      name: providerName,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      api: tolerantApiName,
      headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
      authHeader: authHeader || undefined,
      models: modelConfigs,
      streamSimple: createOpenAITolerantStream(),
    });
    return;
  }

  pi.registerProvider(providerName, {
    name: providerName,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    api: apiStyle === "anthropic" ? "anthropic-messages" : "openai-completions",
    headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
    authHeader: authHeader || undefined,
    models: modelConfigs,
  });
}

function restoreCustomProviders(pi: ExtensionAPI): void {
    const customProviders = readCustomProviders();
    for (const [name, cfg] of Object.entries(customProviders)) {
      try {
        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        // 旧 customStream 字段兼容 → finish-reason-fallback
        const legacyCustomStream = cfg.customStream === true && cfg.customStreamExplicit === true;
        const streamCompatMode = cfg.streamCompatMode
          ?? (legacyCustomStream ? "finish-reason-fallback" : "builtin");
        registerCustomProvider(pi, name, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, streamCompatMode);
      } catch {
        // Skip failed re-registrations; the manage_providers tool can report persisted entries.
      }
    }
}

export default function (pi: ExtensionAPI) {
  restoreCustomProviders(pi);

  pi.on("session_start", async () => {
    restoreCustomProviders(pi);
  });

  pi.registerTool({
    name: "manage_providers",
    label: "Manage Providers",
    description: "注册、移除、列出自定义模型供应商。",
    promptSnippet: "Register/list/remove custom model providers. Use switch_model only after provider registration.",
    promptGuidelines: [
      "Use action=register with baseUrl+apiKey to add a custom provider.",
      "apiStyle can be auto, openai, or anthropic; auto tests OpenAI-compatible first.",
      "Provider names are suffixed with detected API style: {name}-{openai|anthropic}.",
      "All custom provider models support every standard thinking level by default.",
      "Use action=set_reasoning_models with provider+reasoningModels only when you want to restrict reasoning models.",
      "Use action=set_model_limits with provider+model+contextWindow/maxTokens to edit one model's limits.",
      "Use action=list to inspect persisted custom providers.",
      "Use action=remove with provider=<name> to unregister and remove a custom provider.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "register|remove|list|set_reasoning_models|set_model_limits" })),
      provider: Type.Optional(Type.String({ description: "供应商名称" })),
      model: Type.Optional(Type.String({ description: "模型 ID (set_model_limits 使用)" })),
      baseUrl: Type.Optional(Type.String({ description: "API 基础地址 (register 必填)" })),
      apiKey: Type.Optional(Type.String({ description: "API 密钥 (register 必填)" })),
      apiStyle: Type.Optional(Type.String({ description: "openai|anthropic|auto，默认 auto" })),
      testModel: Type.Optional(Type.String({ description: "测试用模型 ID" })),
      contextWindow: Type.Optional(Type.Number({ description: "上下文窗口大小，可选" })),
      maxTokens: Type.Optional(Type.Number({ description: "最大输出 token，可选" })),
      reasoningModels: Type.Optional(Type.Array(Type.String({ description: "Model IDs that should keep thinking/reasoning when restricting manually" }))),
      supportsUsageInStreaming: Type.Optional(Type.Boolean({ description: "OpenAI 流式响应是否支持 usage 尾包，默认 true；异常时可设 false" })),
      streamCompatMode: Type.Optional(Type.String({ description: "流兼容模式: builtin(默认) | finish-reason-fallback(上游缺少finish_reason时用)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      const action = params.action || "list";

      if (action === "list") {
        const customProviders = readCustomProviders();
        const names = Object.keys(customProviders);
        if (names.length === 0) {
          return { content: [{ type: "text", text: "没有已注册的自定义供应商。使用 manage_providers action=register 添加。" }], details: { providers: [] } };
        }
        const lines = names.map((name) => {
          const c = customProviders[name];
          const since = new Date(c.createdAt).toLocaleDateString();
          return `  • ${name} — ${c.apiStyle}, ${c.models.length} 个模型 (${since})`;
        });
        return { content: [{ type: "text", text: `自定义供应商 (${names.length}):\n${lines.join("\n")}` }], details: { providers: names } };
      }

      if (action === "remove") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider 名称" }], details: {} };
        const customProviders = readCustomProviders();
        if (!customProviders[providerName]) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `自定义供应商 "${providerName}" 不存在。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }
        try { pi.unregisterProvider(providerName); } catch {}
        delete customProviders[providerName];
        writeCustomProviders(customProviders);
        return { content: [{ type: "text", text: `✅ 已移除自定义供应商: ${providerName}` }], details: { provider: providerName } };
      }

      if (action === "set_reasoning_models") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider" }], details: {} };
        if (!Array.isArray(params.reasoningModels)) return { content: [{ type: "text", text: "需要 reasoningModels" }], details: {} };
        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `provider 不存在: ${providerName}。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }

        const reasoningModelIds = new Set((params.reasoningModels as string[]).map((id) => id.trim()).filter(Boolean));
        cfg.models = cfg.models.map((m) => ({ ...m, reasoning: reasoningModelIds.has(m.id) }));
        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(pi, providerName, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, cfg.streamCompatMode ?? "builtin");

        return {
          content: [{ type: "text", text: `✅ 已更新 ${providerName} reasoning models: ${[...reasoningModelIds].join(", ") || "(none)"}` }],
          details: { provider: providerName, reasoningModels: [...reasoningModelIds] },
        };
      }

      if (action === "set_model_limits") {
        const providerName = params.provider?.trim();
        const modelId = params.model?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider" }], details: {} };
        if (!modelId) return { content: [{ type: "text", text: "需要 model" }], details: {} };
        const contextWindow = params.contextWindow !== undefined ? Number(params.contextWindow) : undefined;
        const maxTokens = params.maxTokens !== undefined ? Number(params.maxTokens) : undefined;
        if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
          return { content: [{ type: "text", text: "contextWindow 必须是正数" }], details: {} };
        }
        if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
          return { content: [{ type: "text", text: "maxTokens 必须是正数" }], details: {} };
        }
        if (contextWindow === undefined && maxTokens === undefined) {
          return { content: [{ type: "text", text: "需要 contextWindow 或 maxTokens" }], details: {} };
        }

        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `provider 不存在: ${providerName}。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }

        let found = false;
        cfg.models = cfg.models.map((m) => {
          if (m.id !== modelId) return m;
          found = true;
          return {
            ...m,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          };
        });
        if (!found) {
          return { content: [{ type: "text", text: `模型不存在: ${providerName}/${modelId}` }], details: {} };
        }

        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(pi, providerName, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, cfg.streamCompatMode ?? "builtin");

        const updated = modelConfigs.find((m) => m.id === modelId);
        return {
          content: [{ type: "text", text: `✅ 已更新 ${providerName}/${modelId}: contextWindow=${updated?.contextWindow}, maxTokens=${updated?.maxTokens}` }],
          details: { provider: providerName, model: modelId, contextWindow: updated?.contextWindow, maxTokens: updated?.maxTokens },
        };
      }

      if (action !== "register") {
        return { content: [{ type: "text", text: `未知 action: ${action}。支持: register|remove|list|set_reasoning_models|set_model_limits` }], details: {} };
      }

      const baseUrl = params.baseUrl?.trim();
      const apiKey = params.apiKey?.trim();
      if (!baseUrl) return { content: [{ type: "text", text: "需要 baseUrl (API 基础地址)" }], details: {} };
      if (!apiKey) return { content: [{ type: "text", text: "需要 apiKey (API 密钥)" }], details: {} };

      let rawName = (params.provider || "custom").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      rawName = rawName.replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!rawName) rawName = "custom";

      const apiStyle = params.apiStyle || "auto";
      if (!["auto", "openai", "anthropic"].includes(apiStyle)) {
        return { content: [{ type: "text", text: `无效 apiStyle: ${apiStyle}。支持: auto, openai, anthropic` }], details: {} };
      }

      const testResult = await testProviderConnection(baseUrl, apiKey, apiStyle, params.testModel);
      if (!testResult.ok) {
        return { content: [{ type: "text", text: `❌ 连接测试失败: ${testResult.error}\n请检查 baseUrl 和 apiKey 是否正确，以及 API 风格是否匹配。` }], details: {} };
      }

      const detectedApi = testResult.detectedApi!;
      const providerName = `${rawName}-${detectedApi}`;
      const existingProviders = readCustomProviders();
      if (existingProviders[providerName]) {
        return { content: [{ type: "text", text: `供应商 "${providerName}" 已存在。如要更新请先执行 remove 移除。` }], details: {} };
      }
      if (ctx.modelRegistry.getAll().some((m: any) => m.provider === providerName)) {
        return { content: [{ type: "text", text: `供应商 "${providerName}" 已存在于模型注册表中。` }], details: {} };
      }

      const discoveredModels = await discoverModelsFromProvider(baseUrl, apiKey, detectedApi);
      const reasoningModelIds = Array.isArray(params.reasoningModels)
        ? new Set((params.reasoningModels as string[]).map((id) => id.trim()).filter(Boolean))
        : undefined;
      const persistedModels = reasoningModelIds
        ? discoveredModels.map((m) => ({ ...m, reasoning: reasoningModelIds.has(m.id) }))
        : discoveredModels;
      const supportsUsageInStreaming = typeof params.supportsUsageInStreaming === "boolean"
        ? params.supportsUsageInStreaming
        : undefined;
      const compat = detectedApi === "openai" && typeof supportsUsageInStreaming === "boolean"
        ? { supportsUsageInStreaming }
        : undefined;
      const modelConfigs = buildModelConfigs(
        persistedModels,
        params.contextWindow ? Number(params.contextWindow) : undefined,
        params.maxTokens ? Number(params.maxTokens) : undefined,
        compat,
      );
      const streamCompatModeRaw = params.streamCompatMode || "builtin";
      if (!["builtin", "finish-reason-fallback"].includes(streamCompatModeRaw)) {
        return { content: [{ type: "text", text: `无效 streamCompatMode: ${streamCompatModeRaw}。支持: builtin | finish-reason-fallback` }], details: {} };
      }
      const streamCompatMode = streamCompatModeRaw as "builtin" | "finish-reason-fallback";

      try {
        registerCustomProvider(pi, providerName, baseUrl, apiKey, detectedApi, modelConfigs, streamCompatMode);
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `❌ 注册失败: ${(e as Error).message}` }], details: {} };
      }

      const customProviders = readCustomProviders();
      customProviders[providerName] = {
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        apiStyle: detectedApi,
        models: persistedModels,
        createdAt: Date.now(),
        streamCompatMode,
        ...(typeof supportsUsageInStreaming === "boolean" ? { supportsUsageInStreaming } : {}),
      };
      writeCustomProviders(customProviders);

      const modelList = discoveredModels.slice(0, 10).map((m) => {
        const cfg = modelConfigs.find((c) => c.id === m.id);
        const cw = cfg?.contextWindow ?? 0;
        const ctxLabel = cw >= 1000000 ? `${(cw / 1000000).toFixed(0)}M` : `${(cw / 1000).toFixed(0)}k`;
        const reasoningLabel = cfg?.reasoning ? ", reasoning" : "";
        return `  - ${m.id} (上下文: ${ctxLabel}${reasoningLabel})`;
      }).join("\n");
      const more = discoveredModels.length > 10 ? `\n  ... 以及 ${discoveredModels.length - 10} 个其他模型` : "";

      const streamModeLabel = streamCompatMode === "finish-reason-fallback"
        ? `   流模式: finish-reason-fallback (含 pi-main 消息转换)`
        : `   流模式: builtin (OpenAI SDK)`;

      return {
        content: [{ type: "text", text: [
          `✅ 自定义供应商注册成功: ${providerName}`,
          `   检测到 API 风格: ${detectedApi}`,
          `   基础地址: ${normalizeBaseUrl(baseUrl)}`,
          streamModeLabel,
          detectedApi === "openai" && typeof supportsUsageInStreaming === "boolean"
            ? `   流式 usage: ${supportsUsageInStreaming ? "开启" : "关闭"}`
            : "",
          `   发现 ${discoveredModels.length} 个模型: ${discoveredModels.length > 0 ? "" : "(可在 models.json 中手动添加)"}`,
          discoveredModels.length > 0 ? modelList + more : "",
          "",
          `使用方式:`,
          `  • 切换模型: switch_model provider=${providerName} model=<模型ID>`,
          `  • 添加到层级: /tier-add <L0|L1|L2> ${providerName} <模型ID>`,
          `  • 设置默认: /set-default ${providerName} <模型ID>`,
          `  • 查看供应商: manage_providers action=list`,
          `  • 移除供应商: manage_providers action=remove provider=${providerName}`,
        ].join("\n") }],
        details: {
          provider: providerName,
          api: detectedApi,
          streamCompatMode,
          supportsUsageInStreaming,
          reasoningModels: modelConfigs.filter((m) => m.reasoning).map((m) => m.id),
          baseUrl: normalizeBaseUrl(baseUrl),
          modelsCount: discoveredModels.length,
          models: discoveredModels.map((m) => m.id),
        },
      };
    },
  });
}
