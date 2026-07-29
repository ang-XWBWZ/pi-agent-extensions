import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCustomProviders, writeCustomProviders } from "./config.js";
import { buildModelConfigs, registerCustomProvider } from "./register.js";

export interface ModelLimitUpdate {
  provider: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

export function updateCustomModelLimits(
  pi: ExtensionAPI,
  providerName: string,
  modelId: string,
  contextWindow?: number,
  maxTokens?: number,
): ModelLimitUpdate {
  if (!providerName) throw new Error("provider is required");
  if (!modelId) throw new Error("model is required");
  if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
    throw new Error("contextWindow must be positive");
  }
  if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
    throw new Error("maxTokens must be positive");
  }
  if (contextWindow === undefined && maxTokens === undefined) {
    throw new Error("contextWindow or maxTokens is required");
  }

  const customProviders = readCustomProviders();
  const cfg = customProviders[providerName];
  if (!cfg) {
    const keys = Object.keys(customProviders);
    throw new Error(`Provider does not exist: ${providerName}. Registered: ${keys.join(", ") || "(none)"}`);
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
  if (!found) throw new Error(`Model does not exist: ${providerName}/${modelId}`);

  customProviders[providerName] = cfg;
  writeCustomProviders(customProviders);

  const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
    ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
    : undefined;
  const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
  try { pi.unregisterProvider(providerName); } catch {}
  registerCustomProvider(
    pi,
    providerName,
    cfg.baseUrl,
    cfg.apiKey,
    cfg.apiStyle,
    modelConfigs,
    cfg.streamCompatMode ?? "builtin",
    cfg.openaiApiMode ?? "chat-completions",
    cfg.anthropicThinkingMode ?? "builtin",
  );

  const updated = modelConfigs.find((m) => m.id === modelId);
  if (!updated) throw new Error(`Model does not exist after update: ${providerName}/${modelId}`);
  return {
    provider: providerName,
    model: modelId,
    contextWindow: updated.contextWindow,
    maxTokens: updated.maxTokens,
  };
}
