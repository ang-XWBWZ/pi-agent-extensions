/**
 * register.ts — 供应商注册 + 恢复
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiscoveredModel } from "./config.js";
import { normalizeBaseUrl, readCustomProviders } from "./config.js";
import { createOpenAITolerantStream } from "./tolerant-stream.js";
import { detectContextWindow } from "./discovery.js";

/**
 * 包装内核 streamSimpleAnthropic，注入 x-thinking-level header。
 * Anthropic API 本身没有 thinking "level" 字段（只有 budget_tokens 数字或 effort），
 * 中转站/代理无法区分 minimal/low/medium/high/xhigh。
 * 此包装在 HTTP 请求头中加入 x-thinking-level，对 API 完全无害，
 * 但让任何反向代理都能按等级做路由/审计/日志。
 */
import {
  streamSimpleAnthropic,
  type Model,
  type Api,
  type Context,
  type SimpleStreamOptions,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

function createAnthropicTraceableStream() {
  return function wrappedStream(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const level = options?.reasoning;
    // 内核 streamSimpleAnthropic 需要 Model<"anthropic-messages">，此处仅 wrapper 用自定义 api 名。
    // 内部 model.api 不影响内核处理逻辑，安全 cast。
    const m = model as any;
    if (level && level !== "off") {
      return streamSimpleAnthropic(m, context, {
        ...options,
        headers: { ...(options?.headers ?? {}), "x-thinking-level": level },
      });
    }
    return streamSimpleAnthropic(m, context, options);
  };
}

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

  // Anthropic 风格：包装内核 streamSimpleAnthropic，仅注入 x-thinking-level header。
  // 内核完整负责 thinking level → budget_tokens/effort 转换，我们不重写任何载荷逻辑。
  if (apiStyle === "anthropic") {
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
      streamSimple: createAnthropicTraceableStream(),
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
