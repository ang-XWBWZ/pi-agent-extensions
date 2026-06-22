/**
 * anthropic-stream.ts — Anthropic Messages API 直连 SSE 流处理器
 *
 * 不依赖 pi-main 内置 provider，直接发送 HTTP 请求到上游 Anthropic-compatible API，
 * 手动解析 SSE 事件。只走新版 adaptive thinking 协议：
 *   { thinking: { type: "adaptive" }, output_config: { effort: "low"|"medium"|"high"|"xhigh"|"max" } }
 *
 * Pi 思考等级 → Claude effort 映射：
 *   minimal → "low"
 *   low     → "low"
 *   medium  → "medium"
 *   high    → "high"
 *   xhigh   → "max"
 *   off     → thinking: { type: "disabled" }
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

// ---- 思考等级 → effort ----

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const PI_TO_EFFORT: Record<string, ClaudeEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

// ---- sanitization：移除与 extended thinking 冲突的参数 ----

function sanitizeAnthropicThinkingParams(reqBody: Record<string, unknown>) {
  if (!reqBody.thinking || (reqBody.thinking as any)?.type === "disabled") return;

  delete reqBody.temperature;
  delete (reqBody as any).top_k;

  if (typeof reqBody.top_p === "number") {
    reqBody.top_p = Math.min(1, Math.max(0.95, reqBody.top_p as number));
  }

  const tc = reqBody.tool_choice as any;
  if (tc?.type === "any" || tc?.type === "tool") {
    delete reqBody.tool_choice;
  }
}

// ---- 注入 thinking 载荷 ----

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

// ---- 消息转换: pi Message[] → Anthropic Messages ----

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

      // 保留思考块：将 thinking 块序列化为 <thinking> 注释前缀
      // 这样后续 API 调用时模型仍能看到自己的推理链
      for (const tp of thinkingParts) {
        content.push({ type: "text", text: `<thinking>\n${tp.thinking}\n</thinking>` });
      }

      // 正常文本
      for (const tp of textParts) {
        content.push({ type: "text", text: tp.text });
      }

      // 工具调用
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
      let content = "";
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) {
        content = msg.content
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
            content: content || "(no result)",
            ...(msg.isError ? { is_error: true } : {}),
          },
        ],
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
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
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

        const reqBody: Record<string, unknown> = {
          model: model.id,
          messages,
          max_tokens: options?.maxTokens || (model as any).maxTokens || 4096,
          stream: true,
        };

        // 思考等级 → adaptive effort
        const reasoning = options?.reasoning;
        if (reasoning && reasoning !== "off" && (model as any).reasoning) {
          applyAnthropicThinking(reqBody, model, reasoning);
        } else if ((model as any).reasoning && (!reasoning || reasoning === "off")) {
          reqBody.thinking = { type: "disabled" };
        }

        // 温度（仅在不启用 thinking 时发送；sanitize 会移除冲突字段）
        if (options?.temperature !== undefined && !reqBody.thinking) {
          reqBody.temperature = options.temperature;
        }

        // 工具
        if (context.tools && context.tools.length > 0) {
          (reqBody as any).tools = context.tools.map((t: any) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          }));
        }

        const baseUrl = (model as any).baseUrl.replace(/\/+$/, "");
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
        const timeoutMs = (options as any)?.timeoutMs || 120000;
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

        const blocksById = new Map<string, any>();
        const blockIndices: any[] = [];
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

            const dataLine = trimmed.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(6);
            if (jsonStr === "[DONE]") continue;

            let data: any;
            try {
              data = JSON.parse(jsonStr);
            } catch {
              continue;
            }
            if (!data || typeof data !== "object") continue;

            const eventType = data.type;

            if (eventType === "message_start") {
              if (data.message?.usage) {
                inputTokens = data.message.usage.input_tokens || 0;
              }
              continue;
            }

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
                outer.push({
                  type: "thinking_start",
                  contentIndex: getIdx(b),
                  partial: output,
                });
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
                outer.push({
                  type: "toolcall_start",
                  contentIndex: getIdx(b),
                  partial: output,
                });
              }
              continue;
            }

            if (eventType === "content_block_delta") {
              const delta = data.delta;
              const index = data.index;
              if (!delta || index === undefined) continue;
              const block = blocksById.get(String(index));
              if (!block) continue;

              if (delta.type === "text_delta") {
                block.text += delta.text || "";
                outer.push({
                  type: "text_delta",
                  contentIndex: getIdx(block),
                  delta: delta.text || "",
                  partial: output,
                });
              } else if (delta.type === "thinking_delta") {
                block.thinking += delta.thinking || "";
                outer.push({
                  type: "thinking_delta",
                  contentIndex: getIdx(block),
                  delta: delta.thinking || "",
                  partial: output,
                });
              } else if (delta.type === "input_json_delta") {
                block.partialArgs = (block.partialArgs || "") + (delta.partial_json || "");
                try {
                  block.arguments = JSON.parse(block.partialArgs);
                } catch {
                  /* partial */
                }
                outer.push({
                  type: "toolcall_delta",
                  contentIndex: getIdx(block),
                  delta: delta.partial_json || "",
                  partial: output,
                });
              }
              continue;
            }

            if (eventType === "content_block_stop") {
              const index = data.index;
              if (index === undefined) continue;
              const block = blocksById.get(String(index));
              if (!block) continue;

              if (block.type === "text") {
                outer.push({
                  type: "text_end",
                  contentIndex: getIdx(block),
                  content: block.text,
                  partial: output,
                });
              } else if (block.type === "thinking") {
                outer.push({
                  type: "thinking_end",
                  contentIndex: getIdx(block),
                  content: block.thinking,
                  partial: output,
                });
              } else if (block.type === "toolCall") {
                delete (block as any).partialArgs;
                outer.push({
                  type: "toolcall_end",
                  contentIndex: getIdx(block),
                  toolCall: block,
                  partial: output,
                });
              }
              continue;
            }

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

        output.usage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

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
