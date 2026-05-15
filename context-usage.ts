/**
 * /context — 快速统计上下文窗口占用
 *
 * 以浮层组件完整展示 token 占用明细，按 Escape/Enter 关闭。
 * 不发送任何消息，不污染对话上下文。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey, Key, type Component } from "@earendil-works/pi-tui";

// ---- helpers ----

function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x2000) tokens += 1 / 1.5;
    else if (char === " " || char === "\n" || char === "\t") tokens += 1 / 6;
    else tokens += 1 / 3.5;
  }
  return Math.round(tokens);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function pct(part: number, total: number): string {
  if (total <= 0) return " 0.0%";
  return ((part / total) * 100).toFixed(1).padStart(5) + "%";
}

function extractXmlBlock(text: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return "";
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return "";
  return text.slice(start + open.length, end);
}

// ---- 浮层组件 ----

/** 一个只读文本面板，Escape/Enter 关闭 */
class ContextPanel implements Component {
  private text: Text;
  private box: Box;
  private onClose: () => void;

  constructor(content: string, onClose: () => void) {
    this.onClose = onClose;
    this.text = new Text(content, 2, 1);
    this.box = new Box(0, 0);
    this.box.addChild(this.text);
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.onClose();
    }
  }

  invalidate(): void {
    this.box.invalidate();
  }
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "显示上下文窗口占用统计（浮层，Escape/Enter 关闭）",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const systemPrompt = ctx.getSystemPrompt();

      if (!usage || usage.tokens === null) {
        ctx.ui.notify("暂无上下文统计（新会话或尚未收到模型用量响应）", "warning");
        return;
      }

      const cw = usage.contextWindow;

      // --- 解析各部分 ---
      const skillsBlock = extractXmlBlock(systemPrompt, "available_skills");
      const skillsTok = estimateTokens(skillsBlock);

      const openTag = "<available_skills>";
      const closeTag = "</available_skills>";
      const si = systemPrompt.indexOf(openTag);
      const ei = systemPrompt.indexOf(closeTag, si);
      const sysNoSkills =
        si !== -1 && ei !== -1
          ? systemPrompt.slice(0, si) + systemPrompt.slice(ei + closeTag.length)
          : systemPrompt;
      const baseSysTok = estimateTokens(sysNoSkills);

      const total = usage.tokens!;
      const totalPct = usage.percent;
      const userCtxTok = Math.max(0, total - baseSysTok - skillsTok);
      const estTotal = baseSysTok + skillsTok + userCtxTok;

      // --- 构建内容 ---
      const content = [
        "📊 上下文统计",
        "",
        `总用量      ${String(fmt(total)).padStart(6)} / ${String(fmt(cw)).padStart(6)} tokens   ${String(totalPct?.toFixed(1) ?? "??").padStart(5)}%`,
        "",
        "── 明细 ────────────────────",
        "",
        `System     ${String(fmt(baseSysTok)).padStart(6)} tokens   ${pct(baseSysTok, cw)}`,
        `Skills     ${String(fmt(skillsTok)).padStart(6)} tokens   ${pct(skillsTok, cw)}`,
        `用户上下文  ${String(fmt(userCtxTok)).padStart(6)} tokens   ${pct(userCtxTok, cw)}`,
        "",
        `合计(估算) ${String(fmt(estTotal)).padStart(6)} tokens   ${pct(estTotal, cw)}`,
        `模型报告   ${String(fmt(total)).padStart(6)} tokens   ${pct(total, cw)}`,
        "",
        "按 Escape / Enter 关闭",
      ].join("\n");

      // 浮层显示
      await ctx.ui.custom<undefined>(
        (_tui, _theme, _keybindings, done) => {
          return new ContextPanel(content, () => done(undefined));
        },
        { overlay: true },
      );
    },
  });
}
