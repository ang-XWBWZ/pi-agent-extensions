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
type PsPhase = "hot" | "warm" | "cold" | "archived";
type PsMode = "silent" | "visible";

interface PsItem {
  id: string;
  message: string;
  type: PsType;
  priority: PsPriority;
  expires: PsExpires;
  source: PsSource;
  createdAt: number;
  createdRound: number;
  lastInjectedAt: number;
  usedCount: number;
  phase: PsPhase;
  mode: PsMode;
  keywords: string[];
  enabled: boolean;
}

interface PsConfig {
  maxPsPerTurn: number;
  maxItems: number;
  maxCharsPerItem: number;
  cooldownRounds: number;
  injectLowPriority: boolean;
  minScore: number;
  enableRelevance: boolean;
  hotRounds: number;
  warmRounds: number;
}

interface PsState {
  items: PsItem[];
  config: PsConfig;
  sessionRounds: number;
  calibrated: boolean;
  configVersion: number;
}

const MARKER = "[long-attention-ps]";
const STATE_KEY = "__pi_long_attention_ps";
const CONFIG_VERSION = 2;

const DEFAULT_CONFIG: PsConfig = {
  maxPsPerTurn: 1,
  maxItems: 16,
  maxCharsPerItem: 140,
  cooldownRounds: 6,
  injectLowPriority: false,
  minScore: 14,
  enableRelevance: true,
  hotRounds: 3,
  warmRounds: 12,
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

const PHASE_FACTOR: Record<PsPhase, number> = {
  hot: 1.0,
  warm: 0.55,
  cold: 0.35,
  archived: 0,
};

let idCounter = 0;

function loadState(): PsState {
  const raw = (globalThis as Record<string, unknown>)[STATE_KEY] as PsState | undefined;
  if (raw) {
    const legacyVersion = raw.configVersion ?? 1;
    raw.config = { ...DEFAULT_CONFIG, ...(raw.config ?? {}) };
    if (legacyVersion < CONFIG_VERSION) {
      raw.config.maxPsPerTurn = Math.min(raw.config.maxPsPerTurn, DEFAULT_CONFIG.maxPsPerTurn);
      raw.config.maxItems = Math.min(raw.config.maxItems, DEFAULT_CONFIG.maxItems);
      raw.config.maxCharsPerItem = Math.min(raw.config.maxCharsPerItem, DEFAULT_CONFIG.maxCharsPerItem);
      raw.config.cooldownRounds = Math.max(raw.config.cooldownRounds, DEFAULT_CONFIG.cooldownRounds);
      raw.config.minScore = DEFAULT_CONFIG.minScore;
      raw.config.enableRelevance = DEFAULT_CONFIG.enableRelevance;
      raw.config.hotRounds = DEFAULT_CONFIG.hotRounds;
      raw.config.warmRounds = DEFAULT_CONFIG.warmRounds;
      raw.configVersion = CONFIG_VERSION;
    }
    raw.items ??= [];
    raw.sessionRounds ??= 0;
    raw.calibrated ??= false;
    for (const it of raw.items) {
      it.message = trimText(it.message, raw.config.maxCharsPerItem);
      it.lastInjectedAt ??= -999_999;
      it.usedCount ??= 0;
      it.enabled ??= true;
      it.createdRound ??= Math.max(0, raw.sessionRounds - it.usedCount);
      it.phase = parsePhase((it as Partial<PsItem>).phase ?? inferInitialPhase(it.type, it.priority, it.expires));
      it.mode = parseMode((it as Partial<PsItem>).mode);
      it.keywords = Array.isArray((it as Partial<PsItem>).keywords)
        ? (it as Partial<PsItem>).keywords!.filter((x): x is string => typeof x === "string")
        : extractKeywords(it.message);
    }
    while (raw.items.length > raw.config.maxItems) evictOne(raw);
    return raw;
  }

  const fresh: PsState = {
    items: [],
    config: { ...DEFAULT_CONFIG },
    sessionRounds: 0,
    calibrated: false,
    configVersion: CONFIG_VERSION,
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

function inferInitialPhase(type: PsType, priority: PsPriority, expires: PsExpires): PsPhase {
  if (expires === "turn" || type === "open_loop" || type === "risk_memory" || type === "task_state") return "hot";
  if (priority === "critical" || priority === "high" || type === "project_constraint" || type === "prior_decision") return "warm";
  if (expires === "persistent" || type === "user_preference" || type === "environment_fact") return "cold";
  return "warm";
}

function extractKeywords(message: string): string[] {
  const text = message.toLowerCase();
  const kws = new Set<string>();
  const pairs: Array<[RegExp, string]> = [
    [/\bwsl\b|linux|ubuntu/, "wsl"],
    [/windows|powershell|cmd\.exe|\bcmd\b/, "windows"],
    [/git|commit|push|stash|branch|merge/, "git"],
    [/部署|deploy|copy|复制|安装|reload|重载/, "deploy"],
    [/测试|test|check|校验|verify|验证/, "test"],
    [/删除|delete|remove|清理|clear|覆盖|overwrite/, "destructive"],
    [/provider|供应商|openai|anthropic|模型/, "provider"],
    [/parallel-agent|sub-agent|子\s*agent|子进程|通信|结果汇报/, "parallel-agent"],
    [/wiki|知识库|语义搜索|semantic/, "wiki"],
    [/计划|plan|work|需求|requirements/, "workflow"],
  ];
  for (const [re, kw] of pairs) if (re.test(text)) kws.add(kw);
  return [...kws];
}

function parsePhase(raw: unknown): PsPhase {
  const s = String(raw ?? "");
  return (["hot", "warm", "cold", "archived"] as string[]).includes(s) ? s as PsPhase : "warm";
}

function parseMode(raw: unknown): PsMode {
  const s = String(raw ?? "silent");
  return s === "visible" ? "visible" : "silent";
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
  options: Partial<Pick<PsItem, "type" | "priority" | "expires" | "source" | "phase" | "mode" | "keywords">> = {},
): PsItem {
  const type = options.type ?? "note";
  const priority = options.priority ?? "medium";
  const expires = options.expires ?? "task";
  const messageText = trimText(message, st.config.maxCharsPerItem);
  const item: PsItem = {
    id: nextId(),
    message: messageText,
    type,
    priority,
    expires,
    source: options.source ?? "agent",
    createdAt: Date.now(),
    createdRound: st.sessionRounds,
    lastInjectedAt: -999_999,
    usedCount: 0,
    phase: options.phase ?? inferInitialPhase(type, priority, expires),
    mode: options.mode ?? "silent",
    keywords: options.keywords ?? extractKeywords(messageText),
    enabled: true,
  };
  st.items.push(item);
  while (st.items.length > st.config.maxItems) evictOne(st);
  return item;
}

function clearExpiredTurnItems(st: PsState): void {
  st.items = st.items.filter((it) => it.expires !== "turn");
}

// critical 优先级的 PS 每轮最多注入 4 轮（防止永生占据对话上下文）
const MAX_CRITICAL_INJECTIONS = 4;

function isCoolingDown(st: PsState, it: PsItem): boolean {
  if (it.priority === "critical") {
    // critical 永不冷却，但有限注入次数上限
    return it.usedCount >= MAX_CRITICAL_INJECTIONS;
  }
  return st.sessionRounds - it.lastInjectedAt < st.config.cooldownRounds;
}

function recentContextText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages
    .slice(-8)
    .map((m) => typeof m.content === "string" && !m.content.startsWith(MARKER) ? m.content : "")
    .join("\n")
    .toLowerCase();
}

function relevanceScore(st: PsState, it: PsItem, contextText: string): number {
  if (!st.config.enableRelevance) return 1;
  if (it.expires === "turn" || it.phase === "hot") return 1;
  if (it.keywords.length === 0) return it.priority === "critical" ? 0.75 : 0.35;
  const hits = it.keywords.filter((kw) => contextText.includes(kw)).length;
  if (hits === 0) return it.phase === "cold" ? 0.15 : 0.35;
  return Math.min(1.2, 0.65 + hits * 0.25);
}

function ageDecay(st: PsState, it: PsItem): number {
  const age = Math.max(0, st.sessionRounds - it.createdRound);
  if (it.phase === "hot") return age <= st.config.hotRounds ? 1 : 0.75;
  if (it.phase === "warm") return age <= st.config.warmRounds ? 0.75 : 0.45;
  if (it.phase === "cold") return 1;
  return 0;
}

function frequencyDecay(it: PsItem): number {
  return 1 / (1 + it.usedCount * 0.75);
}

function scoreItem(st: PsState, it: PsItem, contextText: string): number {
  if (!it.enabled || it.phase === "archived") return -Infinity;
  if (!st.config.injectLowPriority && it.priority === "low") return -Infinity;
  if (isCoolingDown(st, it)) return -Infinity;

  const base = PRIORITY_WEIGHT[it.priority] * 10 + TYPE_WEIGHT[it.type] * 3;
  const relevance = relevanceScore(st, it, contextText);
  const phase = PHASE_FACTOR[it.phase];
  const age = ageDecay(st, it);
  const freq = frequencyDecay(it);
  let score = base * relevance * phase * age * freq;

  if (it.expires === "turn") score += 12;
  if (it.expires === "project" && relevance >= 0.65) score += 4;
  if (it.expires === "persistent" && relevance >= 0.65) score += 3;
  if (it.priority === "critical" && relevance >= 0.35) score += 10;
  return score;
}

function selectPs(st: PsState, contextText: string): PsItem[] {
  return st.items
    .map((item) => ({ item, score: scoreItem(st, item, contextText) }))
    .filter((c) => Number.isFinite(c.score) && c.score >= st.config.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, st.config.maxPsPerTurn)
    .map((c) => c.item);
}

function formatPs(st: PsState, selected: PsItem[]): string {
  const visible = selected.filter((it) => it.mode === "visible");
  const silent = selected.filter((it) => it.mode !== "visible");
  const lines = [
    ...silent.map((it) => `SILENT-PS[${it.phase}][${it.priority}][${it.type}]: ${it.message}`),
    ...visible.map((it) => `PS[${it.phase}][${it.priority}][${it.type}]: ${it.message}`),
  ];
  return [
    `${MARKER} Runtime PS (${selected.length}/${st.config.maxPsPerTurn})`,
    "默认把 SILENT-PS 当作内部约束/偏好，只影响行动，不要在回复中复述；visible PS 才可按需说明。",
    ...lines,
  ].join("\n");
}

function coolDownAfterInject(st: PsState, it: PsItem): void {
  it.usedCount++;
  it.lastInjectedAt = st.sessionRounds;
  if (it.phase === "hot" && (it.usedCount >= 2 || st.sessionRounds - it.createdRound > st.config.hotRounds)) {
    it.phase = "warm";
  } else if (it.phase === "warm" && (it.usedCount >= 4 || st.sessionRounds - it.createdRound > st.config.warmRounds)) {
    it.phase = "cold";
  }
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
      "Use when: a stable constraint, user preference, prior decision, rejected option, risk, or open loop must survive future turns.",
      "Do not use when: the information is just a current execution step, temporary search result, or generic advice.",
      "Phase policy: Plan may store confirmed decisions or unresolved blockers; Work may store durable risks or handoff state.",
      "Workflow: write one short actionable reminder with type, priority, and expiration; prefer expires=task/phase unless the decision is truly stable.",
      "Conflict policy: use manage_requirements for active requirement questions; use manage_plan for execution steps; use PS only for cross-turn reminders.",
      "Failure / fallback: if the reminder would be vague, do not store it.",
      "Use for compact, actionable reminders that should reappear across turns.",
      "Prefer high/critical only for explicit constraints, safety risks, or important prior decisions.",
      "Do not store generic advice. Each PS must be directly useful later.",
      "Use expires=turn/task for short-lived reminders; project/persistent for stable decisions/preferences.",
      "PS is silent by default: it should guide behavior, not be repeated in replies.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "PS 内容，必须短、具体、可行动" }),
      type: Type.Optional(Type.String({ description: "user_preference|project_constraint|prior_decision|open_loop|rejected_option|risk_memory|environment_fact|task_state|note" })),
      priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
      expires: Type.Optional(Type.String({ description: "turn|task|phase|session|project|persistent" })),
      phase: Type.Optional(Type.String({ description: "hot|warm|cold|archived（默认自动推断）" })),
      mode: Type.Optional(Type.String({ description: "silent|visible（默认 silent）" })),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "相关触发关键词；不传则自动从 message 推断" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const item = addPs(st, params.message, {
        type: parseType(params.type),
        priority: parsePriority(params.priority),
        expires: parseExpires(params.expires),
        phase: params.phase ? parsePhase(params.phase) : undefined,
        mode: parseMode(params.mode),
        keywords: Array.isArray(params.keywords) ? params.keywords.map(String).filter(Boolean) : undefined,
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
        const kws = it.keywords.length > 0 ? ` kw=${it.keywords.join(",")}` : "";
        return `  ${i + 1}. [${it.id}] PS[${it.phase}][${it.mode}][${it.priority}][${it.type}][${it.expires}]${off} used=${it.usedCount}${kws}: ${it.message}`;
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
    promptGuidelines: ["Valid keys: maxPsPerTurn, maxItems, maxCharsPerItem, cooldownRounds, injectLowPriority, minScore, enableRelevance, hotRounds, warmRounds."],
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
          if (!message.trim()) { ctx.ui.notify("用法: /ps add <内容> [--type=prior_decision] [--priority=high] [--expires=project] [--phase=warm] [--mode=silent]", "warning"); return; }
          const keywords = typeof args.keywords === "string"
            ? String(args.keywords).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;
          const item = addPs(st, message, {
            type: parseType(args.type),
            priority: parsePriority(args.priority),
            expires: parseExpires(args.expires),
            phase: args.phase ? parsePhase(args.phase) : undefined,
            mode: parseMode(args.mode),
            keywords,
            source: "user",
          });
          updateStatus(ctx, st);
          ctx.ui.notify(`🧠 已添加 PS[${item.priority}][${item.type}]: ${item.message}`, "info");
          break;
        }
        case "list": {
          if (st.items.length === 0) { ctx.ui.notify("长程 PS 为空", "info"); return; }
          ctx.ui.notify([`🧠 长程 PS (${st.items.length}/${st.config.maxItems})`, ...st.items.map((it, i) => `  ${i + 1}. PS[${it.phase}][${it.mode}][${it.priority}][${it.type}][${it.expires}] used=${it.usedCount}: ${it.message}`)].join("\n"), "info");
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
    const contextText = recentContextText(event.messages as Array<{ role?: string; content?: unknown }>);
    const selected = selectPs(st, contextText);

    if (selected.length === 0) {
      if (existingIdx >= 0) {
        const cleaned = [...event.messages];
        cleaned.splice(existingIdx, 1);
        return { messages: cleaned };
      }
      return;
    }

    for (const it of selected) {
      coolDownAfterInject(st, it);
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
