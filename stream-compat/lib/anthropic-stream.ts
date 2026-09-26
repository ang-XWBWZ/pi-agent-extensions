/**
 * stream-compat/lib/anthropic-stream.ts — Anthropic 专属自适应思考流
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Context,
} from "@earendil-works/pi-ai";
import { applyCustomProviderContextUsage } from "../../provider-manager/lib/message-utils.js";
import { resolveRequestMaxTokens } from "../../provider-manager/lib/request-limits.js";
import {
  awaitWithAbort,
  cancelReader,
  createRequestAbortError,
} from "../../provider-manager/lib/abortable-request.js";

const PI_TO_EFFORT: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

function resolveStreamIdleTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
  if (value >= 2_000_000_000) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return Math.floor(value);
}

function sanitizeAnthropicThinkingParams(reqBody: Record<string, unknown>) {
  if (reqBody.thinking && (reqBody.thinking as any).type !== "disabled") {
    delete reqBody.temperature;
    delete reqBody.top_p;
    delete reqBody.top_k;
  }
}

function applyAnthropicThinking(
  reqBody: Record<string, unknown>,
  model: Model<Api>,
  reasoning: string | undefined,
) {
  if (!reasoning || reasoning === "off" || !model.reasoning) return;
  const effort = PI_TO_EFFORT[reasoning] ?? "medium";
  reqBody.thinking = { type: "adaptive" };
  reqBody.output_config = { effort };
  sanitizeAnthropicThinkingParams(reqBody);
}

function convertToAnthropicMessages(messages: any[]): any[] {
  const result: any[] = [];
  for (const msg of messages || []) {
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
      const textParts = (msg.content || []).filter((b: any) => b?.type === "text" && b.text?.trim());
      const thinkingParts = (msg.content || []).filter((b: any) => b?.type === "thinking" && b.thinking?.trim());
      const toolUses = (msg.content || []).filter((b: any) => b?.type === "toolCall");

      const content: any[] = [];
      for (const tp of thinkingParts) {
        content.push({ type: "text", text: `<thinking>\n${tp.thinking}\n</thinking>` });
      }
      for (const tp of textParts) {
        content.push({ type: "text", text: tp.text });
      }
      for (const tc of toolUses) {
        content.push({
          type: "tool_use",
          id: tc.id || `toolu_${Date.now()}`,
          name: tc.name || "",
          input: tc.arguments || {},
        });
      }
      if (content.length > 0) {
        result.push({ role: "assistant", content });
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolCallId = msg.toolCallId || msg.tool_call_id;
      if (!toolCallId) continue;
      let text = "";
      if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: text || "(no result)",
            is_error: !!msg.isError,
          },
        ],
      });
      continue;
    }
  }
  return result;
}

export function createAnthropicStream() {
  return function anthropicStreamSimple(
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
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let removeAbortListener: (() => void) | undefined;
      try {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }

        const messages = convertToAnthropicMessages(context.messages);
        const resolvedSystemPrompt = (context as any).systemPrompt?.trim()
          || (typeof getCurrentSystemPrompt === "function" ? getCurrentSystemPrompt(context.messages ?? []) : "");
        const reqBody: Record<string, unknown> = {
          model: model.id,
          messages,
          stream: true,
          ...(resolvedSystemPrompt ? { system: resolvedSystemPrompt } : {}),
        };

        const reasoning = options?.reasoning;
        if (reasoning && reasoning !== "off" && (model as any).reasoning) {
          applyAnthropicThinking(reqBody, model, reasoning);
        } else if ((model as any).reasoning && (!reasoning || reasoning === "off")) {
          reqBody.thinking = { type: "disabled" };
        }

        if (options?.temperature !== undefined && !reqBody.thinking) {
          reqBody.temperature = options.temperature;
        }

        const resolvedTools = (context as any).tools
          ?? (typeof getCurrentTools === "function" ? getCurrentTools(context.messages ?? []) : []);
        if (resolvedTools && resolvedTools.length > 0) {
          (reqBody as any).tools = resolvedTools.map((t: any) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
        }

        reqBody.max_tokens = resolveRequestMaxTokens(model, options?.maxTokens);

        const baseUrl = (model as any).baseUrl.replace(/\/+$/, "");
        let url = baseUrl;
        if (!url.endsWith("/v1/messages")) {
          if (!url.endsWith("/v1")) url += "/v1";
          url += "/messages";
        }

        const controller = new AbortController();
        idleTimeoutMs = resolveStreamIdleTimeoutMs(options?.timeoutMs);
        const abortWith = (reason: "user" | "idle") => {
          abortReason = abortReason ?? reason;
          controller.abort();
          cancelReader(reader);
        };
        const refreshIdleTimer = () => {
          if (timeoutId) clearTimeout(timeoutId);
          timeoutId = setTimeout(() => abortWith("idle"), idleTimeoutMs);
        };
        if (options?.signal) {
          if (options.signal.aborted) throw new Error("Request was aborted");
          const onUserAbort = () => abortWith("user");
          options.signal.addEventListener("abort", onUserAbort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener("abort", onUserAbort);
        }
        refreshIdleTimer();

        const reqHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Accept: "text/event-stream",
          ...(options?.headers || {}),
        };

        const response = await awaitWithAbort(
          () => fetch(url, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          }),
          controller.signal,
        );
        refreshIdleTimer();

        if (!response.ok) {
          const errText = await awaitWithAbort(
            () => response.text().catch(() => "Unknown error"),
            controller.signal,
          );
          throw new Error(`API request failed: ${response.status} - ${errText.slice(0, 500)}`);
        }
        if (!response.body) throw new Error("No response body");

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let textBlock: any = null;
        let thinkingBlock: any = null;
        let activeToolUse: any = null;
        let stopReason: string = "stop";

        const getIdx = (b: any) => output.content.indexOf(b);
        const ensureTextBlock = () => {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            output.content.push(textBlock);
            outer.push({ type: "text_start", contentIndex: getIdx(textBlock), partial: output });
          }
          return textBlock;
        };
        const ensureThinkingBlock = () => {
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: "thinking" };
            output.content.push(thinkingBlock);
            outer.push({ type: "thinking_start", contentIndex: getIdx(thinkingBlock), partial: output });
          }
          return thinkingBlock;
        };

        const processSseBlock = (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return;
          const lines = trimmed.split("\n");
          let eventType = "";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
          }
          if (!dataStr) return;
          let data: any;
          try { data = JSON.parse(dataStr); } catch { return; }

          switch (eventType) {
            case "message_start":
              if (data.message?.usage) {
                output.usage.input = data.message.usage.input_tokens || 0;
                output.usage.cacheRead = data.message.usage.cache_read_input_tokens || 0;
                output.usage.cacheWrite = data.message.usage.cache_creation_input_tokens || 0;
              }
              break;
            case "content_block_start":
              if (data.content_block?.type === "thinking") {
                ensureThinkingBlock();
              } else if (data.content_block?.type === "text") {
                ensureTextBlock();
              } else if (data.content_block?.type === "tool_use") {
                activeToolUse = {
                  type: "toolCall",
                  id: data.content_block.id,
                  name: data.content_block.name,
                  arguments: {},
                  _partialJson: "",
                };
                output.content.push(activeToolUse);
                outer.push({ type: "toolcall_start", contentIndex: getIdx(activeToolUse), partial: output });
              }
              break;
            case "content_block_delta":
              if (data.delta?.type === "thinking_delta" && data.delta.thinking) {
                const tb = ensureThinkingBlock();
                tb.thinking += data.delta.thinking;
                outer.push({ type: "thinking_delta", contentIndex: getIdx(tb), delta: data.delta.thinking, partial: output });
              } else if (data.delta?.type === "text_delta" && data.delta.text) {
                const tb = ensureTextBlock();
                tb.text += data.delta.text;
                outer.push({ type: "text_delta", contentIndex: getIdx(tb), delta: data.delta.text, partial: output });
              } else if (data.delta?.type === "input_json_delta" && data.delta.partial_json) {
                if (activeToolUse) {
                  activeToolUse._partialJson += data.delta.partial_json;
                  outer.push({ type: "toolcall_delta", contentIndex: getIdx(activeToolUse), delta: data.delta.partial_json, partial: output });
                }
              }
              break;
            case "content_block_stop":
              if (activeToolUse) {
                try { activeToolUse.arguments = JSON.parse(activeToolUse._partialJson || "{}"); } catch { activeToolUse.arguments = {}; }
                delete activeToolUse._partialJson;
                outer.push({ type: "toolcall_end", contentIndex: getIdx(activeToolUse), toolCall: activeToolUse, partial: output });
                activeToolUse = null;
              }
              break;
            case "message_delta":
              if (data.delta?.stop_reason) {
                const sr = data.delta.stop_reason;
                if (sr === "tool_use") stopReason = "toolUse";
                else if (sr === "max_tokens") stopReason = "length";
                else stopReason = "stop";
              }
              if (data.usage?.output_tokens) {
                output.usage.output = data.usage.output_tokens;
              }
              break;
          }
        };

        outer.push({ type: "start", partial: output });

        while (true) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          const { done, value } = await awaitWithAbort(
            () => reader!.read(),
            controller.signal,
          );
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || "";
          let processedSseFrame = false;
          for (const raw of events) {
            processSseBlock(raw);
            processedSseFrame = true;
          }
          if (processedSseFrame) refreshIdleTimer();
        }

        if (controller.signal.aborted) throw createRequestAbortError();

        const tail = decoder.decode();
        if (tail) buffer += tail;
        if (buffer.trim()) processSseBlock(buffer);

        if (timeoutId) clearTimeout(timeoutId);

        if (thinkingBlock) {
          outer.push({ type: "thinking_end", contentIndex: getIdx(thinkingBlock), content: thinkingBlock.thinking, partial: output });
        }
        if (textBlock) {
          outer.push({ type: "text_end", contentIndex: getIdx(textBlock), content: textBlock.text, partial: output });
        }

        output.usage.totalTokens = output.usage.input + output.usage.output;
        calculateCost(model, output.usage);

        output.usage = applyCustomProviderContextUsage(
          output.usage,
          { messages: reqBody.messages, tools: (reqBody as any).tools },
          output.content,
        );

        output.stopReason = stopReason as any;
        outer.push({ type: "done", reason: stopReason, message: output });
      } catch (err: any) {
        if (timeoutId) clearTimeout(timeoutId);
        cancelReader(reader);
        const mappedError = abortReason === "idle"
          ? new Error(`Provider stream idle timeout after ${idleTimeoutMs}ms`)
          : err;
        output.stopReason = abortReason ? "aborted" : "error";
        output.errorMessage = mappedError?.message || String(mappedError);
        outer.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        removeAbortListener?.();
        outer.end();
      }
    })();

    return outer;
  };
}
