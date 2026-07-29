/**
 * confirm-dialog.ts — 确认弹窗助手（主 Agent / 子 Agent 双路径）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestConfirm, requestInput } from "../lib/confirm-bus.js";
import { wildcardMatch, guessPathPattern, guessCmdPattern } from "./path-guard.js";

export async function showActionConfirm(
  ctx: ExtensionContext,
  kind: "command" | "action",
  label: string,
  target: string,
  isSubAgent: boolean,
  allowRemember = true,
): Promise<"yes" | "always" | "no" | "edit"> {
  const short = target.length > 100 ? target.slice(0, 97) + "..." : target;
  const title = `${label}  —  ${short}`;
  const options =
    kind === "command"
      ? allowRemember
        ? ["仅允许本次", "始终允许同类命令", "编辑后执行", "阻止"]
        : ["仅允许本次", "编辑后执行", "阻止"]
      : allowRemember
        ? ["仅允许本次", "始终允许此操作", "阻止"]
        : ["仅允许本次", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("bash", title, target, options);
    if (choice === "仅允许本次") return "yes";
    if (choice === "阻止" || choice === undefined) return "no";
    if (choice === "编辑后执行") return "edit";
    return "always";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "仅允许本次") return "yes";
  if (choice === "阻止" || choice === undefined) return "no";
  if (choice === "编辑后执行") return "edit";
  return "always";
}

export async function showPathConfirm(
  ctx: ExtensionContext,
  label: string,
  path: string,
  isSubAgent: boolean,
  allowRemember = true,
): Promise<"yes" | "always" | "no"> {
  const short = path.length > 80 ? "..." + path.slice(-77) : path;
  const title = label + " 确认  —  " + short;
  const options = allowRemember
    ? ["仅允许本次", "始终允许此路径", "阻止"]
    : ["仅允许本次", "阻止"];

  if (isSubAgent) {
    const choice = await requestConfirm("path", title, path, options);
    if (choice === "仅允许本次") return "yes";
    if (choice === "始终允许此路径") return "always";
    return "no";
  }

  const choice = await ctx.ui.select(title, options);
  if (choice === "仅允许本次") return "yes";
  if (choice === "始终允许此路径") return "always";
  return "no";
}

export async function confirmAndRemember(
  ctx: ExtensionContext,
  allowlist: Set<string>,
  type: "path" | "command" | "action",
  label: string,
  target: string,
  isSubAgent: boolean,
  onEdit?: (edited: string) => boolean,
  allowRemember = true,
): Promise<"dialog" | "silent" | false> {
  if (allowRemember) {
    for (const pattern of allowlist) {
      if (wildcardMatch(pattern, target)) return "silent";
    }
  }

  let action: "yes" | "always" | "no" | "edit";

  if (type === "command" || type === "action") {
    action = await showActionConfirm(
      ctx,
      type,
      label,
      target,
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
      isSubAgent,
      allowRemember,
    );
  }

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
