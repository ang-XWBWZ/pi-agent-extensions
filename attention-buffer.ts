/**
 * attention-buffer.ts — 自主注意力暂存器 (v4)
 *
 * AI 自主调用 + context 事件注入 + 粘性。
 *
 * 🔄 每轮通过 context 事件在 messages 末尾注入 buffer 内容
 *    不影响缓存前缀，LLM 总能看见
 *
 * 📌 粘性 — sticky 标记项跨 compaction 保留
 *
 * 📊 状态栏 📌N 提示 AI 主动检查
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

// ============================================================
// Types
// ============================================================

/** 内容中用于标记 buffer 注入的特征前缀（用于去重） */
const ATTN_BUF_MARKER = "[attention-buffer]";

interface AttentionItem {
  id: string;
  content: string;
  createdAt: number;
  /** 粘性标记：跨 compaction / resume 保留 */
  sticky: boolean;
}

interface RemindConfig {
  tokens: number;
  singleTurnTokens: number;
  multiTurnRounds: number;
  multiTurnTokens: number;
}

interface RotateConfig {
  tokens: number;
  rounds: number;
}

interface BufferConfig {
  remind: RemindConfig;
  rotate: RotateConfig;
  maxItems: number;
  maxCharsPerItem: number;
}

interface BufferState {
  config: BufferConfig;
  items: AttentionItem[];

  /** 会话累计（隐藏值，只增不减，用于计算 delta） */
  sessionTokens: number;
  sessionRounds: number;

  /** 上次重置时的会话快照 */
  lastResetTokens: number;
  lastResetRounds: number;

  /** 上一轮 token 增量（用于单轮 >80k 检查） */
  lastTurnTokens: number;

  /** 首次校准标记 */
  calibrated: boolean;
}

// ============================================================
// Defaults
// ============================================================

const DEFAULT_CONFIG: BufferConfig = {
  remind: { tokens: 15_000, singleTurnTokens: 30_000, multiTurnRounds: 3, multiTurnTokens: 10_000 },
  rotate: { tokens: 50_000, rounds: 10 },
  maxItems: 8,
  maxCharsPerItem: 300,
};

// ============================================================
// State (globalThis)
// ============================================================

function loadState(): BufferState {
  const key = "__pi_attention_buffer";
  const raw = (globalThis as Record<string, unknown>)[key] as Record<string, unknown> | undefined;

  // 迁移旧版本状态
  if (raw) {
    // 检测旧字段 tokensSinceRemind（v1/v2 标记）
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
      (raw as Record<string, unknown>).calibrated = true; // 已迁移，无需重新校准
    }
    // 确保新字段存在
    if (raw.sessionTokens === undefined) raw.sessionTokens = 0;
    if (raw.sessionRounds === undefined) raw.sessionRounds = 0;
    if (raw.lastResetTokens === undefined) raw.lastResetTokens = 0;
    if (raw.lastResetRounds === undefined) raw.lastResetRounds = 0;
    if (raw.lastTurnTokens === undefined) raw.lastTurnTokens = 0;
    if (raw.calibrated === undefined) raw.calibrated = false;
    // 迁移旧 items（补 sticky 字段）
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

// ---- 计算派生值 ----

function tokensSince(st: BufferState): number {
  return Math.max(0, st.sessionTokens - st.lastResetTokens);
}

function roundsSince(st: BufferState): number {
  return st.sessionRounds - st.lastResetRounds;
}

function resetCounters(st: BufferState): void {
  st.lastResetTokens = st.sessionTokens;
  st.lastResetRounds = st.sessionRounds;
}

// ============================================================
// Ring Buffer
// ============================================================

let _idCounter = 0;
function nextId(): string {
  return `attn_${Date.now()}_${++_idCounter}`;
}

function addItem(st: BufferState, content: string, sticky: boolean = false): AttentionItem {
  const max = st.config.maxCharsPerItem;
  const trimmed = content.length > max ? content.slice(0, max) + "…" : content;
  const item: AttentionItem = { id: nextId(), content: trimmed, createdAt: Date.now(), sticky };
  st.items.push(item);
  while (st.items.length > st.config.maxItems) st.items.shift();
  resetCounters(st);
  return item;
}

// ============================================================
// Threshold Logic
// ============================================================

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

interface TriggerResult {
  triggered: boolean;
  reasons: string[];
}

function checkRemind(st: BufferState): TriggerResult {
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

function checkRotate(st: BufferState): TriggerResult {
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

// ============================================================
// Injection
// ============================================================

// ============================================================
// 格式化 buffer → 注入文本
// ============================================================

/** 生成 buffer 的纯文本表示 */
function formatBufferText(st: BufferState): string {
  if (st.items.length === 0) return "";
  const lines = st.items.map((it, i) => {
    const tag = it.sticky ? " 📌" : "";
    const preview = it.content.length > 200 ? it.content.slice(0, 200) + "…" : it.content;
    return `  ${i + 1}.${tag} ${preview}`;
  });
  return [
    `${ATTN_BUF_MARKER} 注意力暂存器 (${st.items.length}/${st.config.maxItems}条, 建议≥${Math.ceil(st.config.maxItems * 0.8)}条时 summarize)`,
    ...lines,
  ].join("\n");
}

// ============================================================
// Status bar
// ============================================================

function updateStatus(ctx: ExtensionContext, st: BufferState): void {
  if (st.items.length > 0) {
    ctx.ui.setStatus("attn-buf", `📌 ${st.items.length}`);
  } else {
    ctx.ui.setStatus("attn-buf", "");
  }
}

/** 解析配置值，支持 k/m 后缀 */
function parseConfigValue(raw: string): number | undefined {
  const s = String(raw).trim().toLowerCase();
  if (s === "off" || s === "0") return 0;
  const m = s.match(/^(\d+)(k|m)?$/);
  if (!m) return undefined;
  let n = parseInt(m[1], 10);
  if (m[2] === "k") n *= 1000;
  if (m[2] === "m") n *= 1000000;
  return n;
}

// ============================================================
// Extension Entry
// ============================================================

export default function (pi: ExtensionAPI) {
  const st = loadState();

  // ==========================================================
  // attention_add — AI 向暂存器写入内容
  // ==========================================================
  pi.registerTool({
    name: "attention_add",
    label: "Attention Add",
    description:
      "向注意力暂存器写入一条临时备忘。超出条数上限时自动淘汰最旧条目。内容超长自动截断。",
    promptSnippet: "Add a note to attention buffer (content, optional sticky)",
    promptGuidelines: [
      "Use to store temporary reminders, observations, or context to remember across turns.",
      "content: the note text. Auto-truncated at maxCharsPerItem (default 300).",
      "sticky (optional): if true, the item persists across context compaction.",
      "  Use sticky for: current task mainline, critical user preferences, long-running state.",
      "  Use non-sticky for: temporary observations, one-time reminders, change logs.",
      "Buffer has a max item limit (default 8); oldest item is evicted FIFO when full.",
      "Buffer contents are automatically shown to you each turn via context event.",
      "Use attention_list for detailed view; attention_summarize to consolidate.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "暂存内容（超长自动截断）" }),
      sticky: Type.Optional(Type.Boolean({ description: "粘性标记：跨 compaction 保留（默认 false）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const item = addItem(st, params.content, params.sticky ?? false);
      return {
        content: [{ type: "text", text: `📌 已暂存 (${st.items.length}/${st.config.maxItems})${params.sticky ? " 📌粘性" : ""}: "${item.content.slice(0, 80)}${item.content.length > 80 ? "…" : ""}"` }],
        details: { id: item.id, count: st.items.length, maxItems: st.config.maxItems, sticky: params.sticky ?? false },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const preview = (args.content ?? "").slice(0, 40);
      const tag = args.sticky ? " 📌" : "";
      text.setText(theme.fg("toolTitle", theme.bold(`attention_add("${preview}${preview.length >= 40 ? "…" : ""}"${tag})`)));
      return text;
    },
  });

  // ==========================================================
  // attention_list — AI 查看暂存器
  // ==========================================================
  pi.registerTool({
    name: "attention_list",
    label: "Attention List",
    description:
      "查看注意力暂存器中所有暂存内容及当前阈值状态。",
    promptSnippet: "List all items in attention buffer",
    promptGuidelines: [
      "Use to inspect the current attention buffer contents.",
      "Returns all items with IDs, content, and threshold status.",
      "Also shows remind/rotate progress (tokens since last remind/rotate).",
      "Useful before deciding whether to summarize or clear.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      if (st.items.length === 0) {
        return { content: [{ type: "text", text: "📌 暂存器为空" }] };
      }

      const totalChars = st.items.reduce((s, it) => s + it.content.length, 0);
      const remindStatus = [
        `提醒进度: ${fmtK(tokensSince(st))} / ${fmtK(st.config.remind.tokens)} tokens, ${roundsSince(st)} 轮 (单轮 ${fmtK(st.lastTurnTokens)})`,
        `  触发条件: 累计≥${fmtK(st.config.remind.tokens)} / 单轮>${fmtK(st.config.remind.singleTurnTokens)}`,
      ].join("\n");

      const rotateStatus = `轮换进度: ${fmtK(tokensSince(st))} / ${fmtK(st.config.rotate.tokens)} tokens, ${roundsSince(st)} / ${st.config.rotate.rounds} 轮`;

      const itemLines = st.items.map((it, i) =>
        `  ${i + 1}. [${it.id}] ${it.content}`,
      ).join("\n");

      return {
        content: [{
          type: "text",
          text: [
            `📌 注意力暂存器 (${st.items.length}/${st.config.maxItems} 条, ${totalChars} 字符)`,
            `会话总量: ${fmtK(st.sessionTokens)} tokens, ${st.sessionRounds} 轮`,
            "",
            remindStatus,
            "",
            rotateStatus,
            "",
            itemLines || "  (空)",
          ].join("\n"),
        }],
        details: {
          count: st.items.length,
          maxItems: st.config.maxItems,
          totalChars,
          items: st.items.map((it) => ({ id: it.id, content: it.content })),
          session: { tokens: st.sessionTokens, rounds: st.sessionRounds },
          since: { tokens: tokensSince(st), rounds: roundsSince(st) },
        },
      };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`attention_list()`)));
      return text;
    },
  });

  // ==========================================================
  // attention_clear — AI 清空暂存器
  // ==========================================================
  pi.registerTool({
    name: "attention_clear",
    label: "Attention Clear",
    description:
      "清空注意力暂存器中所有内容，重置提醒和轮换计数器。",
    promptSnippet: "Clear the attention buffer",
    promptGuidelines: [
      "Use to clear all buffered items. Resets remind and rotate counters.",
      "Typically called after summarizing or when items are no longer relevant.",
      "FORBIDDEN: Do NOT clear without reason. Only clear when items are truly stale or have been addressed.",
    ],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const count = st.items.length;
      st.items.length = 0;
      resetCounters(st);
      return {
        content: [{ type: "text", text: `✅ 已清空 ${count} 条暂存，计数器已重置` }],
        details: { cleared: count },
      };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("attention_clear()")));
      return text;
    },
  });

  // ==========================================================
  // attention_summarize — LLM 精简暂存器
  // ==========================================================
  pi.registerTool({
    name: "attention_summarize",
    label: "Attention Summarize",
    description:
      "将暂存器中所有条目替换为一条总结。重置轮换计数器，消去轮换提示。",
    promptSnippet: "Summarize attention buffer into one concise item",
    promptGuidelines: [
      "Use when buffer has many stale items or needs consolidation.",
      "summary: a concise summary replacing all current items.",
      "Old items are cleared and replaced with a single '[总结] ...' entry.",
      "The context event will deliver the updated buffer contents next turn.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "替换全部条目的总结内容" }),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const oldCount = st.items.length;
      st.items.length = 0;
      addItem(st, `[总结] ${params.summary}`);
      return {
        content: [{ type: "text", text: `✅ 已总结 ${oldCount} 条 → 1 条: "${params.summary.slice(0, 80)}${params.summary.length > 80 ? "…" : ""}"` }],
        details: { oldCount, newCount: 1 },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const preview = (args.summary ?? "").slice(0, 40);
      text.setText(theme.fg("toolTitle", theme.bold(`attention_summarize("${preview}${preview.length >= 40 ? "…" : ""}")`)));
      return text;
    },
  });

  // ==========================================================
  // attention_config — AI 查看/调整配置
  // ==========================================================
  pi.registerTool({
    name: "attention_config",
    label: "Attention Config",
    description:
      "查看或调整注意力暂存器配置：提醒/轮换阈值、条数上限、单条字符上限。",
    promptSnippet: "Get or set attention buffer config",
    promptGuidelines: [
      "Without key: returns current config (read-only).",
      "With key and value: updates the specified config key.",
      "Valid keys: remind_tokens, remind_single, remind_multi_rounds, remind_multi_tokens, rotate_tokens, rotate_rounds, maxItems, maxChars.",
      "Values are numbers. Setting maxItems auto-trims excess items. Setting maxChars auto-trims existing items.",
      "Use this sparingly; defaults are sensible for most sessions.",
      "FORBIDDEN: Do NOT change config without user request or clear necessity.",
    ],
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: "配置项名（留空查看全部）" })),
      value: Type.Optional(Type.Number({ description: "新值（key 为空时忽略）" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      // read-only: show all config
      if (!params.key) {
        const c = st.config;
        return {
          content: [{
            type: "text",
            text: [
              "📌 注意力暂存器配置",
              "",
              `提醒: tokens≥${fmtK(c.remind.tokens)} | 单轮>${fmtK(c.remind.singleTurnTokens)}`,
              `轮换: tokens≥${fmtK(c.rotate.tokens)} | rounds≥${c.rotate.rounds}`,
              `容量: maxItems=${c.maxItems} | maxChars=${c.maxCharsPerItem}`,
              "",
              `当前: ${st.items.length} 条, 会话总量 ${fmtK(st.sessionTokens)}t/${st.sessionRounds}轮, 距上次重置 ${fmtK(tokensSince(st))}t/${roundsSince(st)}轮`,
            ].join("\n"),
          }],
        };
      }

      const val = params.value;
      if (val === undefined || val === null) {
        return { content: [{ type: "text", text: "❌ 缺少 value 参数" }] };
      }

      const pathMap: Record<string, [object, string]> = {
        remind_tokens: [st.config.remind, "tokens"],
        remind_single: [st.config.remind, "singleTurnTokens"],
        remind_multi_rounds: [st.config.remind, "multiTurnRounds"],
        remind_multi_tokens: [st.config.remind, "multiTurnTokens"],
        rotate_tokens: [st.config.rotate, "tokens"],
        rotate_rounds: [st.config.rotate, "rounds"],
        maxItems: [st.config, "maxItems"],
        maxChars: [st.config, "maxCharsPerItem"],
      };

      const entry = pathMap[params.key];
      if (!entry) {
        return {
          content: [{
            type: "text",
            text: `❌ 未知配置: ${params.key}\n可选: ${Object.keys(pathMap).join(", ")}`,
          }],
        };
      }

      (entry[0] as Record<string, number>)[entry[1]] = val;

      // 裁剪
      if (params.key === "maxItems") {
        while (st.items.length > val) st.items.shift();
      }
      if (params.key === "maxChars") {
        for (const it of st.items) {
          if (it.content.length > val) it.content = it.content.slice(0, val) + "…";
        }
      }

      return {
        content: [{ type: "text", text: `✅ ${params.key} → ${val}` }],
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const k = args.key ?? "?";
      text.setText(theme.fg("toolTitle", theme.bold(`attention_config(${k})`)));
      return text;
    },
  });

  // ==========================================================
  // context — 每轮在 messages 末尾注入 buffer 内容
  // ==========================================================

  pi.on("context", (event, _ctx) => {
    const existingIdx = event.messages.findIndex(
      (m) => typeof m.content === "string" && m.content.startsWith(ATTN_BUF_MARKER),
    );

    if (st.items.length === 0) {
      // 无内容 → 清理残留标记消息（如有）
      if (existingIdx >= 0) {
        const cleaned = [...event.messages];
        cleaned.splice(existingIdx, 1);
        return { messages: cleaned };
      }
      return;
    }

    const currentText = formatBufferText(st);

    // 已有 buffer 消息且内容未变 → 不动（不浪费本轮）
    if (existingIdx >= 0 && event.messages[existingIdx].content === currentText) {
      return;
    }

    // 内容变了或没有旧消息 → 替换/追加
    const cleaned = existingIdx >= 0
      ? [...event.messages.slice(0, existingIdx), ...event.messages.slice(existingIdx + 1)]
      : [...event.messages];

    cleaned.push({ role: "user", content: currentText } as any);
    return { messages: cleaned };
  });

  // ==========================================================
  // message_end — token 追踪 + 状态栏更新
  // ==========================================================

  pi.on("message_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens ?? 0;

    if (!st.calibrated) {
      st.sessionTokens = currentTokens;
      st.sessionRounds = 0;
      resetCounters(st);
      st.lastTurnTokens = 0;
      st.calibrated = true;
      updateStatus(ctx, st);
      return;
    }

    const deltaTokens = Math.max(0, currentTokens - st.sessionTokens);
    st.lastTurnTokens = deltaTokens;
    st.sessionTokens = currentTokens;
    st.sessionRounds++;

    updateStatus(ctx, st);
  });

  // ==========================================================
  // 用户兜底命令（调试用，一般不调用）
  // ==========================================================
  pi.registerCommand("note", {
    description: "注意力暂存器管理: /note add|list|clear|config [key] [value]",
    handler: async (args, ctx) => {
      const sub = args._?.[0] ?? "list";
      switch (sub) {
        case "add": {
          const content = args._?.slice(1).join(" ") || args.text || "";
          if (!content.trim()) { ctx.ui.notify("用法: /note add <内容> [--sticky]", "warning"); return; }
          const sticky = args.sticky === true || args.sticky === "true";
          const item = addItem(st, content.trim(), sticky);
          updateStatus(ctx, st);
          ctx.ui.notify(`📌 已暂存 (${st.items.length}/${st.config.maxItems})${sticky ? " 📌粘性" : ""}: "${item.content.slice(0, 60)}…"`, "info");
          break;
        }
        case "list": {
          if (st.items.length === 0) { ctx.ui.notify("暂存器为空", "info"); return; }
          const lines = [
            `📌 暂存器 (${st.items.length}/${st.config.maxItems})`,
            `会话总量 ${fmtK(st.sessionTokens)}t/${st.sessionRounds}轮 | 距重置 ${fmtK(tokensSince(st))}t/${roundsSince(st)}轮`,
            ...st.items.map((it, i) => {
              const tag = it.sticky ? " 📌" : "";
              return `  ${i + 1}.${tag} ${it.content}`;
            }),
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "clear":
          ctx.ui.notify(`已清空 ${st.items.length} 条`, "info");
          st.items.length = 0;
          updateStatus(ctx, st);
          break;
        case "config": {
          const key = args._?.[1];
          const valRaw = args._?.[2];

          // 无参数 → 显示全部
          if (!key) {
            const c = st.config;
            ctx.ui.notify([
              `📌 暂存器配置`,
              `提醒: tokens≥${fmtK(c.remind.tokens)} | 单轮>${fmtK(c.remind.singleTurnTokens)} | 多轮${c.remind.multiTurnRounds}轮≥${fmtK(c.remind.multiTurnTokens)}`,
              `轮换: tokens≥${fmtK(c.rotate.tokens)} | rounds≥${c.rotate.rounds}`,
              `容量: maxItems=${c.maxItems} | maxChars=${c.maxCharsPerItem}`,
              ``,
              `当前: ${st.items.length} 条, ${fmtK(st.sessionTokens)}t/${st.sessionRounds}轮`,
              ``,
              `设置: /note config <key> <value>`,
              `可用 key: remind_tokens remind_single rotate_tokens rotate_rounds max_items max_chars`,
            ].join("\n"), "info");
            return;
          }

          // 只有 key 无 value → 显示单项
          if (valRaw === undefined) {
            const valMap: Record<string, () => number> = {
              remind_tokens: () => st.config.remind.tokens,
              remind_single: () => st.config.remind.singleTurnTokens,
              rotate_tokens: () => st.config.rotate.tokens,
              rotate_rounds: () => st.config.rotate.rounds,
              max_items: () => st.config.maxItems,
              max_chars: () => st.config.maxCharsPerItem,
            };
            const getter = valMap[key];
            if (!getter) { ctx.ui.notify(`未知配置: ${key}`, "warning"); return; }
            ctx.ui.notify(`${key} = ${getter()}`, "info");
            return;
          }

          // key + value → 设置
          const val = parseConfigValue(valRaw);
          if (val === undefined || val < 0) { ctx.ui.notify(`无效值: ${valRaw}`, "warning"); return; }

          const setMap: Record<string, (v: number) => void> = {
            remind_tokens: (v) => { st.config.remind.tokens = v; },
            remind_single: (v) => { st.config.remind.singleTurnTokens = v; },
            rotate_tokens: (v) => { st.config.rotate.tokens = v; },
            rotate_rounds: (v) => { st.config.rotate.rounds = v; },
            max_items: (v) => { st.config.maxItems = Math.max(1, v); while (st.items.length > st.config.maxItems) st.items.shift(); },
            max_chars: (v) => { st.config.maxCharsPerItem = Math.max(50, v); for (const it of st.items) if (it.content.length > v) it.content = it.content.slice(0, v) + "…"; },
          };
          const setter = setMap[key];
          if (!setter) { ctx.ui.notify(`未知配置: ${key}。可用: remind_tokens remind_single rotate_tokens rotate_rounds max_items max_chars`, "warning"); return; }
          setter(val);
          ctx.ui.notify(`✅ ${key} = ${val}`, "info");
          break;
        }
        default:
          ctx.ui.notify("用法: /note add|list|clear|config [key] [value]", "warning");
      }
    },
  });
}
