/**
 * long-attention-ps.ts — 长程注意力 PS 注入器 (v1)
 *
 * 独立扩展模块：维护 typed PS 记忆，在 context 阶段按优先级、冷却、过期规则
 * 给主 agent 注入短提醒。它不直接解决任务，也不阻断工具调用；高风险 PS 可交给
 * shadow/rule-engine 进一步处理。
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PsPriority = "low" | "medium" | "high" | "critical";
type PsType =
  | "user_preference"
  | "project_constraint"
  | "prior_decision"
  | "open_loop"
  | "rejected_option"
  | "risk_memory"
  | "environment_fact"
  | "task_state"
  | "note";
type PsExpires = "turn" | "task" | "phase" | "session" | "project" | "persistent";
type PsSource = "agent" | "user" | "tool" | "shadow" | "runtime";

interface PsItem {
  id: string;
  message: string;
  type: PsType;
  priority: PsPriority;
  expires: PsExpires;
  source: PsSource;
  createdAt: number;
  lastInjectedAt: number;
  usedCount: number;
  enabled: boolean;
}

interface PsConfig {
  maxPsPerTurn: number;
  maxItems: number;
  maxCharsPerItem: number;
  cooldownRounds: number;
  injectLowPriority: boolean;
}

interface PsState {
  items: PsItem[];
  config: PsConfig;
  sessionRounds: number;
  calibrated: boolean;
}

const MARKER = "[long-attention-ps]";
const STATE_KEY = "__pi_long_attention_ps";

const DEFAULT_CONFIG: PsConfig = {
  maxPsPerTurn: 3,
  maxItems: 32,
  maxCharsPerItem: 180,
  cooldownRounds: 2,
  injectLowPriority: false,
};

const PRIORITY_WEIGHT: Record<PsPriority, number> = {
  low: 1,
  medium: 3,
  high: 6,
  critical: 10,
};

const TYPE_WEIGHT: Record<PsType, number> = {
  user_preference: 2,
  project_constraint: 5,
  prior_decision: 5,
  open_loop: 4,
  rejected_option: 4,
  risk_memory: 6,
  environment_fact: 2,
  task_state: 5,
  note: 1,
};

let idCounter = 0;

function loadState(): PsState {
  const raw = (globalThis as Record<string, unknown>)[STATE_KEY] as PsState | undefined;
  if (raw) {
    raw.config = { ...DEFAULT_CONFIG, ...(raw.config ?? {}) };
    raw.items ??= [];
    raw.sessionRounds ??= 0;
    raw.calibrated ??= false;
    for (const it of raw.items) {
      it.lastInjectedAt ??= -999_999;
      it.usedCount ??= 0;
      it.enabled ??= true;
    }
    return raw;
  }

  const fresh: PsState = {
    items: [],
    config: { ...DEFAULT_CONFIG },
    sessionRounds: 0,
    calibrated: false,
  };
  (globalThis as Record<string, unknown>)[STATE_KEY] = fresh;
  return fresh;
}

function nextId(): string {
  return `ps_${Date.now()}_${++idCounter}`;
}

function trimText(text: string, max: number): string {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parsePriority(raw: unknown): PsPriority {
  const s = String(raw ?? "medium");
  return (["low", "medium", "high", "critical"] as string[]).includes(s) ? s as PsPriority : "medium";
}

function parseType(raw: unknown): PsType {
  const s = String(raw ?? "note");
  const valid: PsType[] = ["user_preference", "project_constraint", "prior_decision", "open_loop", "rejected_option", "risk_memory", "environment_fact", "task_state", "note"];
  return valid.includes(s as PsType) ? s as PsType : "note";
}

function parseExpires(raw: unknown): PsExpires {
  const s = String(raw ?? "task");
  const valid: PsExpires[] = ["turn", "task", "phase", "session", "project", "persistent"];
  return valid.includes(s as PsExpires) ? s as PsExpires : "task";
}

function evictOne(st: PsState): void {
  // 淘汰顺序：disabled -> turn/task 临时项 -> low priority -> 最旧项。
  const disabledIdx = st.items.findIndex((it) => !it.enabled);
  if (disabledIdx >= 0) { st.items.splice(disabledIdx, 1); return; }

  const shortIdx = st.items.findIndex((it) => it.expires === "turn" || it.expires === "task");
  if (shortIdx >= 0) { st.items.splice(shortIdx, 1); return; }

  const lowIdx = st.items.findIndex((it) => it.priority === "low");
  if (lowIdx >= 0) { st.items.splice(lowIdx, 1); return; }

  st.items.shift();
}

function addPs(
  st: PsState,
  message: string,
  options: Partial<Pick<PsItem, "type" | "priority" | "expires" | "source">> = {},
): PsItem {
  const item: PsItem = {
    id: nextId(),
    message: trimText(message, st.config.maxCharsPerItem),
    type: options.type ?? "note",
    priority: options.priority ?? "medium",
    expires: options.expires ?? "task",
    source: options.source ?? "agent",
    createdAt: Date.now(),
    lastInjectedAt: -999_999,
    usedCount: 0,
    enabled: true,
  };
  st.items.push(item);
  while (st.items.length > st.config.maxItems) evictOne(st);
  return item;
}

function clearExpiredTurnItems(st: PsState): void {
  st.items = st.items.filter((it) => it.expires !== "turn");
}

function isCoolingDown(st: PsState, it: PsItem): boolean {
  if (it.priority === "critical") return false;
  return st.sessionRounds - it.lastInjectedAt < st.config.cooldownRounds;
}

function scoreItem(st: PsState, it: PsItem): number {
  if (!it.enabled) return -Infinity;
  if (!st.config.injectLowPriority && it.priority === "low") return -Infinity;
  if (isCoolingDown(st, it)) return -Infinity;

  let score = 0;
  score += PRIORITY_WEIGHT[it.priority] * 10;
  score += TYPE_WEIGHT[it.type] * 3;
  if (it.expires === "project" || it.expires === "persistent") score += 5;
  if (it.expires === "turn") score += 8;
  score -= Math.min(it.usedCount, 6) * 2;
  return score;
}

function selectPs(st: PsState): PsItem[] {
  return st.items
    .map((item) => ({ item, score: scoreItem(st, item) }))
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, st.config.maxPsPerTurn)
    .map((c) => c.item);
}

function formatPs(st: PsState, selected: PsItem[]): string {
  const lines = selected.map((it) => `PS[${it.priority}][${it.type}]: ${it.message}`);
  return [
    `${MARKER} Runtime PS (${selected.length}/${st.config.maxPsPerTurn})`,
    "这些是长程注意力模块生成的短提醒；除非涉及明确约束或风险，否则按建议处理。",
    ...lines,
  ].join("\n");
}

function updateStatus(ctx: ExtensionContext, st: PsState): void {
  const active = st.items.filter((it) => it.enabled).length;
  ctx.ui.setStatus("long-ps", active > 0 ? `🧠 ${active}` : "");
}

export default function (pi: ExtensionAPI) {
  const st = loadState();

  pi.registerTool({
    name: "long_attention_add_ps",
    label: "Long Attention Add PS",
    description: "添加一条长程注意力 PS。用于保存主 agent 后续需要被短提醒的约束、决策、风险或未闭环事项。",
    promptSnippet: "Add a Runtime PS reminder for the main agent",
    promptGuidelines: [
      "Use for compact, actionable reminders that should reappear across turns.",
      "Prefer high/critical only for explicit constraints, safety risks, or important prior decisions.",
      "Do not store generic advice. Each PS must be directly useful later.",
      "Use expires=turn/task for short-lived reminders; project/persistent for stable decisions/preferences.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "PS 内容，必须短、具体、可行动" }),
      type: Type.Optional(Type.String({ description: "user_preference|project_constraint|prior_decision|open_loop|rejected_option|risk_memory|environment_fact|task_state|note" })),
      priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
      expires: Type.Optional(Type.String({ description: "turn|task|phase|session|project|persistent" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const item = addPs(st, params.message, {
        type: parseType(params.type),
        priority: parsePriority(params.priority),
        expires: parseExpires(params.expires),
        source: "agent",
      });
      return {
        content: [{ type: "text", text: `🧠 已添加 PS[${item.priority}][${item.type}] (${st.items.length}/${st.config.maxItems}): ${item.message}` }],
        details: item,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const preview = String(args.message ?? "").slice(0, 40);
      text.setText(theme.fg("toolTitle", theme.bold(`long_attention_add_ps("${preview}${preview.length >= 40 ? "…" : ""}")`)));
      return text;
    },
  });

  pi.registerTool({
    name: "long_attention_list_ps",
    label: "Long Attention List PS",
    description: "查看长程注意力 PS 列表和当前注入配置。",
    promptSnippet: "List Runtime PS reminders",
    promptGuidelines: ["Use before deciding whether to clear or tune PS items."],
    parameters: Type.Object({}),
    async execute(_tcid, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (st.items.length === 0) return { content: [{ type: "text", text: "🧠 长程 PS 为空" }] };
      const lines = st.items.map((it, i) => {
        const off = it.enabled ? "" : " disabled";
        return `  ${i + 1}. [${it.id}] PS[${it.priority}][${it.type}][${it.expires}]${off} used=${it.usedCount}: ${it.message}`;
      });
      return {
        content: [{ type: "text", text: [`🧠 长程 PS (${st.items.length}/${st.config.maxItems})`, `配置: ${JSON.stringify(st.config)}`, `轮次: ${st.sessionRounds}`, "", ...lines].join("\n") }],
        details: { items: st.items, config: st.config, sessionRounds: st.sessionRounds },
      };
    },
    renderCall(_args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("long_attention_list_ps()")));
      return text;
    },
  });

  pi.registerTool({
    name: "long_attention_clear_ps",
    label: "Long Attention Clear PS",
    description: "清空或按 expires 清理长程注意力 PS。",
    promptSnippet: "Clear Runtime PS reminders",
    promptGuidelines: ["Do not clear project/persistent PS without a clear reason or user request."],
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ description: "all|turn|task|phase|session|project|persistent，默认 all" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const scope = String(params.scope ?? "all");
      const before = st.items.length;
      if (scope === "all") st.items.length = 0;
      else st.items = st.items.filter((it) => it.expires !== scope);
      return { content: [{ type: "text", text: `🧠 已清理 ${before - st.items.length} 条 PS，剩余 ${st.items.length} 条` }], details: { cleared: before - st.items.length } };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`long_attention_clear_ps(${args.scope ?? "all"})`)));
      return text;
    },
  });

  pi.registerTool({
    name: "long_attention_config_ps",
    label: "Long Attention Config PS",
    description: "查看或调整长程注意力 PS 注入配置。",
    promptSnippet: "Get or set Runtime PS config",
    promptGuidelines: ["Valid keys: maxPsPerTurn, maxItems, maxCharsPerItem, cooldownRounds, injectLowPriority."],
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: "配置项名" })),
      value: Type.Optional(Type.Any({ description: "新值" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.key) return { content: [{ type: "text", text: `🧠 PS 配置\n${JSON.stringify(st.config, null, 2)}` }] };
      const key = String(params.key) as keyof PsConfig;
      if (!(key in st.config)) return { content: [{ type: "text", text: `❌ 未知配置: ${params.key}` }] };
      const old = st.config[key];
      let next: unknown = params.value;
      if (typeof old === "number") next = Math.max(0, Number(next));
      if (typeof old === "boolean") next = next === true || next === "true";
      (st.config as Record<string, unknown>)[key] = next;
      if (key === "maxItems") while (st.items.length > st.config.maxItems) evictOne(st);
      if (key === "maxCharsPerItem") for (const it of st.items) it.message = trimText(it.message, st.config.maxCharsPerItem);
      return { content: [{ type: "text", text: `✅ ${key}: ${old} → ${next}` }], details: { key, old, next } };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`long_attention_config_ps(${args.key ?? "?"})`)));
      return text;
    },
  });

  pi.registerCommand("ps", {
    description: "长程注意力 PS 管理: /ps add|list|clear|config ...",
    handler: async (args, ctx) => {
      const sub = args._?.[0] ?? "list";
      switch (sub) {
        case "add": {
          const message = args._?.slice(1).join(" ") || args.text || "";
          if (!message.trim()) { ctx.ui.notify("用法: /ps add <内容> [--type=prior_decision] [--priority=high] [--expires=project]", "warning"); return; }
          const item = addPs(st, message, { type: parseType(args.type), priority: parsePriority(args.priority), expires: parseExpires(args.expires), source: "user" });
          updateStatus(ctx, st);
          ctx.ui.notify(`🧠 已添加 PS[${item.priority}][${item.type}]: ${item.message}`, "info");
          break;
        }
        case "list": {
          if (st.items.length === 0) { ctx.ui.notify("长程 PS 为空", "info"); return; }
          ctx.ui.notify([`🧠 长程 PS (${st.items.length}/${st.config.maxItems})`, ...st.items.map((it, i) => `  ${i + 1}. PS[${it.priority}][${it.type}][${it.expires}] used=${it.usedCount}: ${it.message}`)].join("\n"), "info");
          break;
        }
        case "clear": {
          const scope = String(args._?.[1] ?? "all");
          const before = st.items.length;
          if (scope === "all") st.items.length = 0;
          else st.items = st.items.filter((it) => it.expires !== scope);
          updateStatus(ctx, st);
          ctx.ui.notify(`🧠 已清理 ${before - st.items.length} 条 PS`, "info");
          break;
        }
        case "config":
          ctx.ui.notify(`🧠 PS 配置\n${JSON.stringify(st.config, null, 2)}`, "info");
          break;
        default:
          ctx.ui.notify("用法: /ps add|list|clear|config", "warning");
      }
    },
  });

  pi.on("context", (event, _ctx) => {
    const existingIdx = event.messages.findIndex((m) => typeof m.content === "string" && m.content.startsWith(MARKER));
    const selected = selectPs(st);

    if (selected.length === 0) {
      if (existingIdx >= 0) {
        const cleaned = [...event.messages];
        cleaned.splice(existingIdx, 1);
        return { messages: cleaned };
      }
      return;
    }

    for (const it of selected) {
      it.usedCount++;
      it.lastInjectedAt = st.sessionRounds;
    }

    const currentText = formatPs(st, selected);
    const cleaned = existingIdx >= 0
      ? [...event.messages.slice(0, existingIdx), ...event.messages.slice(existingIdx + 1)]
      : [...event.messages];

    cleaned.push({ role: "user", content: currentText } as any);
    return { messages: cleaned };
  });

  pi.on("message_end", (_event, ctx) => {
    if (!st.calibrated) st.calibrated = true;
    st.sessionRounds++;
    clearExpiredTurnItems(st);
    updateStatus(ctx, st);
  });
}
