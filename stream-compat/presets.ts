/**
 * stream-compat/presets.ts — 知名渠道与中转站流兼容预设
 */

import type { StreamCompatRule } from "./types.js";

export const BUILTIN_PRESET_RULES: StreamCompatRule[] = [
  // 1. 官方 OpenAI 端点：规范完备，走原生流且严格校验 finish_reason
  {
    id: "official-openai",
    name: "OpenAI Official API",
    match: (_provider, baseUrl) => !baseUrl || baseUrl.includes("api.openai.com"),
    defaultTrack: "builtin",
    flags: {
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      supportsDeveloperRole: true,
      disableStrictSchema: false,
    },
  },

  // 2. DeepSeek 原生或官方兼容端：需要 reasoning_content 结构回放，防御中转丢失终止符
  {
    id: "deepseek-family",
    name: "DeepSeek Protocol",
    match: (provider, baseUrl, modelId) => {
      const text = `${provider} ${baseUrl || ""} ${modelId || ""}`.toLowerCase();
      return text.includes("deepseek");
    },
    defaultTrack: "builtin",
    flags: {
      supportsUsageInStreaming: true,
      // 核心防御：第三方工具或中转添加的 DeepSeek 模型经常丢失终止帧，关闭强校验实现自适应终结
      supportsFinishReason: false,
      requiresReasoningContent: true,
      supportsDeveloperRole: false,
    },
  },

  // 3. 本地自建推理服务 (vLLM / Ollama / LocalAI / SGLang)
  {
    id: "local-inference",
    name: "Local/Self-hosted Inference (vLLM/Ollama)",
    match: (_provider, baseUrl) => {
      if (!baseUrl) return false;
      return (
        baseUrl.includes("localhost") ||
        baseUrl.includes("127.0.0.1") ||
        baseUrl.includes(":11434") || // Ollama
        baseUrl.includes(":8000") ||  // vLLM default
        baseUrl.includes(":8080") ||  // common local gateway
        /vllm|ollama|localai|sglang/i.test(baseUrl)
      );
    },
    // 本地中转或代理容易在 SSE 尾部丢失 [DONE] 或 finish_reason，副轨更稳
    defaultTrack: "tolerant",
    flags: {
      supportsUsageInStreaming: false, // 旧版本 vLLM/Ollama 遇 usage 会报 400
      supportsFinishReason: false,    // 自适应断流终态
      supportsDeveloperRole: false,
    },
  },

  // 4. 通用第三方 OpenAI 中转网关 (OneAPI / NewAPI / GPTPlus 等)
  // 用户明确指出：“第三方工具添加模型，也会触发终止符号bug”
  // 此规则为所有第三方中转站提供默认兜底与保护
  {
    id: "generic-third-party-relay",
    name: "Third-party OpenAI Relay",
    match: (_provider, baseUrl) => {
      return !!baseUrl && !baseUrl.includes("api.openai.com");
    },
    defaultTrack: "builtin",
    flags: {
      supportsUsageInStreaming: true,
      // 核心：所有第三方中转端点，默认开启 supportsFinishReason: false 保护，彻底免疫终止符丢失 bug
      supportsFinishReason: false,
      supportsDeveloperRole: false,
    },
  },
];
