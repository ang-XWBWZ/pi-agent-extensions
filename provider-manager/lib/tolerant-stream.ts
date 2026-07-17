/**
 * tolerant-stream.ts — 直连 fetch-based tolerant stream handler
 *
 * 不依赖 pi-main 内置 provider 的流处理，直接发送 HTTP 请求到上游，
 * 手动解析 SSE chunks。完全避开 pi-main 对 provider/baseUrl 的自动检测。
 *
 * 关键兼容处理：
 * 1. reasoning_content 当作 thinking block 处理
 * 2. 缺少 finish_reason 但已有输出时补 "stop"
 * 3. content 始终 null 的上游（DeepSeek 思考模式）能正常出字
 * 4. real HTTP 400 / timeout 原样报错
 */

import {
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
import { clampOpenAIPromptCacheKey } from "./config.js";
import {
  parseOpenAIUsage,
  ensureToolCallId,
  parseToolArguments,
  finalizeToolCallBlock,
  convertMessagesForUpstream,
} from "./message-utils.js";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

function resolveStreamIdleTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
  // Pi maps disabled httpIdleTimeoutMs=0 to max int32 before it reaches providers.
  // For this tolerant fetch stream we still need a finite idle guard, otherwise a
  // half-open SSE connection can leave the agent stuck in Work forever.
  if (value >= 2_000_000_000) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return Math.floor(value);
}

export function createOpenAITolerantStream() {
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
      let abortReason: "user" | "idle" | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS;

      try {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }

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

        const reasoning = options?.reasoning;
        if (reasoning && reasoning !== "off" && model.reasoning) {
          reqBody.reasoning_effort = reasoning;
        }

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
        idleTimeoutMs = resolveStreamIdleTimeoutMs(options?.timeoutMs);
        const abortWith = (reason: "user" | "idle") => {
          abortReason = abortReason ?? reason;
          controller.abort();
        };
        const refreshIdleTimer = () => {
          if (timeoutId) clearTimeout(timeoutId);
          timeoutId = setTimeout(() => abortWith("idle"), idleTimeoutMs);
        };
        if (options?.signal) {
          if (options.signal.aborted) throw new Error("Request was aborted");
          options.signal.addEventListener("abort", () => abortWith("user"), { once: true });
        }
        refreshIdleTimer();

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
        refreshIdleTimer();

        if (!response.ok) {
          const errText = await response.text().catch(() => "Unknown error");
          throw new Error(`API request failed: ${response.status} - ${errText.slice(0, 500)}`);
        }
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let hasFinishReason = false;
        let sawDoneMarker = false;
        let finishReason: string | null = null;
        let textBlock: any = null;
        let thinkingBlock: any = null;
        let pendingTextPrefix = "";
        let seenMeaningfulText = false;
        const toolCallBlocks: any[] = [];
        const toolCallBlocksById = new Map<string, any>();
        const toolCallBlocksByIndex = new Map<number, any>();
        const toolCallBlocksBySignature = new Map<string, any>();

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
        const toolCallSignature = (tc: any, index: number): string => {
          const name = String(tc?.function?.name || tc?.name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
          return `${name || "tool"}:${index}`;
        };
        const upsertToolCallBlock = (tc: any, index: number, streaming: boolean): any => {
          let block = tc.id ? toolCallBlocksById.get(tc.id) : undefined;
          if (!block && tc.index !== undefined) block = toolCallBlocksByIndex.get(tc.index);
          const signature = toolCallSignature(tc, tc.index ?? index);
          if (!block) block = toolCallBlocksBySignature.get(signature);
          if (!block) {
            block = {
              type: "toolCall",
              id: tc.id || ensureToolCallId(tc, tc.index ?? index),
              name: tc.function?.name || tc.name || "",
              arguments: {},
              ...(streaming ? { partialArgs: "" } : {}),
            };
            toolCallBlocks.push(block);
            output.content.push(block);
            outer.push({ type: "toolcall_start", contentIndex: getIdx(block), partial: output });
          }
          if (tc.id) {
            block.id = tc.id;
            toolCallBlocksById.set(tc.id, block);
          }
          if (tc.index !== undefined) toolCallBlocksByIndex.set(tc.index, block);
          toolCallBlocksBySignature.set(signature, block);
          if (!block.name && tc.function?.name) block.name = tc.function.name;
          return block;
        };
        const emitTextDelta = (deltaText: string) => {
          if (deltaText.length === 0) return;

          if (!seenMeaningfulText && deltaText.trim().length === 0) {
            pendingTextPrefix += deltaText;
            return;
          }

          const text = !seenMeaningfulText ? pendingTextPrefix + deltaText : deltaText;
          pendingTextPrefix = "";

          if (text.trim().length > 0) {
            seenMeaningfulText = true;
          }

          const block = ensureTextBlock();
          block.text += text;
          outer.push({ type: "text_delta", contentIndex: getIdx(block), delta: text, partial: output });
        };
        const emitNonStreamingFallback = async (): Promise<string | null> => {
          const fallbackBody = { ...reqBody, stream: false };
          delete fallbackBody.stream_options;
          const fallbackHeaders = { ...reqHeaders, Accept: "application/json" };
          refreshIdleTimer();
          const fallbackResponse = await fetch(url, {
            method: "POST",
            headers: fallbackHeaders,
            body: JSON.stringify(fallbackBody),
            signal: controller.signal,
          });
          refreshIdleTimer();
          if (!fallbackResponse.ok) {
            const errText = await fallbackResponse.text().catch(() => "Unknown error");
            throw new Error(`API request failed: ${fallbackResponse.status} - ${errText.slice(0, 500)}`);
          }

          const data: any = await fallbackResponse.json();
          refreshIdleTimer();
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
            emitTextDelta(message.content);
          }

          if (Array.isArray(message.tool_calls)) {
            for (const [idx, tc] of message.tool_calls.entries()) {
              const block = upsertToolCallBlock(tc, idx, false);
              delete (block as any).partialArgs;
              block.arguments = parseToolArguments(tc.function?.arguments);
            }
          }

          const fallbackToolCalls = toolCallBlocks.filter(finalizeToolCallBlock);
          const hasMeaningfulFallbackText = !!textBlock?.text?.trim();
          const hasMeaningfulFallbackThinking = !!thinkingBlock?.thinking?.trim();

          return choice?.finish_reason
            ?? (fallbackToolCalls.length > 0
              ? "tool_calls"
              : hasMeaningfulFallbackText || hasMeaningfulFallbackThinking
                ? "stop"
                : null);
        };

        const processSseFrame = (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return;

          const dataLines = trimmed
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) return;
          const payload = dataLines.join("\n");
          if (payload === "[DONE]") {
            sawDoneMarker = true;
            return;
          }

          let data: any;
          try { data = JSON.parse(payload); } catch { return; }

          if (data.usage) {
            output.usage = parseOpenAIUsage(data.usage, model);
          }

          if (!data.choices?.length) return;
          const choice = data.choices[0];
          if (!choice) return;

          if (choice.finish_reason) {
            hasFinishReason = true;
            finishReason = choice.finish_reason;
          }

          if (!choice.delta) return;
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
            emitTextDelta(content);
          }

          // tool_calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const block = upsertToolCallBlock(tc, tc.index ?? toolCallBlocks.length, true);
              if (tc.function?.arguments) {
                block.partialArgs = (block.partialArgs ?? "") + tc.function.arguments;
                try { block.arguments = JSON.parse(block.partialArgs); } catch { /* partial */ }
                outer.push({ type: "toolcall_delta", contentIndex: getIdx(block), delta: tc.function.arguments, partial: output });
              }
            }
          }
        };

        outer.push({ type: "start", partial: output });

        while (true) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          const { done, value } = await reader.read();
          if (done) break;
          refreshIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || "";

          for (const raw of events) {
            processSseFrame(raw);
          }
        }

        const tail = decoder.decode();
        if (tail) buffer += tail;
        if (buffer.trim()) {
          processSseFrame(buffer);
          buffer = "";
        }

        // 收尾
        if (timeoutId) clearTimeout(timeoutId);

        const inspectStreamState = () => {
          const completeToolCalls = toolCallBlocks.filter(finalizeToolCallBlock);
          const hasMeaningfulText = !!textBlock?.text?.trim();
          const hasMeaningfulThinking = !!thinkingBlock?.thinking?.trim();
          return {
            completeToolCalls,
            hasMeaningfulText,
            hasMeaningfulThinking,
            hasTextOrThinking: hasMeaningfulText || hasMeaningfulThinking,
            hasIncompleteToolCalls: completeToolCalls.length !== toolCallBlocks.length,
            onlyThinkingNoAnswer: hasMeaningfulThinking && !hasMeaningfulText && completeToolCalls.length === 0,
          };
        };

        let streamState = inspectStreamState();
        if (streamState.hasIncompleteToolCalls || !streamState.hasTextOrThinking || streamState.onlyThinkingNoAnswer) {
          const fallbackFinishReason = await emitNonStreamingFallback();
          if (fallbackFinishReason) {
            finishReason = fallbackFinishReason;
            hasFinishReason = true;
          }
          streamState = inspectStreamState();
        }

        if (!hasFinishReason) {
          if (streamState.completeToolCalls.length > 0 && !streamState.hasIncompleteToolCalls) {
            finishReason = "tool_calls";
          } else if (streamState.hasTextOrThinking) {
            // Some OpenAI-compatible providers omit finish_reason or [DONE]. If we
            // already have a complete text/thinking block, finish the turn instead
            // of surfacing pi-main's hard "Stream ended without finish_reason".
            finishReason = "stop";
          } else {
            throw new Error("OpenAI-compatible stream ended without finish_reason or meaningful content");
          }
        }

        if (streamState.hasIncompleteToolCalls) {
          throw new Error("OpenAI-compatible stream ended with incomplete tool_calls");
        }

        if (!streamState.hasTextOrThinking && streamState.completeToolCalls.length === 0) {
          throw new Error("OpenAI-compatible stream ended without meaningful content");
        }

        if (streamState.onlyThinkingNoAnswer) {
          throw new Error("OpenAI-compatible stream ended after reasoning without final answer content");
        }

        if (!sawDoneMarker && !hasFinishReason && !streamState.hasTextOrThinking) {
          throw new Error("OpenAI-compatible stream ended before [DONE]");
        }

        if (timeoutId) clearTimeout(timeoutId);

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
        if (timeoutId) clearTimeout(timeoutId);
        const rawMsg = err?.message || String(err);
        const idleTimedOut = abortReason === "idle";
        const userAborted = abortReason === "user" || rawMsg === "Request was aborted";
        const providerAborted = err?.name === "AbortError" && !userAborted;
        const msg = idleTimedOut
          ? `OpenAI-compatible stream idle timeout after ${idleTimeoutMs}ms`
          : providerAborted
            ? `OpenAI-compatible stream aborted or timed out: ${rawMsg}`
            : rawMsg;
        outer.push({
          type: "error",
          reason: userAborted && !idleTimedOut ? "aborted" : "error",
          error: {
            ...output,
            stopReason: userAborted && !idleTimedOut ? "aborted" : "error",
            errorMessage: msg,
          },
        });
        outer.end();
      }
    })();

    return outer;
  };
}
