/**
 * config.ts — 类型定义 + settings 读写
 *
 * 自 v2.1 使用共享 settings-io 单例，不再直接读写磁盘。
 * 避免与 model-switch 的 settings 写入冲突。
 */

// ---- 类型 ----

export type AnthropicThinkingMode =
  | "builtin"
  | "adaptive_effort";

export interface DiscoveredModel {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderEntry {
  baseUrl: string;
  apiKey: string;
  apiStyle: "openai" | "anthropic";
  openaiApiMode?: "chat-completions" | "responses";
  anthropicThinkingMode?: AnthropicThinkingMode;
  models: DiscoveredModel[];
  createdAt: number;
  customStream?: boolean;
  customStreamExplicit?: boolean;
  supportsUsageInStreaming?: boolean;
  streamCompatMode?: "builtin" | "finish-reason-fallback";
}

export interface TestResult {
  ok: boolean;
  error?: string;
  detectedApi?: "openai" | "anthropic";
  openaiApiMode?: "chat-completions" | "responses";
  supportsOpenAIResponses?: boolean;
  needsFinishReasonFallback?: boolean;
  discoveredModels?: DiscoveredModel[];
}

// ---- 常量 ----

export const CUSTOM_PROVIDERS_KEY = "customProviders";
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

// ---- 自定义供应商持久化（通过共享 settings-io） ----

import { getSettings, updateSettings } from "../../lib/settings-io.js";

export function readCustomProviders(): Record<string, CustomProviderEntry> {
  const s = getSettings();
  const providers = s[CUSTOM_PROVIDERS_KEY] as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== "object") return {};
  const result: Record<string, CustomProviderEntry> = {};
  for (const [key, val] of Object.entries(providers)) {
    const v = val as Record<string, unknown>;
    if (v && typeof v.baseUrl === "string" && typeof v.apiKey === "string") {
      const streamCompatVal = v.streamCompatMode;
      const streamCompatMode: "builtin" | "finish-reason-fallback" | undefined =
        streamCompatVal === "builtin" || streamCompatVal === "finish-reason-fallback"
          ? streamCompatVal
          : undefined;
      const openaiApiModeVal = v.openaiApiMode;
      const openaiApiMode: "chat-completions" | "responses" | undefined =
        openaiApiModeVal === "chat-completions" || openaiApiModeVal === "responses"
          ? openaiApiModeVal
          : undefined;
      const anthropicThinkingModeVal = v.anthropicThinkingMode;
      const anthropicThinkingMode: AnthropicThinkingMode | undefined =
        anthropicThinkingModeVal === "builtin" ||
        anthropicThinkingModeVal === "adaptive_effort"
          ? anthropicThinkingModeVal
          : undefined;
      result[key] = {
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        apiStyle: (v.apiStyle as "openai" | "anthropic") || "openai",
        openaiApiMode,
        models: Array.isArray(v.models) ? (v.models as DiscoveredModel[]) : [],
        createdAt: (v.createdAt as number) || Date.now(),
        customStream: v.customStream === true,
        customStreamExplicit: v.customStreamExplicit === true,
        streamCompatMode,
        anthropicThinkingMode,
        supportsUsageInStreaming: typeof v.supportsUsageInStreaming === "boolean"
          ? v.supportsUsageInStreaming
          : undefined,
      };
    }
  }
  return result;
}

export function writeCustomProviders(providers: Record<string, CustomProviderEntry>): void {
  updateSettings((s) => {
    if (Object.keys(providers).length > 0) s[CUSTOM_PROVIDERS_KEY] = providers;
    else delete s[CUSTOM_PROVIDERS_KEY];
    return s;
  });
}

// ---- 工具函数 ----

export function normalizeBaseUrl(url: string): string {
  let u = url.replace(/\/+$/, "");
  u = u.replace(/\/v1$/, "");
  return u;
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
