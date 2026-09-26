/**
 * stream-compat/lib/strategy-resolver.ts — 双轨流兼容策略决策器 (支持 Auto 默认自适应)
 */

import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { BUILTIN_PRESET_RULES } from "../presets.js";
import type { ResolvedStreamStrategy, StreamCompatFlags, StreamTrack } from "../types.js";

/** 规范化外部传入的轨道配置（兼容旧版历史字符串） */
export function normalizeStreamTrack(rawTrack?: unknown): StreamTrack {
  if (typeof rawTrack !== "string") return "auto";
  const normalized = rawTrack.trim().toLowerCase();
  if (normalized === "tolerant" || normalized === "finish-reason-fallback") return "tolerant";
  if (normalized === "builtin") return "builtin";
  return "auto"; // 默认均为 auto
}

export function resolveStreamStrategy(
  provider: string,
  baseUrl?: string,
  modelId?: string,
  rawTrackOverride?: unknown,
  userFlagsOverride?: Partial<StreamCompatFlags>,
): ResolvedStreamStrategy {
  const configuredTrack = normalizeStreamTrack(rawTrackOverride);

  // 1. 查找匹配的预设规则
  const matched = BUILTIN_PRESET_RULES.find((rule) => rule.match(provider, baseUrl, modelId));
  const fallbackRule = BUILTIN_PRESET_RULES[BUILTIN_PRESET_RULES.length - 1]; // generic third party
  const rule = matched ?? fallbackRule;

  // 2. 确定实际执行的物理运行轨道
  let physicalTrack: "builtin" | "tolerant";
  if (configuredTrack === "auto") {
    // Auto 模式下由规则决定
    physicalTrack = rule.defaultTrack;
  } else {
    // 用户显式强制指定
    physicalTrack = configuredTrack;
  }

  // 3. 合并能力标志
  const flags: StreamCompatFlags = {
    ...rule.flags,
    ...(userFlagsOverride || {}),
  };

  // 4. 彻底解决“第三方工具添加模型触发终止符号 bug”：
  // 只要 BaseUrl 不是官方 api.openai.com，强制保证 supportsFinishReason 保护生效（除非显式指定 true）
  const isOfficialOpenAI = !baseUrl || baseUrl.includes("api.openai.com");
  if (!isOfficialOpenAI && userFlagsOverride?.supportsFinishReason === undefined) {
    flags.supportsFinishReason = false;
  }

  // 5. 组装 Pi 内核所需的 OpenAICompletionsCompat 结构
  const kernelCompat: OpenAICompletionsCompat = {
    supportsUsageInStreaming: flags.supportsUsageInStreaming ?? true,
    // 传递给 Pi 内核：当 supportsFinishReason 为 false 时，内核遇到中转断流将自适应收尾，绝不崩溃
    supportsFinishReason: flags.supportsFinishReason ?? true,
    supportsDeveloperRole: flags.supportsDeveloperRole ?? false,
    requiresReasoningContentOnAssistantMessages: flags.requiresReasoningContent ?? false,
    supportsStrictMode: !flags.disableStrictSchema,
  };

  return {
    track: physicalTrack,
    configuredTrack,
    matchedRule: rule.name,
    flags,
    kernelCompat,
  };
}
