/**
 * /context — 快速统计上下文窗口占用
 *
 * 以浮层组件完整展示 token 占用明细，按 Escape/Enter 关闭。
 * 不发送任何消息，不污染对话上下文。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey, Key, type Component } from "@earendil-works/pi-tui";

// ---- helpers ----

/** 粗略估算 token 数（1 token ≈ 4 英文字符 ≈ 1.5 中文字符） */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00) tokens += 1 / 1.5;        // CJK
    else if (char === " " || char === "\n") tokens += 1 / 6;
    else tokens += 1 / 4;                           // ASCII/其他
  }
  return Math.round(tokens);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function pct(part: number, total: number): string {
  if (total <= 0) return "  0.0%";
  return ((part / total) * 100).toFixed(1).padStart(6) + "%";
}

/** 从 system prompt 中提取 <available_skills> 块 */
function extractSkillsBlock(systemPrompt: string): string {
  const match = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
  return match ? match[1] : "";
}

// ---- 浮层组件 ----

class ContextPanel implements Component {
  private text: Text;
  private box: Box;

  constructor(content: string, private onClose: () => void) {
    this.text = new Text(content, 2, 1);
    this.box = new Box(0, 0);
    this.box.addChild(this.text);
  }

  render(width: number): string[] {
    return this.box.render(Math.max(width, 40));
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
      const total = usage.tokens;
      const totalPct = usage.percent;

      // --- 解析各部分 ---
      const skillsBlock = extractSkillsBlock(systemPrompt);
      const skillsTok = estimateTokens(skillsBlock);

      // System = 完整 system prompt 去掉 skills 块后的 token 估计
      const sysNoSkills = systemPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/, "");
      const baseSysTok = estimateTokens(sysNoSkills);

      const userCtxTok = Math.max(0, total - baseSysTok - skillsTok);
      const estTotal = baseSysTok + skillsTok + userCtxTok;

      // --- 构建内容 ---
      const content = [
        "\u{1F4CA} 上下文统计",
        "",
        `总用量      ${fmt(total).padStart(6)} / ${fmt(cw).padStart(6)} tokens   ${totalPct?.toFixed(1) ?? "??"}%`,
        "",
        "\u2500\u2500 明细 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
        "",
        `System      ${fmt(baseSysTok).padStart(6)} tokens  ${pct(baseSysTok, cw)}`,
        `Skills      ${fmt(skillsTok).padStart(6)} tokens  ${pct(skillsTok, cw)}`,
        `用户上下文   ${fmt(userCtxTok).padStart(6)} tokens  ${pct(userCtxTok, cw)}`,
        "",
        `合计(估算)  ${fmt(estTotal).padStart(6)} tokens  ${pct(estTotal, cw)}`,
        `模型报告    ${fmt(total).padStart(6)} tokens  ${pct(total, cw)}`,
        "",
        "Esc / Enter 关闭",
      ].join("\n");

      await ctx.ui.custom<undefined>(
        (_tui, _theme, _keybindings, done) => {
          return new ContextPanel(content, () => done(undefined));
        },
        { overlay: true },
      );
    },
  });
}
