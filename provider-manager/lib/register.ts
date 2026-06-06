/**
 * register.ts — 供应商注册 + 恢复
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiscoveredModel } from "./config.js";
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
): void {
  const hdrs: Record<string, string> = {};
  let authHeader = false;
  if (apiStyle === "anthropic") {
    hdrs["x-api-key"] = apiKey;
    hdrs["anthropic-version"] = "2023-06-01";
  } else {
    authHeader = true;
  }

  // Anthropic 风格始终注入我们自己的一处流处理器，不走内核
  // 1) 思考等级 → budget_tokens 正确映射
  // 2) 工具调用 Anthropic 语义正确解析
  if (apiStyle === "anthropic") {
    const apiName = `${providerName}-anthropic-custom`;
    for (const m of modelConfigs) (m as any).api = apiName;
    pi.registerProvider(providerName, {
      name: providerName,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      api: apiName,
      headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
      authHeader: undefined,
      models: modelConfigs,
      streamSimple: createAnthropicStream(),
    });
    return;
  }

  if (streamCompatMode === "finish-reason-fallback") {
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
    api: apiStyle === "anthropic" ? "anthropic-messages" : "openai-completions",
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
      registerCustomProvider(pi, name, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, streamCompatMode);
    } catch {
      // Skip failed re-registrations
    }
  }
}
