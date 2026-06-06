/**
 * discovery.ts — 供应商检测 + 模型发现
 */

import type { DiscoveredModel, TestResult } from "./config.js";
import { normalizeBaseUrl } from "./config.js";

export async function testProviderConnection(
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

export async function discoverModelsFromProvider(
  baseUrl: string, apiKey: string, apiStyle: string,
): Promise<DiscoveredModel[]> {
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
        if (data.data && Array.isArray(data.data))
          return data.data.map((m) => ({ id: m.id, name: m.display_name || m.id }));
      }
    } catch { /* fall through */ }
    return [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet" },
      { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
    ];
  }

  return [];
}

export function detectContextWindow(modelId: string): number {
  if (/v4-flash|v4-pro|1m|1000k|minimax-m3|mimo/i.test(modelId)) return 1000000;
  if (/gpt-5\.5/i.test(modelId)) return 272000;
  if (/gpt-5\.4$/i.test(modelId)) return 500000;
  if (/kimi-k2\.6|kimi-k2\.5|qwen3\.7|qwen3-7|glm-5\.1|glm-5|command-a/i.test(modelId)) return 262144;
  if (/claude|haiku|sonnet|opus/i.test(modelId)) return 200000;
  return 256000;
}
