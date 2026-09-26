/**
 * token-stats.ts — 极简高级两行底栏与速率指示器
 *
 * 核心设计:
 * 1. 严格锁定 2 行极简仪表盘，彻底消除多余第三行；
 * 2. 补齐自定义供应商模型缺失的缓存读写 (R/W)、缓存命中率 (CH%)、累计成本 ($)；
 * 3. 实时速率 (t/s) 融入第 2 行左侧，纯文本展示绝无表情；
 * 4. 彻底移除【🧠最大】标志，将 AUTO 运行/拦截状态 (纯文本) 与右侧模型合并展示。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSpeedTracker } from "./lib/speed-tracker.js";
import { getAutoStatusSummary } from "./work-mode/auto-status.js";

/**
 * 格式化 Token 计数 (与官方原生保持一致)
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * 格式化工作目录显示 (优先用 ~ 替换 HOME 路径)
 */
export function formatCwdForFooter(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export interface FooterTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface FooterDataProviderLike {
  getGitBranch(): string | undefined;
  onBranchChange(listener: (branch: string | undefined) => void): () => void;
  getExtensionStatuses?(): Map<string, string>;
  getAvailableProviderCount?(): number;
}

/**
 * 构造严格的两行底栏内容
 */
export function buildTwoLineFooter(
  ctx: ExtensionContext,
  theme: FooterTheme,
  footerData: FooterDataProviderLike,
  width: number,
  speedLabel?: string,
  autoCompact = true,
  thinkingLevel?: string,
): string[] {
  // 1. 计算会话中所有条目的 Token 累计统计
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestCacheHitRate: number | undefined;

  const entries = ctx.sessionManager?.getEntries?.() || [];
  for (const entry of entries) {
    if (entry.type === "usage") {
      input += entry.usage?.input || 0;
      output += entry.usage?.output || 0;
      cacheRead += entry.usage?.cacheRead || 0;
      cacheWrite += entry.usage?.cacheWrite || 0;
      cost += entry.usage?.cost?.total || 0;
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      const u = entry.message.usage;
      if (u) {
        input += u.input || 0;
        output += u.output || 0;
        cacheRead += u.cacheRead || 0;
        cacheWrite += u.cacheWrite || 0;
        cost += u.cost?.total || 0;
        const promptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        if (promptTokens > 0 && (u.cacheRead || 0) > 0) {
          latestCacheHitRate = ((u.cacheRead || 0) / promptTokens) * 100;
        }
      }
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
      const u = entry.message.usage;
      input += u.input || 0;
      output += u.output || 0;
      cacheRead += u.cacheRead || 0;
      cacheWrite += u.cacheWrite || 0;
      cost += u.cost?.total || 0;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      const u = entry.usage;
      input += u.input || 0;
      output += u.output || 0;
      cacheRead += u.cacheRead || 0;
      cacheWrite += u.cacheWrite || 0;
      cost += u.cost?.total || 0;
    }
  }

  // 2. 获取上下文占用
  const contextUsage = ctx.getContextUsage?.();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent =
    contextUsage?.percent !== null && contextUsage?.percent !== undefined
      ? contextPercentValue.toFixed(1)
      : "?";

  // 3. 构造第一行: PWD + 分支 + 会话名
  const cwd = ctx.sessionManager?.getCwd?.() || ctx.cwd || process.cwd();
  let pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
  const branch = footerData?.getGitBranch?.();
  if (branch) {
    pwd = `${pwd} (${branch})`;
  }
  const sessionName = ctx.sessionManager?.getSessionName?.();
  if (sessionName) {
    pwd = `${pwd} • ${sessionName}`;
  }
  const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

  // 4. 构造第二行左侧统计
  const statsParts: string[] = [];
  if (input > 0) statsParts.push(`↑${formatTokens(input)}`);
  if (output > 0) statsParts.push(`↓${formatTokens(output)}`);
  if (cacheRead > 0) statsParts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite > 0) statsParts.push(`W${formatTokens(cacheWrite)}`);
  if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (cost > 0) {
    statsParts.push(`$${cost.toFixed(3)}`);
  }

  const autoCompactIndicator = autoCompact ? " (auto)" : "";
  const contextPercentDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}${autoCompactIndicator}`
      : `${contextPercent}%/${formatTokens(contextWindow)}${autoCompactIndicator}`;

  if (contextPercentValue > 90) {
    statsParts.push(theme.fg("error", contextPercentDisplay));
  } else if (contextPercentValue > 70) {
    statsParts.push(theme.fg("warning", contextPercentDisplay));
  } else {
    statsParts.push(contextPercentDisplay);
  }

  // 实时速率 (纯文本，绝不加表情)
  if (speedLabel) {
    statsParts.push(`· ${speedLabel}`);
  }

  let statsLeft = statsParts.join(" ");

  // 5. 构造第二行右侧: AUTO 状态与模型信息合并 (纯文本，彻底移除 🧠最大 等一切表情)
  let autoStatus: string | undefined;
  try {
    autoStatus = getAutoStatusSummary?.();
  } catch {
    // 忽略异常，降级处理
  }

  const modelName = ctx.model?.id || "no-model";
  let modelDesc = ctx.model?.provider ? `(${ctx.model.provider}) ${modelName}` : modelName;

  // 推理思考等级展示 (纯文本，例如 • max)
  if (ctx.model?.reasoning) {
    const think = thinkingLevel || "off";
    if (think && think !== "off") {
      modelDesc += ` • ${think}`;
    }
  }

  const rightSide = autoStatus ? `${autoStatus} · ${modelDesc}` : modelDesc;

  // 6. 左右对齐与自适应截断
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const minPadding = 2;
  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
  let statsLine = "";

  if (totalNeeded <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
    statsLine = statsLeft + padding + rightSide;
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
      statsLine = statsLeft + padding + truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }

  const dimStatsLeft = theme.fg("dim", statsLeft);
  const remainder = statsLine.slice(statsLeft.length);
  const dimRemainder = theme.fg("dim", remainder);

  // 严格只返回 2 行，彻底消灭第 3 行
  return [pwdLine, dimStatsLeft + dimRemainder];
}

export default function (pi: ExtensionAPI) {
  const tracker = getSpeedTracker();
  let activeTui: { requestRender: () => void } | null = null;

  function setupCustomFooter(ctx: ExtensionContext) {
    if (!ctx?.ui?.setFooter) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsub();
          if (activeTui === tui) {
            activeTui = null;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const speedLabel = tracker.formatStatusLabel();
          const thinkingLevel = pi.getThinkingLevel?.();
          return buildTwoLineFooter(
            ctx,
            theme,
            footerData,
            width,
            speedLabel,
            true,
            thinkingLevel,
          );
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    setupCustomFooter(ctx);
  });

  pi.on("message_start", (event) => {
    const role = (event as any).message?.role;
    if (role === "assistant") {
      tracker.startMessage("assistant");
      activeTui?.requestRender();
    }
  });

  pi.on("message_update", (event) => {
    const ame = (event as any).assistantMessageEvent;
    if (!ame) return;

    let deltaLen = 0;
    if (typeof ame.delta === "string") {
      deltaLen = ame.delta.length;
    } else if (ame.type === "text_delta" || ame.type === "thinking_delta") {
      deltaLen = typeof ame.delta === "string" ? ame.delta.length : 1;
    }

    const live = tracker.updateLiveProgress(deltaLen);
    if (live) {
      activeTui?.requestRender();
    }
  });

  pi.on("message_end", (event) => {
    const msg = (event as any).message;
    if (msg?.role === "assistant") {
      tracker.finishMessage(msg.usage);
      activeTui?.requestRender();
    }
  });
}
