/**
 * discovery.ts - provider connection tests and model discovery
 */

import type { DiscoveredModel, TestResult } from "./config.js";
import { normalizeBaseUrl } from "./config.js";

async function pickModel(
  clean: string,
  apiKey: string,
  authStyle: "bearer" | "anthropic",
): Promise<string | undefined> {
  const headers: Record<string, string> = authStyle === "bearer"
    ? { Authorization: `Bearer ${apiKey}` }
    : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  try {
    const resp = await fetch(`${clean}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    return data.data?.find((m) => m.id && !m.id.startsWith("ft:"))?.id;
  } catch {
    return undefined;
  }
}

type ChatStreamResult =
  | { kind: "hasFinishReason" }
  | { kind: "noFinishReason" }
  | { kind: "endpointError"; status: number };

type ResponsesStreamResult =
  | { kind: "supported" }
  | { kind: "endpointError"; status: number };

type ResponsesToolStreamResult =
  | { kind: "supported" }
  | { kind: "incompatible"; reason: string }
  | { kind: "endpointError"; status: number };

async function testOpenAIResponsesStream(clean: string, apiKey: string, model: string): Promise<ResponsesStreamResult> {
  try {
    const resp = await fetch(`${clean}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: "hi",
        max_output_tokens: 8,
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { kind: "endpointError", status: resp.status };
    if (!resp.body) return { kind: "endpointError", status: 0 };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (
          buf.includes("response.output_text.delta")
          || buf.includes("response.completed")
          || buf.includes("response.done")
          || buf.includes("response.incomplete")
        ) {
          return { kind: "supported" };
        }
        if (buf.length > 16_000) break;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { kind: "endpointError", status: 0 };
  } catch {
    return { kind: "endpointError", status: 0 };
  }
}

async function testOpenAIResponsesToolStream(
  clean: string,
  apiKey: string,
  model: string,
): Promise<ResponsesToolStreamResult> {
  try {
    const resp = await fetch(`${clean}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: "Call the probe_tool now.",
        tools: [{
          type: "function",
          name: "probe_tool",
          description: "A no-op compatibility probe.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          strict: false,
        }],
        tool_choice: { type: "function", name: "probe_tool" },
        max_output_tokens: 128,
        stream: true,
        store: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return { kind: "endpointError", status: resp.status };
    if (!resp.body) return { kind: "endpointError", status: 0 };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawFunctionCall = false;
    let sawArgumentsDelta = false;
    let sawDoneWithoutArguments = false;
    let sawDoneWithArguments = false;
    let sawOutputItemDoneWithArguments = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const frames = buf.split(/\n\n+/);
        const completeFrames = frames.slice(0, -1);
        buf = frames[frames.length - 1] ?? "";

        for (const frame of completeFrames) {
          const dataLines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;
          const data = dataLines.join("\n");
          if (data === "[DONE]") continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
            sawFunctionCall = true;
          } else if (event.type === "response.function_call_arguments.delta") {
            sawArgumentsDelta = true;
          } else if (event.type === "response.function_call_arguments.done") {
            if (typeof event.arguments === "string") sawDoneWithArguments = true;
            else sawDoneWithoutArguments = true;
          } else if (
            event.type === "response.output_item.done"
            && event.item?.type === "function_call"
            && typeof event.item.arguments === "string"
          ) {
            sawOutputItemDoneWithArguments = true;
          } else if (event.type === "response.completed") {
            const output = Array.isArray(event.response?.output) ? event.response.output : [];
            if (output.some((item: any) => item?.type === "function_call" && typeof item.arguments === "string")) {
              sawOutputItemDoneWithArguments = true;
            }
          }
        }

        if (sawFunctionCall && (sawDoneWithArguments || sawOutputItemDoneWithArguments)) {
          return { kind: "supported" };
        }
        if (sawDoneWithoutArguments && !sawOutputItemDoneWithArguments && buf.length > 32_000) break;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }

    if (!sawFunctionCall) return { kind: "incompatible", reason: "tool call was not emitted" };
    if (sawArgumentsDelta && sawDoneWithoutArguments && !sawDoneWithArguments && !sawOutputItemDoneWithArguments) {
      return { kind: "incompatible", reason: "function_call_arguments.done omitted arguments" };
    }
    return { kind: "incompatible", reason: "tool call arguments were not finalized" };
  } catch {
    return { kind: "endpointError", status: 0 };
  }
}

async function testOpenAIChatStream(clean: string, apiKey: string, model: string): Promise<ChatStreamResult> {
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
    if (!resp.ok) return { kind: "endpointError", status: resp.status };
    if (!resp.body) return { kind: "endpointError", status: 0 };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (/"finish_reason"\s*:\s*"(?!null)[^"]+"/.test(buf)) return { kind: "hasFinishReason" };
        if (buf.includes("[DONE]") || buf.length > 16_000) return { kind: "noFinishReason" };
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { kind: "noFinishReason" };
  } catch {
    return { kind: "endpointError", status: 0 };
  }
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  apiStyle: string = "auto",
  testModel?: string,
  preferredOpenAIMode: "chat-completions" | "responses" = "chat-completions",
): Promise<TestResult> {
  const clean = normalizeBaseUrl(baseUrl);

  if (apiStyle === "openai" || apiStyle === "auto") {
    try {
      const modelsResp = await fetch(`${clean}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (modelsResp.ok) {
        const modelsData = (await modelsResp.json()) as { data?: Array<{ id?: string; display_name?: string }> };
        const discoveredModels = Array.isArray(modelsData.data)
          ? modelsData.data
            .filter((m): m is { id: string; display_name?: string } => !!m.id && !m.id.startsWith("ft:"))
            .map((m) => ({ id: m.id, name: m.display_name || m.id }))
          : [];
        const model = testModel || discoveredModels[0]?.id;
        if (!model) {
          if (apiStyle === "openai") return { ok: false, error: "/v1/models returned an empty model list" };
        } else {
          let chatResult: ChatStreamResult | undefined;
          if (preferredOpenAIMode === "chat-completions") {
            chatResult = await testOpenAIChatStream(clean, apiKey, model);
            if (chatResult.kind === "hasFinishReason" || chatResult.kind === "noFinishReason") {
              return {
                ok: true,
                detectedApi: "openai",
                openaiApiMode: "chat-completions",
                supportsOpenAIResponses: false,
                needsFinishReasonFallback: chatResult.kind === "noFinishReason",
                discoveredModels,
              };
            }
          }

          const responsesResult = await testOpenAIResponsesStream(clean, apiKey, model);
          if (responsesResult.kind === "supported") {
            const toolResult = await testOpenAIResponsesToolStream(clean, apiKey, model);
            if (toolResult.kind === "supported") {
              return {
                ok: true,
                detectedApi: "openai",
                openaiApiMode: "responses",
                supportsOpenAIResponses: true,
                discoveredModels,
              };
            }
          }

          if (preferredOpenAIMode === "responses") {
            chatResult = await testOpenAIChatStream(clean, apiKey, model);
            if (chatResult.kind === "hasFinishReason" || chatResult.kind === "noFinishReason") {
              return {
                ok: true,
                detectedApi: "openai",
                openaiApiMode: "chat-completions",
                supportsOpenAIResponses: false,
                needsFinishReasonFallback: chatResult.kind === "noFinishReason",
                discoveredModels,
              };
            }
          }

          if (apiStyle === "openai") {
            const chatStatus = chatResult?.kind === "endpointError" ? `HTTP ${chatResult.status}` : "unavailable";
            return {
              ok: false,
              error: `OpenAI-compatible tests failed: Chat Completions ${chatStatus}; Responses unavailable or incompatible`,
            };
          }
        }
      } else if (apiStyle === "openai") {
        const body = await modelsResp.text().catch(() => "");
        return { ok: false, error: `OpenAI test failed (HTTP ${modelsResp.status}): ${body.slice(0, 200)}` };
      }
    } catch (e: unknown) {
      if (apiStyle === "openai") return { ok: false, error: `OpenAI connection failed: ${(e as Error).message}` };
    }
  }

  if (apiStyle === "anthropic" || apiStyle === "auto") {
    const model = testModel || await pickModel(clean, apiKey, "anthropic");
    try {
      const resp = await fetch(`${clean}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model || "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.ok) return { ok: true, detectedApi: "anthropic" };
      return { ok: false, error: `Anthropic test failed (HTTP ${resp.status})` };
    } catch (e: unknown) {
      return { ok: false, error: `Anthropic connection failed: ${(e as Error).message}` };
    }
  }

  return { ok: false, error: `Unknown API style: ${apiStyle}` };
}

export async function discoverModelsFromProvider(
  baseUrl: string,
  apiKey: string,
  apiStyle: string,
): Promise<DiscoveredModel[]> {
  const result = await discoverModelsFromProviderWithDiagnostics(baseUrl, apiKey, apiStyle);
  return result.models;
}

export interface ModelDiscoveryResult {
  models: DiscoveredModel[];
  error?: string;
  status?: number;
}

export async function discoverModelsFromProviderWithDiagnostics(
  baseUrl: string,
  apiKey: string,
  apiStyle: string,
): Promise<ModelDiscoveryResult> {
  const clean = normalizeBaseUrl(baseUrl);

  if (apiStyle === "openai") {
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { models: [], status: resp.status, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      if (!data.data || !Array.isArray(data.data)) {
        return { models: [], status: resp.status, error: "/v1/models response did not contain data[]" };
      }
      return {
        models: data.data.filter((m) => m.id && !m.id.startsWith("ft:")).map((m) => ({ id: m.id, name: m.id })),
        status: resp.status,
      };
    } catch (e: unknown) {
      return { models: [], error: (e as Error).message };
    }
  }

  if (apiStyle === "anthropic") {
    const defaultModels = [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
      { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
    ];
    try {
      const resp = await fetch(`${clean}/v1/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: Array<{ id: string; display_name?: string }> };
        if (data.data && Array.isArray(data.data)) {
          return {
            models: data.data.map((m) => ({ id: m.id, name: m.display_name || m.id })),
            status: resp.status,
          };
        }
        return { models: [], status: resp.status, error: "/v1/models response did not contain data[]" };
      }
      return { models: defaultModels, status: resp.status, error: `/v1/models HTTP ${resp.status}; using Anthropic defaults` };
    } catch (e: unknown) {
      return { models: defaultModels, error: `${(e as Error).message}; using Anthropic defaults` };
    }
  }

  return { models: [], error: `Unknown API style: ${apiStyle}` };
}

export function detectContextWindow(modelId: string): number {
  if (/v4-flash|v4-pro|1m|1000k|minimax-m3|mimo/i.test(modelId)) return 1000000;
  if (/gpt-5\.5/i.test(modelId)) return 272000;
  if (/gpt-5\.4$/i.test(modelId)) return 500000;
  if (/kimi-k2\.6|kimi-k2\.5|qwen3\.7|qwen3-7|glm-5\.1|glm-5|command-a/i.test(modelId)) return 262144;
  if (/claude|haiku|sonnet|opus/i.test(modelId)) return 200000;
  return 256000;
}
