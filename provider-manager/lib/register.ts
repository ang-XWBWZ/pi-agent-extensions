/**
 * register.ts — 供应商注册 + 恢复
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnthropicThinkingMode, DiscoveredModel } from "./config.js";
import { normalizeBaseUrl, readCustomProviders } from "./config.js";
import { createOpenAITolerantStream } from "./tolerant-stream.js";
import { createAnthropicStream } from "./anthropic-stream.js";
import { detectContextWindow } from "./discovery.js";

export function buildModelConfigs(
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
      thinkingLevelMap: {
        off: undefined,
        minimal: isReasoning ? "minimal" : undefined,
        low: isReasoning ? "low" : undefined,
        medium: isReasoning ? "medium" : undefined,
        high: isReasoning ? "high" : undefined,
        xhigh: isReasoning ? "xhigh" : undefined,
      },
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextWindow: m.contextWindow ?? contextWindow ?? detectContextWindow(m.id),
      maxTokens: m.maxTokens ?? maxTokens ?? (isReasoning ? 16384 : 4096),
      ...(compat && Object.keys(compat).length > 0 ? { compat } : {}),
    };
  });
}

export function registerCustomProvider(
  pi: ExtensionAPI,
  providerName: string,
  baseUrl: string,
  apiKey: string,
  apiStyle: "openai" | "anthropic",
  modelConfigs: ReturnType<typeof buildModelConfigs>,
  streamCompatMode: "builtin" | "finish-reason-fallback",
  openaiApiMode: "chat-completions" | "responses" = "chat-completions",
  anthropicThinkingMode: AnthropicThinkingMode = "adaptive_effort",
): void {
  const hdrs: Record<string, string> = {};
  let authHeader = false;
  if (apiStyle === "anthropic") {
    hdrs["x-api-key"] = apiKey;
    hdrs["anthropic-version"] = "2023-06-01";
  } else {
    authHeader = true;
  }

  // Anthropic 风格：
  // Anthropic 风格：
  //   builtin → 内核 anthropic-messages（兼容模式，手动切换）
  //   adaptive_effort → 自定义 stream，新版 adaptive thinking 协议（默认）
  if (apiStyle === "anthropic") {
    if (anthropicThinkingMode === "builtin") {
      for (const m of modelConfigs) (m as any).api = "anthropic-messages";
      pi.registerProvider(providerName, {
        name: providerName,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        api: "anthropic-messages",
        headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
        authHeader: undefined,
        models: modelConfigs,
      });
      return;
    }

    const customApi = `${providerName}-anthropic-custom`;
    for (const m of modelConfigs) (m as any).api = customApi;
    pi.registerProvider(providerName, {
      name: providerName,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      api: customApi,
      headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
      authHeader: undefined,
      models: modelConfigs,
      streamSimple: createAnthropicStream(),
    });
    return;
  }

  if (streamCompatMode === "finish-reason-fallback") {
    if (openaiApiMode !== "chat-completions") {
      throw new Error("finish-reason-fallback only supports OpenAI Chat Completions mode");
    }
    if (apiStyle !== "openai") {
      throw new Error(`finish-reason-fallback 仅支持 OpenAI 风格，当前: ${apiStyle}`);
    }
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
    api: apiStyle === "anthropic"
      ? "anthropic-messages"
      : openaiApiMode === "responses"
        ? "openai-responses"
        : "openai-completions",
    headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
    authHeader: authHeader || undefined,
    models: modelConfigs,
  });
}

export function restoreCustomProviders(pi: ExtensionAPI): void {
  const customProviders = readCustomProviders();
  for (const [name, cfg] of Object.entries(customProviders)) {
    try {
      const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
        ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
        : undefined;
      const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
      const legacyCustomStream = cfg.customStream === true && cfg.customStreamExplicit === true;
      const streamCompatMode = cfg.streamCompatMode
        ?? (legacyCustomStream ? "finish-reason-fallback" : "builtin");
      registerCustomProvider(
        pi,
        name,
        cfg.baseUrl,
        cfg.apiKey,
        cfg.apiStyle,
        modelConfigs,
        streamCompatMode,
        cfg.openaiApiMode ?? "chat-completions",
        cfg.anthropicThinkingMode ?? "builtin",
      );
    } catch {
      // Skip failed re-registrations
    }
  }
}
