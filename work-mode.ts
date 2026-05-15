/**
 * work-mode.ts — 工作模式扩展 (Plan / Work / YOLO)
 *
 * 纯程序控制，不注入 LLM 上下文。
 * 子 Agent 确认弹窗通过 confirm-bus 全局总线传递到主 session UI。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, isAbsolute } from "node:path";
import {
  requestConfirm,
  requestInput,
  registerBusUI,
  registerBusInput,
  type BusUI,
} from "./lib/confirm-bus.js";

type WorkMode = "plan" | "work" | "yolo";

interface ModeEntry {
  type: "custom";
  customType: "work-mode-state";
  data: { mode: WorkMode };
}

function wildcardMatch(pattern: string, target: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(target.trim());
}

function isUnder(base: string, target: string): boolean {
  const b = base.endsWith("\\") || base.endsWith("/") ? base : base + "\\";
  const t = isAbsolute(target) ? target : resolve(base, target);
  return t.toLowerCase().startsWith(b.toLowerCase());
}

function resolvePath(base: string, p: string): string {
  const clean = p.replace(/^@/, "");
  return isAbsolute(clean) ? clean : resolve(base, clean);
}

function guessPathPattern(raw: string): string {
  const abs = isAbsolute(raw) ? raw : raw;
  const parts = abs.split(/[\\/]/);
  if (parts.length <= 2) return abs + "\\*";
  return parts.slice(0, -1).join("\\") + "\\*";
}

function guessCmdPattern(raw: string): string {
  return raw
    .replace(/"[^"]*"/g, "*")
    .replace(/'[^']*'/g, "*")
    .replace(/\S+/g, (w) =>
      /^[a-zA-Z0-9_./:-]+$/.test(w) ? w : "*",
    );
}

// ---- confirm helpers ----

async function showConfirm(
  ctx: ExtensionContext,
  label: string,
  options: string[],
  isSubAgent: boolean,
): Promise<string | undefined> {
  if (isSubAgent) {
    return requestConfirm("path", label, "", options);
  }
  return ctx.ui.select(label, options);
}

async function showBashConfirm(
  ctx: ExtensionContext,
  modeLabel: string,
  cmd: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no" | "edit"> {
  const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  const label = `Bash 确认 [${modeLabel}]  —  ${short}`;
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

async function showPathConfirm(
  ctx: ExtensionContext,
  label: string,
  path: string,
  isSubAgent: boolean,
): Promise<"yes" | "always" | "no"> {
  const short = path.length > 80 ? "..." + path.slice(-77) : path;
  const title = `${label} 确认  —  ${short}`;
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

async function confirmAndRemember(
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
    ctx.ui.notify(`\u2705 已记住: ${pattern}`, "info");
    return "dialog";
  }

  return false;
}

// ---- extension ----

export default function (pi: ExtensionAPI) {
  let mode: WorkMode =
    ((globalThis as Record<string, unknown>).__pi_default_mode as WorkMode) ||
    "work";
  const isSubAgent = !!(
    (globalThis as Record<string, unknown>).__pi_is_sub_agent
  );
  delete (globalThis as Record<string, unknown>).__pi_default_mode;
  delete (globalThis as Record<string, unknown>).__pi_is_sub_agent;

  const pathAllowlist = new Set<string>();
  const cmdAllowlist = new Set<string>();
  const confirmedCalls = new Map<string, string>();

  // 主 session 注册总线 UI
  let unregBus: (() => void) | undefined;
  let unregInput: (() => void) | undefined;
  if (!isSubAgent) {
    pi.on("session_start", (_event, ctx) => {
      const busUI: BusUI = {
        select: (title, opts) => ctx.ui.select(title, opts),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        editor: (title, prefill) => ctx.ui.editor(title, prefill),
        notify: (msg, type) => ctx.ui.notify(msg, type as "info" | "warning" | "error"),
      };
      unregBus?.();
      unregInput?.();
      unregBus = registerBusUI(busUI);
      unregInput = registerBusInput(busUI);
    });
    pi.on("session_shutdown", () => {
      unregBus?.();
      unregInput?.();
    });
  }

  function persist(ctx: ExtensionContext) {
    pi.appendEntry("work-mode-state", { mode });
    ctx.ui.setStatus("work-mode", `MODE: ${mode.toUpperCase()}`);
  }

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as ModeEntry).customType === "work-mode-state"
      ) {
        mode = (entry as ModeEntry).data.mode;
      }
    }
    ctx.ui.setStatus("work-mode", `MODE: ${mode.toUpperCase()}`);
  });

  function switchMode(m: WorkMode, ctx: ExtensionContext) {
    mode = m;
    persist(ctx);
    const labels: Record<WorkMode, string> = {
      plan: "PLAN — read-only + bash/cmd confirm",
      work: "WORK — cwd free, outside confirm",
      yolo: "YOLO — unrestricted",
    };
    ctx.ui.notify(labels[m], "info");
  }

  pi.registerCommand("plan", { description: "PLAN", handler: (_a, ctx) => switchMode("plan", ctx) });
  pi.registerCommand("work", { description: "WORK", handler: (_a, ctx) => switchMode("work", ctx) });
  pi.registerCommand("yolo", { description: "YOLO", handler: (_a, ctx) => switchMode("yolo", ctx) });

  // ---- tool_call ----
  pi.on("tool_call", async (event, ctx) => {
    if (mode === "plan") {
      if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
        ctx.ui.notify("[PLAN] write/edit blocked", "warning");
        return { block: true, reason: "write/edit disabled in PLAN mode" };
      }
      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;
        const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "PLAN", cmdStr, isSubAgent,
          (e) => { event.input.command = e; return true; });
        if (!ok) return { block: true, reason: `${toolName} blocked` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, `PLAN ${toolName} ✅`);
      }
      return;
    }

    if (mode === "yolo") return;

    // WORK
    let path: string | undefined;

    if (isToolCallEventType("read", event)) {
      path = resolvePath(ctx.cwd, event.input.path);
      if (!isUnder(ctx.cwd, path)) {
        const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Read", path, isSubAgent);
        if (!ok) return { block: true, reason: `read outside cwd: ${path}` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK read ✅");
      }
    }
    if (isToolCallEventType("write", event)) {
      path = resolvePath(ctx.cwd, event.input.path);
      if (!isUnder(ctx.cwd, path)) {
        const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Write", path, isSubAgent);
        if (!ok) return { block: true, reason: `write outside cwd: ${path}` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK write ✅");
      }
    }
    if (isToolCallEventType("edit", event)) {
      path = resolvePath(ctx.cwd, event.input.path);
      if (!isUnder(ctx.cwd, path)) {
        const ok = await confirmAndRemember(ctx, pathAllowlist, "path", "Edit", path, isSubAgent);
        if (!ok) return { block: true, reason: `edit outside cwd: ${path}` };
        if (ok === "dialog") confirmedCalls.set(event.toolCallId, "WORK edit ✅");
      }
    }
    if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event)) {
      const cmdStr = event.input.command?.trim() ?? "";
      const toolName = event.toolName;
      const ok = await confirmAndRemember(ctx, cmdAllowlist, "bash", "WORK", cmdStr, isSubAgent,
        (e) => { event.input.command = e; return true; });
      if (!ok) return { block: true, reason: `${toolName} blocked` };
      if (ok === "dialog") confirmedCalls.set(event.toolCallId, `WORK ${toolName} ✅`);
    }
  });

  pi.on("tool_result", (event) => {
    const label = confirmedCalls.get(event.toolCallId);
    if (!label) return;
    confirmedCalls.delete(event.toolCallId);
    const idx = event.content.findIndex((b: { type: string }) => b.type === "text");
    if (idx >= 0) {
      event.content[idx] = { ...event.content[idx], text: `[${label}]\n${event.content[idx].text}` };
    }
  });
}
