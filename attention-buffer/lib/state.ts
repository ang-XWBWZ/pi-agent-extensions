/**
 * state.ts — 状态管理 (globalThis)
 */

import { DEFAULT_CONFIG, type BufferState, type AttentionItem } from "./types.js";

// ---- 加载 ----

export function loadState(): BufferState {
  const key = "__pi_attention_buffer";
  const raw = (globalThis as Record<string, unknown>)[key] as Record<string, unknown> | undefined;

  if (raw) {
    if ("tokensSinceRemind" in raw) {
      const oldTokens = (raw.tokensSinceRemind as number) || 0;
      const oldRounds = (raw.roundsSinceRemind as number) || 0;
      raw.sessionTokens = oldTokens;
      raw.sessionRounds = oldRounds;
      raw.lastResetTokens = 0;
      raw.lastResetRounds = 0;
      delete raw.tokensSinceRemind;
      delete raw.roundsSinceRemind;
      delete raw.tokensSinceRotate;
      delete raw.roundsSinceRotate;
      delete raw.lastRemindSnapshot;
      delete raw.lastRotateSnapshot;
      (raw as Record<string, unknown>).calibrated = true;
    }
    if (raw.sessionTokens === undefined) raw.sessionTokens = 0;
    if (raw.sessionRounds === undefined) raw.sessionRounds = 0;
    if (raw.lastResetTokens === undefined) raw.lastResetTokens = 0;
    if (raw.lastResetRounds === undefined) raw.lastResetRounds = 0;
    if (raw.lastTurnTokens === undefined) raw.lastTurnTokens = 0;
    if (raw.calibrated === undefined) raw.calibrated = false;
    if (Array.isArray(raw.items)) {
      for (const it of raw.items as Array<Record<string, unknown>>) {
        if (it.sticky === undefined) it.sticky = false;
      }
    }
    return raw as unknown as BufferState;
  }

  const fresh: BufferState = {
    config: {
      ...DEFAULT_CONFIG,
      remind: { ...DEFAULT_CONFIG.remind },
      rotate: { ...DEFAULT_CONFIG.rotate },
    },
    items: [],
    sessionTokens: 0,
    sessionRounds: 0,
    lastResetTokens: 0,
    lastResetRounds: 0,
    lastTurnTokens: 0,
    calibrated: false,
  };
  (globalThis as Record<string, unknown>)[key] = fresh;
  return fresh;
}

// ---- 派生值 ----

export function tokensSince(st: BufferState): number {
  return Math.max(0, st.sessionTokens - st.lastResetTokens);
}

export function roundsSince(st: BufferState): number {
  return st.sessionRounds - st.lastResetRounds;
}

export function resetCounters(st: BufferState): void {
  st.lastResetTokens = st.sessionTokens;
  st.lastResetRounds = st.sessionRounds;
}

// ---- Ring Buffer ----

let _idCounter = 0;
function nextId(): string {
  return `attn_${Date.now()}_${++_idCounter}`;
}

export function addItem(st: BufferState, content: string, sticky: boolean = false): AttentionItem {
  const max = st.config.maxCharsPerItem;
  const trimmed = content.length > max ? content.slice(0, max) + "…" : content;
  const item: AttentionItem = { id: nextId(), content: trimmed, createdAt: Date.now(), sticky };
  st.items.push(item);
  while (st.items.length > st.config.maxItems) st.items.shift();
  resetCounters(st);
  return item;
}

// ---- 格式化 ----

export function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

export function parseConfigValue(raw: string): number | undefined {
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "0") return 0;
  const m = s.match(/^(\d+)(k|m)?$/);
  if (!m) return undefined;
  let n = parseInt(m[1], 10);
  if (m[2] === "k") n *= 1000;
  if (m[2] === "m") n *= 1000000;
  return n;
}
