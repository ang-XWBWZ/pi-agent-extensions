/**
 * types.ts — 类型定义 + 默认配置
 */

// ---- 类型 ----

export interface AttentionItem {
  id: string;
  content: string;
  createdAt: number;
  sticky: boolean;
}

export interface RemindConfig {
  tokens: number;
  singleTurnTokens: number;
  multiTurnRounds: number;
  multiTurnTokens: number;
}

export interface RotateConfig {
  tokens: number;
  rounds: number;
}

export interface BufferConfig {
  remind: RemindConfig;
  rotate: RotateConfig;
  maxItems: number;
  maxCharsPerItem: number;
}

export interface BufferState {
  config: BufferConfig;
  items: AttentionItem[];
  sessionTokens: number;
  sessionRounds: number;
  lastResetTokens: number;
  lastResetRounds: number;
  lastTurnTokens: number;
  calibrated: boolean;
}

export interface TriggerResult {
  triggered: boolean;
  reasons: string[];
}

// ---- 常量 ----

export const ATTN_BUF_MARKER = "[attention-buffer]";

// ---- 默认配置 ----

export const DEFAULT_CONFIG: BufferConfig = {
  remind: { tokens: 15_000, singleTurnTokens: 30_000, multiTurnRounds: 3, multiTurnTokens: 10_000 },
  rotate: { tokens: 50_000, rounds: 10 },
  maxItems: 8,
  maxCharsPerItem: 300,
};
