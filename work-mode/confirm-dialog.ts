/**
 * confirm-dialog.ts — 确认弹窗助手（主 Agent / 子 Agent 双路径）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestConfirm, requestInput } from "../lib/confirm-bus.js";
import { wildcardMatch, guessPathPattern, guessCmdPattern } from "./path-guard.js";

export interface RejectionDecision {
  rejected: true;
  reason: string;
}

export type ConfirmationResult = "dialog" | "silent" | false | RejectionDecision;

type ConfirmationChoice =
  | "yes"
  | "always"
  | "no"
  | "edit"
  | RejectionDecision;

function shortPurpose(purpose: string | undefined): string {
  const value = purpose?.replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > 180 ? value.slice(0, 177) + "..." : value;
}

async function rejectionChoice(
  ctx: ExtensionContext,
  isSubAgent: boolean,
): Promise<RejectionDecision> {
  const reason = isSubAgent
    ? await requestInput("拒绝原因（必填）", "请说明为什么拒绝此审批")
    : await ctx.ui.input("拒绝原因（必填）", "请说明为什么拒绝此审批");
  return {
    rejected: true,
    reason: reason?.trim() || "审批人拒绝，但未提供具体原因",
  };
}

export async function showActionConfirm(
  ctx: ExtensionContext,
  kind: "command" | "action",
  label: string,
  target: string,
  purpose: string | undefined,
  isSubAgent: boolean,
  allowRemember = true,
): Promise<ConfirmationChoice> {
  const short = target.length > 100 ? target.slice(0, 97) + "..." : target;
  const purposeText = shortPurpose(purpose);
  const title = `${label}  —  ${short}${purposeText ? `\n用途: ${purposeText}` : ""}`;
  const options =
    kind === "command"
      ? allowRemember
        ? ["仅允许本次", "始终允许同类命令", "编辑后执行", "拒绝并说明原因"]
        : ["仅允许本次", "编辑后执行", "拒绝并说明原因"]
      : allowRemember
        ? ["仅允许本次", "始终允许此操作", "拒绝并说明原因"]
        : ["仅允许本次", "拒绝并说明原因"];

  if (isSubAgent) {
    const choice = await requestConfirm("bash", title, target, options);
    if (choice === "仅允许本次") return "yes";
    if (choice === "拒绝并说明原因") return rejectionChoice(ctx, true);
    if (choice === "阻止") return "no";
    if (choice === undefined) return "no";
    if (choice === "编辑后执行") return "edit";
    return "always";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "仅允许本次") return "yes";
  if (choice === "拒绝并说明原因") return rejectionChoice(ctx, false);
  if (choice === "阻止") return "no";
  if (choice === undefined) return "no";
  if (choice === "编辑后执行") return "edit";
  return "always";
}

export async function showPathConfirm(
  ctx: ExtensionContext,
  label: string,
  path: string,
  purpose: string | undefined,
  isSubAgent: boolean,
  allowRemember = true,
): Promise<ConfirmationChoice> {
  const short = path.length > 80 ? "..." + path.slice(-77) : path;
  const purposeText = shortPurpose(purpose);
  const title = label + " 确认  —  " + short + (purposeText ? `\n用途: ${purposeText}` : "");
  const options = allowRemember
    ? ["仅允许本次", "始终允许此路径", "拒绝并说明原因"]
    : ["仅允许本次", "拒绝并说明原因"];

  if (isSubAgent) {
    const choice = await requestConfirm("path", title, path, options);
    if (choice === "仅允许本次") return "yes";
    if (choice === "始终允许此路径") return "always";
    if (choice === "拒绝并说明原因") return rejectionChoice(ctx, true);
    if (choice === "阻止") return "no";
    return "no";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "仅允许本次") return "yes";
  if (choice === "始终允许此路径") return "always";
  if (choice === "拒绝并说明原因") return rejectionChoice(ctx, false);
  if (choice === "阻止") return "no";
  return "no";
}

export interface AutoFlashFallbackResult {
  action: "allow" | "deny";
  reason?: string;
  timeout?: boolean;
}

export async function showAutoFlashFallbackConfirm(
  ctx: ExtensionContext,
  request: {
    command: string;
    toolName?: string;
    purpose?: string;
  },
  review: {
    reason: string;
    modelRef?: string;
  },
  isSubAgent: boolean,
  timeoutMs = 10_000,
): Promise<AutoFlashFallbackResult> {
  const shortTarget = request.command.length > 120
    ? request.command.slice(0, 117) + "..."
    : request.command;
  const toolName = request.toolName ?? "工具/命令";
  const purposeText = shortPurpose(request.purpose);
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));

  const title = [
    `⚠️ AI 自动审批已拦截 [${toolName}]${review.modelRef ? ` (${review.modelRef})` : ""}`,
    `目标: ${shortTarget}`,
    `AI 拒绝原因: ${review.reason}`,
    ...(purposeText ? [`用途: ${purposeText}`] : []),
    `⏳ 倒计时 ${seconds}s: 超时未响应将自动拒绝并继续执行任务`,
  ].join("\n");

  const options = ["仅允许本次 (推翻AI拦截)", "确认拒绝 (立即终止本次调用)"];

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
  });

  const promptPromise = (async () => {
    try {
      if (isSubAgent) {
        return await requestConfirm("bash", title, request.command, options, timeoutMs);
      }
      return await ctx.ui.select(title, options, { timeout: timeoutMs });
    } catch {
      return undefined;
    }
  })();

  const choice = await Promise.race([promptPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (choice === "仅允许本次 (推翻AI拦截)") {
    ctx.ui.notify("已由人工推翻 AI 拦截，允许本次调用执行", "info");
    return { action: "allow" };
  }

  if (choice === "__timeout__" || choice === undefined) {
    ctx.ui.notify(`人工审核已超时（${seconds}s），按 AI 审查意见自动拒绝`, "warning");
    return {
      action: "deny",
      reason: `AUTO_FLASH 拒绝：${review.reason}（人工审核超时${seconds}s自动拒绝）`,
      timeout: true,
    };
  }

  return {
    action: "deny",
    reason: `AUTO_FLASH 拒绝：${review.reason}（经人工审核确认拒绝）`,
    timeout: false,
  };
}

export async function confirmAndRemember(
  ctx: ExtensionContext,
  allowlist: Set<string>,
  type: "path" | "command" | "action",
  label: string,
  target: string,
  purpose: string | undefined,
  isSubAgent: boolean,
  onEdit?: (edited: string) => boolean,
  allowRemember = true,
): Promise<ConfirmationResult> {
  if (allowRemember) {
    for (const pattern of allowlist) {
      if (wildcardMatch(pattern, target)) return "silent";
    }
  }

  let action: ConfirmationChoice;

  if (type === "command" || type === "action") {
    action = await showActionConfirm(
      ctx,
      type,
      label,
      target,
      purpose,
      isSubAgent,
      allowRemember,
    );
    if (action === "edit" && onEdit) {
      if (isSubAgent) {
        const edited = await requestInput("编辑后执行 (Enter确认/Esc取消)", target);
        if (edited && edited.trim()) {
          onEdit(edited.trim());
          return "dialog";
        }
        return false;
      }
      const edited = await ctx.ui.editor("编辑后执行 (Esc 取消)", target);
      if (edited && edited.trim()) {
        onEdit(edited.trim());
        return "dialog";
      }
      return false;
    }
  } else {
    action = await showPathConfirm(
      ctx,
      label,
      target,
      purpose,
      isSubAgent,
      allowRemember,
    );
  }

  if (typeof action === "object") return action;
  if (action === "yes") return "dialog";
  if (action === "no") return false;

  if (action === "always") {
    const pattern =
      type === "path"
        ? guessPathPattern(target)
        : type === "command"
          ? guessCmdPattern(target)
          : target;
    allowlist.add(pattern);
    ctx.ui.notify("已记住: " + pattern, "info");
    return "dialog";
  }

  return false;
}
