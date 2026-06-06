/**
 * anthropic-stream.ts — Anthropic Messages API 直连 SSE 流处理器
 *
 * 不依赖 pi-main 内置 provider，直接发送 HTTP 请求到上游 Anthropic-compatible API，
 * 手动解析 SSE 事件。正确处理 Anthropic 事件模型。
 *
 * Anthropic SSE 事件类型：
 *   message_start        → 整个响应的元数据
 *   content_block_start  → thinking / text / tool_use block 开始
 *   content_block_delta  → 增量 delta
 *   content_block_stop   → block 结束
 *   message_delta        → stop_reason + usage
 *   message_stop         → 最终结束
 *
 * 思考等级 → budget_tokens 映射：
 *   off → 不发送 thinking
 *   minimal → 1024
 *   low → 2048
 *   medium → 4096
 *   high → 8192
 *   xhigh → 16000
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Context,
} from "@earendil-works/pi-ai";

// ---- 思考等级 → budget_tokens ----

const THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16000,
};

// ---- 工具参数解析 ----

function parseToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try { const p = JSON.parse(value); return p && typeof p === "object" ? p : {}; } catch { return {}; }
  }
  return {};
}

// ---- 消息转换: pi Message[] → Anthropic Messages -----

function convertToAnthropicMessages(messages: any[]): any[] {
  // Anthropic 只需要 user/assistant 角色，工具结果合并到 user message
  // 不做完整复刻，只处理核心格式
  const result: any[] = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
        if (text) result.push({ role: "user", content: text });
      }
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
      const textParts = (msg.content || []).filter((b: any) => b?.type === "text" && b.text?.trim());
      const toolUses = (msg.content || []).filter((b: any) => b?.type === "toolCall");
      if (toolUses.length > 0) {
        result.push({
          role: "assistant",
          content: toolUses.map((tc: any) => ({
            type: "tool_use",
            id: tc.id || `toolu_${Date.now()}`,
            name: tc.name || "",
            input: tc.arguments || {},
          })),
        });
      } else if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.map((b: any) => ({ type: "text", text: b.text })) });
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolCallId = msg.toolCallId || msg.tool_call_id;
      let content = "";
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) {
        content = msg.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
      }
      result.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolCallId,
          content: content || "(no result)",
          ...(msg.isError ? { is_error: true } : {}),
        }],
      });
      continue;
    }
  }
  if (result.length === 0) {
    return [{ role: "user", content: "Hello" }];
  }
  return result;
}

// ---- 主流处理器 ----

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

      try {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }

        const messages = convertToAnthropicMessages(context.messages);

        const reqBody: any = {
          model: model.id,
          messages,
          max_tokens: options?.maxTokens || model.maxTokens || 4096,
          stream: true,
        };

        // 思考等级 → budget_tokens
        const reasoning = options?.reasoning;
        if (reasoning && reasoning !== "off" && model.reasoning) {
          const budget = THINKING_BUDGET[reasoning] ?? 4096;
          reqBody.thinking = { type: "enabled", budget_tokens: budget };
        }

        // 温度
        if (options?.temperature !== undefined) {
          reqBody.temperature = options.temperature;
        }

        // 工具
        if (context.tools && context.tools.length > 0) {
          reqBody.tools = context.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
        }

        const baseUrl = model.baseUrl.replace(/\/+$/, "");
        let url = baseUrl;
        if (!url.endsWith("/v1/messages")) {
          if (!url.endsWith("/v1")) url += "/v1";
          url += "/messages";
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
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Accept: "text/event-stream",
          ...(options?.headers || {}),
        };

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

        // 追踪当前活跃的 blocks
        const blocksById = new Map<string, any>();  // content_block index → block
        const blockIndices: any[] = [];              // 按追加顺序的 block 引用
        let stopReason: string | null = null;

        const getIdx = (b: any) => output.content.indexOf(b);

        outer.push({ type: "start", partial: output });

        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          if (options?.signal?.aborted) throw new Error("Request was aborted");
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const raw of events) {
            const trimmed = raw.trim();
            if (!trimmed) continue;

            // Anthropic SSE 格式: event: xxx\n data: {...}
            // 提取 data: 行的 JSON 负载
            const dataLine = trimmed.split('\n').find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(6);
            if (jsonStr === "[DONE]") continue;

            let data: any;
            try { data = JSON.parse(jsonStr); } catch { continue; }
            if (!data || typeof data !== "object") continue;

            const eventType = data.type;

            // ---- message_start ----
            if (eventType === "message_start") {
              if (data.message?.usage) {
                inputTokens = data.message.usage.input_tokens || 0;
              }
              continue;
            }

            // ---- content_block_start ----
            if (eventType === "content_block_start") {
              const block = data.content_block;
              if (!block) continue;
              const index = data.index ?? blockIndices.length;

              if (block.type === "text") {
                const b = { type: "text", text: "" };
                output.content.push(b);
                blocksById.set(String(index), b);
                blockIndices[index] = b;
                outer.push({ type: "text_start", contentIndex: getIdx(b), partial: output });
              } else if (block.type === "thinking") {
                const b = { type: "thinking", thinking: "", thinkingSignature: block.thinking || "" };
                output.content.push(b);
                blocksById.set(String(index), b);
                blockIndices[index] = b;
                outer.push({ type: "thinking_start", contentIndex: getIdx(b), partial: output });
              } else if (block.type === "tool_use") {
                const b = {
                  type: "toolCall",
                  id: block.id || `toolu_${Date.now()}`,
                  name: block.name || "",
                  arguments: {},
                  partialArgs: "",
                };
                output.content.push(b);
                blocksById.set(String(index), b);
                blockIndices[index] = b;
                outer.push({ type: "toolcall_start", contentIndex: getIdx(b), partial: output });
              }
              continue;
            }

            // ---- content_block_delta ----
            if (eventType === "content_block_delta") {
              const delta = data.delta;
              const index = data.index;
              if (!delta || index === undefined) continue;
              const block = blocksById.get(String(index));
              if (!block) continue;

              if (delta.type === "text_delta") {
                block.text += delta.text || "";
                outer.push({ type: "text_delta", contentIndex: getIdx(block), delta: delta.text || "", partial: output });
              } else if (delta.type === "thinking_delta") {
                block.thinking += delta.thinking || "";
                outer.push({ type: "thinking_delta", contentIndex: getIdx(block), delta: delta.thinking || "", partial: output });
              } else if (delta.type === "input_json_delta") {
                block.partialArgs = (block.partialArgs || "") + (delta.partial_json || "");
                try { block.arguments = JSON.parse(block.partialArgs); } catch { /* partial */ }
                outer.push({ type: "toolcall_delta", contentIndex: getIdx(block), delta: delta.partial_json || "", partial: output });
              }
              continue;
            }

            // ---- content_block_stop ----
            if (eventType === "content_block_stop") {
              const index = data.index;
              if (index === undefined) continue;
              const block = blocksById.get(String(index));
              if (!block) continue;

              if (block.type === "text") {
                outer.push({ type: "text_end", contentIndex: getIdx(block), content: block.text, partial: output });
              } else if (block.type === "thinking") {
                outer.push({ type: "thinking_end", contentIndex: getIdx(block), content: block.thinking, partial: output });
              } else if (block.type === "toolCall") {
                delete (block as any).partialArgs;
                outer.push({ type: "toolcall_end", contentIndex: getIdx(block), toolCall: block, partial: output });
              }
              continue;
            }

            // ---- message_delta ----
            if (eventType === "message_delta") {
              if (data.delta?.stop_reason) {
                stopReason = data.delta.stop_reason;
              }
              if (data.usage) {
                outputTokens = data.usage.output_tokens || 0;
              }
              continue;
            }
          }
        }

        clearTimeout(timeoutId);

        // 计算 usage
        output.usage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        // 映射 stop_reason
        let mapped: string = "stop";
        if (!stopReason) {
          stopReason = output.content.length > 0 ? "end_turn" : "stop";
        }
        if (stopReason === "max_tokens") mapped = "length";
        else if (stopReason === "tool_use") mapped = "toolUse";
        else if (stopReason === "end_turn" || stopReason === "stop_sequence") mapped = "stop";

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
