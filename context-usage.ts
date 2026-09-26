/**
 * /context — 快速统计上下文窗口占用
 *
 * 以浮层组件完整展示 token 占用明细，按 Escape/Enter 关闭。
 * 不发送任何消息，不污染对话上下文。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens as estimatePiTokens } from "@earendil-works/pi-agent-core";
import { Box, Text, matchesKey, Key, type Component } from "@earendil-works/pi-tui";
import { getSpeedTracker } from "./lib/speed-tracker.js";

// ---- helpers ----

/** Keep the breakdown on Pi's native chars/4 estimator. */
function estimateTokens(text: string): number {
  return estimatePiTokens({ role: "user", content: text, timestamp: 0 } as any);
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

      // --- 速率统计 ---
      const tracker = getSpeedTracker();
      const latest = tracker.getLatestStats();
      const session = tracker.getSessionStats();

      const speedLines: string[] = [
        "",
        "\u2500\u2500 速率指标 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      ];

      if (latest) {
        const ttftStr = latest.ttftMs !== undefined ? `${latest.ttftMs} ms` : "-";
        const genDurStr = latest.genDurationMs !== undefined ? `${(latest.genDurationMs / 1000).toFixed(2)} s` : "-";
        const totDurStr = latest.totalDurationMs !== undefined ? `${(latest.totalDurationMs / 1000).toFixed(2)} s` : "-";
        const reasoningExtra = latest.reasoningTokens > 0 ? ` (思考: ${latest.reasoningTokens} tokens)` : "";

        speedLines.push(
          "",
          "最新轮次:",
          `  生成速率    ${latest.outputTps.toFixed(1).padStart(6)} tokens/s`,
          `  首字延迟    ${ttftStr.padStart(6)}`,
          `  生成耗时    ${genDurStr.padStart(6)}`,
          `  总计耗时    ${totDurStr.padStart(6)}`,
          `  本次输出    ${fmt(latest.outputTokens).padStart(6)} tokens${reasoningExtra}`,
        );

        if (session.totalTurns > 1) {
          speedLines.push(
            "",
            "会话累计:",
            `  累计输出    ${fmt(session.totalOutputTokens).padStart(6)} tokens`,
            `  平均速率    ${session.avgOutputTps.toFixed(1).padStart(6)} tokens/s`,
            `  统计轮次    ${String(session.totalTurns).padStart(6)} 轮`,
          );
        }
      } else {
        speedLines.push(
          "",
          "  暂无生成速率数据（等待模型响应）",
        );
      }

      // --- 构建内容 ---
      const content = [
        "上下文与速率统计",
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
        ...speedLines,
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
