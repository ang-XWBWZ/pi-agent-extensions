/**
 * confirm-dialog.ts — 确认弹窗助手（主 Agent / 子 Agent 双路径）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestConfirm, requestInput } from "../lib/confirm-bus.js";
import { wildcardMatch, guessPathPattern, guessCmdPattern } from "./path-guard.js";

export async function showConfirm(
  ctx: ExtensionContext,
  label: string,
  options: string[],
  isSubAgent: boolean,
): Promise<string | undefined> {
  if (isSubAgent) return requestConfirm("path", label, "", options);
  return ctx.ui.select(label, options);
}

export async function showBashConfirm(
  ctx: ExtensionContext,
  modeLabel: string,
  cmd: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no" | "edit"> {
  const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  const label = "Bash 确认 [" + modeLabel + "]  —  " + short;
  const options = ["允许本次", "始终允许此模式", "编辑后执行", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("bash", label, cmd, options);
    if (choice === "允许本次") return "yes";
    if (choice === "阻止" || choice === undefined) return "no";
    if (choice === "编辑后执行") return "edit";
    return "always";
  }

  const choice = await ctx.ui.select(label, options);
  if (choice === "允许本次") return "yes";
  if (choice === "阻止" || choice === undefined) return "no";
  if (choice === "编辑后执行") return "edit";
  return "always";
}

export async function showPathConfirm(
  ctx: ExtensionContext,
  label: string,
  path: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no"> {
  const short = path.length > 80 ? "..." + path.slice(-77) : path;
  const title = label + " 确认  —  " + short;
  const options = ["允许本次", "始终允许此路径", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("path", title, path, options);
    if (choice === "允许本次") return "yes";
    if (choice === "始终允许此路径") return "always";
    return "no";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "允许本次") return "yes";
  if (choice === "始终允许此路径") return "always";
  return "no";
}

export async function confirmAndRemember(
  ctx: ExtensionContext,
  allowlist: Set<string>,
  type: "path" | "bash",
  label: string,
  target: string,
  isSubAgent: boolean,
  onEdit?: (edited: string) => boolean,
): Promise<"dialog" | "silent" | false> {
  for (const pattern of allowlist) {
    if (wildcardMatch(pattern, target)) return "silent";
  }

  let action: "yes" | "always" | "no" | "edit";

  if (type === "bash") {
    action = await showBashConfirm(ctx, label, target, isSubAgent);
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
    action = await showPathConfirm(ctx, label, target, isSubAgent);
  }

  if (action === "yes") return "dialog";
  if (action === "no") return false;

  if (action === "always") {
    const pattern = type === "path" ? guessPathPattern(target) : guessCmdPattern(target);
    allowlist.add(pattern);
    ctx.ui.notify("已记住: " + pattern, "info");
    return "dialog";
  }

  return false;
}
