/**
 * triggers.ts — 提醒/轮换阈值逻辑
 */

import { type BufferState, type TriggerResult } from "./types.js";
import { tokensSince, roundsSince, fmtK } from "./state.js";

export function checkRemind(st: BufferState): TriggerResult {
  const cfg = st.config.remind;
  const reasons: string[] = [];
  let triggered = false;
  if (st.items.length === 0) return { triggered: false, reasons: [] };

  const ts = tokensSince(st);

  if (cfg.tokens > 0 && ts >= cfg.tokens) {
    triggered = true;
    reasons.push(`累计 ${fmtK(ts)} tokens`);
  }
  if (cfg.singleTurnTokens > 0 && st.lastTurnTokens > cfg.singleTurnTokens) {
    triggered = true;
    reasons.push(`单轮 ${fmtK(st.lastTurnTokens)} tokens`);
  }
  return { triggered, reasons };
}

export function checkRotate(st: BufferState): TriggerResult {
  const cfg = st.config.rotate;
  const reasons: string[] = [];
  let triggered = false;
  if (st.items.length === 0) return { triggered: false, reasons: [] };

  const ts = tokensSince(st);
  const rs = roundsSince(st);

  if (cfg.tokens > 0 && ts >= cfg.tokens) {
    triggered = true;
    reasons.push(`累计 ${fmtK(ts)} tokens`);
  }
  if (cfg.rounds > 0 && rs >= cfg.rounds) {
    triggered = true;
    reasons.push(`${cfg.rounds} 轮`);
  }
  return { triggered, reasons };
}
