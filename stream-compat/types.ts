/**
 * stream-compat/types.ts — 双轨流兼容层类型定义
 */

import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";

/** 流运行轨道：auto（自动判定，默认）| builtin（主轨原生流）| tolerant（副轨容错直连流） */
export type StreamTrack = "auto" | "builtin" | "tolerant";

/** 细粒度兼容标识 */
export interface StreamCompatFlags {
  /** 是否在流式响应中请求 usage 统计（默认 true；部分旧版中转/vLLM 报 400 时设为 false） */
  supportsUsageInStreaming?: boolean;
  /**
   * 上游是否可靠返回 finish_reason。
   * 若为 false：Pi 内核流和副轨容错流在遇到连接断开或未收到终止标记时，均会根据流内容自适应推导终态（toolUse 或 stop），
   * 彻底免疫第三方中转站“终止符号丢失”导致崩溃的 bug。
   */
  supportsFinishReason?: boolean;
  /** 是否支持 developer role（默认 false，转为 system） */
  supportsDeveloperRole?: boolean;
  /** 助手消息是否强制附带 reasoning_content（DeepSeek 原生协议要求） */
  requiresReasoningContent?: boolean;
  /** 是否跳过 strict JSON schema 包装（针对不支持 strict: true 的渠道） */
  disableStrictSchema?: boolean;
  /** 连接空闲超时时间（毫秒，默认 300,000） */
  idleTimeoutMs?: number;
}

/** 针对特定供应商或 BaseUrl 的兼容规则 */
export interface StreamCompatRule {
  /** 匹配规则 ID */
  id: string;
  /** 规则名称/描述 */
  name: string;
  /** 匹配条件：正则匹配 baseUrl 或 provider 名称 */
  match: (provider: string, baseUrl?: string, modelId?: string) => boolean;
  /** 推荐轨道：builtin 或 tolerant */
  defaultTrack: "builtin" | "tolerant";
  /** 推荐的兼容能力标志 */
  flags: StreamCompatFlags;
}

/** 决策器解析出的最终运行时配置 */
export interface ResolvedStreamStrategy {
  /** 当前最终决策执行的物理轨道（builtin 或 tolerant） */
  track: "builtin" | "tolerant";
  /** 用户或配置中设定的原始轨道（auto | builtin | tolerant） */
  configuredTrack: StreamTrack;
  /** 命中的规则名称（用于日志和 /compat status） */
  matchedRule: string;
  /** 注入的兼容标志 */
  flags: StreamCompatFlags;
  /** 传递给 Pi 内核的 Model compat 参数 */
  kernelCompat: OpenAICompletionsCompat;
}
