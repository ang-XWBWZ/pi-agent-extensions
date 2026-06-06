/**
 * attention-config.ts — attention_config 工具 + /note 命令
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BufferState } from "../lib/types.js";
import { tokensSince, roundsSince, fmtK, addItem, parseConfigValue } from "../lib/state.js";

function updateStatus(ctx: ExtensionContext, st: BufferState): void {
  ctx.ui.setStatus("attn-buf", st.items.length > 0 ? `📌 ${st.items.length}` : "");
}

export function registerAttentionConfig(pi: ExtensionAPI, st: BufferState): void {
  // ---- attention_config 工具 ----
  pi.registerTool({
    name: "attention_config",
    label: "Attention Config",
    description: "查看或调整注意力暂存器配置：提醒/轮换阈值、条数上限、单条字符上限。",
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
      if (!params.key) {
        const c = st.config;
        return { content: [{ type: "text", text: [
          "📌 注意力暂存器配置", "",
          `提醒: tokens≥${fmtK(c.remind.tokens)} | 单轮>${fmtK(c.remind.singleTurnTokens)}`,
          `轮换: tokens≥${fmtK(c.rotate.tokens)} | rounds≥${c.rotate.rounds}`,
          `容量: maxItems=${c.maxItems} | maxChars=${c.maxCharsPerItem}`,
          "", `当前: ${st.items.length} 条, 会话总量 ${fmtK(st.sessionTokens)}t/${st.sessionRounds}轮, 距上次重置 ${fmtK(tokensSince(st))}t/${roundsSince(st)}轮`,
        ].join("\n") }] };
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
        return { content: [{ type: "text", text: `❌ 未知配置: ${params.key}\n可选: ${Object.keys(pathMap).join(", ")}` }] };
      }

      (entry[0] as Record<string, number>)[entry[1]] = val;

      if (params.key === "maxItems") {
        while (st.items.length > val) st.items.shift();
      }
      if (params.key === "maxChars") {
        for (const it of st.items) {
          if (it.content.length > val) it.content = it.content.slice(0, val) + "…";
        }
      }

      return { content: [{ type: "text", text: `✅ ${params.key} → ${val}` }] };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`attention_config(${args.key ?? "?"})`)));
      return text;
    },
  });

  // ---- /note 用户兜底命令 ----
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
