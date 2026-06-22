/**
 * permission-guard.ts — 权限管理：tool_call 拦截 + 路径保护 + 确认弹窗 + 错误恢复
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { requestConfirm } from "../lib/confirm-bus.js";
import { type WorkMode, type AppState, type PlanStep } from "./types.js";
import { isProtectedPath, isUnder, resolvePath } from "./path-guard.js";
import { confirmAndRemember } from "./confirm-dialog.js";

// ============================================================
// Shared state & callbacks
// ============================================================

export interface PermissionState {
  mode: WorkMode;
  appState: AppState;
  isSubAgent: boolean;
  planSteps: PlanStep[];
  pathAllowlist: Set<string>;
  cmdAllowlist: Set<string>;
  confirmedCalls: Map<string, string>;
  pendingErrorInfo: { stepIndex: number; message: string; isSevere: boolean } | null;
}

export interface PermissionCallbacks {
  getCurrentStepIndex: () => number;
  setMode: (m: WorkMode, ctx: ExtensionContext) => void;
  clearPlanPanel: (ctx: ExtensionContext) => void;
  updatePlanPanel: (ctx: ExtensionContext) => void;
  resetPlanProduced: () => void;
}

// ============================================================
// Error recovery
// ============================================================

function handleErrorChoice(
  choice: string | undefined,
  ctx: ExtensionContext,
  s: PermissionState,
  cb: PermissionCallbacks,
) {
  if (choice === "继续执行" || choice === "继续执行 (跳过该步)") {
    const currIdx = cb.getCurrentStepIndex();
    if (currIdx >= 0 && currIdx < s.planSteps.length) {
      s.planSteps[currIdx].status = "skipped";
    }
    const nextIdx = currIdx + 1;
    if (nextIdx < s.planSteps.length) {
      s.planSteps[nextIdx].status = "current";
    }
    s.appState = "working";
    s.pendingErrorInfo = null;
    cb.updatePlanPanel(ctx);
    ctx.ui.notify("已跳过错误，继续执行", "info");
  } else if (choice === "重新规划") {
    cb.clearPlanPanel(ctx);
    cb.setMode("plan", ctx);
    s.appState = "planning";
    cb.resetPlanProduced();
    ctx.ui.notify("已切换到 PLAN 模式，请重新制定计划", "info");
  } else {
    s.appState = "error";
    ctx.ui.notify("执行已中止", "warning");
  }
}

// ============================================================
// Setup
// ============================================================

export function setupPermissionGuard(
  pi: ExtensionAPI,
  s: PermissionState,
  cb: PermissionCallbacks,
) {
  // ---- tool_call: enforce mode rules ----
  pi.on("tool_call", async (event, ctx) => {
    if (s.appState === "error") {
      const safeTools = ["read", "manage_plan", "check_agent_results", "context"];
      if (safeTools.includes(event.toolName)) return;
      return {
        block: true,
        reason: "执行因错误已暂停。请选择：继续执行、重新规划 或 中止",
      };
    }

    if (s.mode === "yolo") {
      if (s.isSubAgent) {
        return { block: true, reason: "YOLO mode not available for sub-agents" };
      }
      return;
    }

    if (s.mode === "plan") {
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        return {
          block: true,
          reason: "write/edit 在 PLAN 模式下被阻止。请先输出计划，系统将自动切换到 WORK 模式。",
        };
      }
      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event) || isToolCallEventType("powershell", event)) {
        return {
          block: true,
          reason: "终端命令在 PLAN 模式下被阻止。请先完成计划并等待系统切换到 WORK 模式，或 /work 手动切换到 WORK 模式。",
        };
      }
      return;
    }

    if (s.mode === "work") {
      // ---- Protected path guard ----
      if (
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const targetPath = resolvePath(ctx.cwd, (event as any).input.path ?? "");
        if (isProtectedPath(targetPath)) {
          return { block: true, reason: "不允许操作受保护路径: " + targetPath };
        }
      }

      // ---- CWD boundary guard ----
      let path: string | undefined;

      if (isToolCallEventType("read", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, s.pathAllowlist, "path", "Read", path, s.isSubAgent);
          if (!ok) return { block: true, reason: "read outside cwd: " + path };
          if (ok === "dialog") s.confirmedCalls.set(event.toolCallId, "WORK read ok");
        }
      }
      if (isToolCallEventType("write", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, s.pathAllowlist, "path", "Write", path, s.isSubAgent);
          if (!ok) return { block: true, reason: "write outside cwd: " + path };
          if (ok === "dialog") s.confirmedCalls.set(event.toolCallId, "WORK write ok");
        }
      }
      if (isToolCallEventType("edit", event)) {
        path = resolvePath(ctx.cwd, event.input.path);
        if (!isUnder(ctx.cwd, path)) {
          const ok = await confirmAndRemember(ctx, s.pathAllowlist, "path", "Edit", path, s.isSubAgent);
          if (!ok) return { block: true, reason: "edit outside cwd: " + path };
          if (ok === "dialog") s.confirmedCalls.set(event.toolCallId, "WORK edit ok");
        }
      }
      if (isToolCallEventType("bash", event) || isToolCallEventType("cmd", event) || isToolCallEventType("powershell", event)) {
        const cmdStr = event.input.command?.trim() ?? "";
        const toolName = event.toolName;

        const destructiveCommands = /\b(rm|del|rd|rmdir|move|ren|copy|xcopy|robocopy|attrib|icacls|takeown|format|diskpart)\b/i;
        if (destructiveCommands.test(cmdStr) && cmdStr.includes("..")) {
          const ok = await confirmAndRemember(ctx, s.cmdAllowlist, "bash", "WORK (destructive)", cmdStr, s.isSubAgent,
            (e) => { event.input.command = e; return true; });
          if (!ok) return { block: true, reason: toolName + " 用户拒绝: 破坏性命令" };
          if (ok === "dialog") s.confirmedCalls.set(event.toolCallId, "WORK " + toolName + " ok");
          return;
        }

        const ok = await confirmAndRemember(ctx, s.cmdAllowlist, "bash", "WORK", cmdStr, s.isSubAgent,
          (e) => { event.input.command = e; return true; });
        if (!ok) return { block: true, reason: toolName + " 用户拒绝" };
        if (ok === "dialog") s.confirmedCalls.set(event.toolCallId, "WORK " + toolName + " ok");
      }
      return;
    }
  });

  // ---- tool_result: detect errors ----
  pi.on("tool_result", async (event, ctx) => {
    if (s.mode !== "work" || s.planSteps.length === 0) return;
    if (s.appState === "error") return;

    const currentIdx = cb.getCurrentStepIndex();
    if (currentIdx < 0) return;

    if (!event.isError) return;

    const textContent = event.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");

    const isSevere =
      textContent.includes("protected path") ||
      textContent.includes("受保护路径") ||
      textContent.includes("blocked") ||
      textContent.includes("用户拒绝") ||
      textContent.includes("被阻止") ||
      textContent.includes("Permission denied") ||
      textContent.includes("Access denied") ||
      textContent.includes("权限");

    s.planSteps[currentIdx].status = "error";
    s.appState = "error";
    cb.updatePlanPanel(ctx);

    const stepLabel = s.planSteps[currentIdx].text;
    s.pendingErrorInfo = {
      stepIndex: currentIdx,
      message: "步骤" + stepLabel + "执行出错:\n" + textContent.slice(0, 300),
      isSevere,
    };

    if (isSevere) {
      ctx.ui.notify("严重错误已中止: " + textContent.slice(0, 100), "error");
      ctx.ui.setStatus("work-mode", "MODE: " + s.mode.toUpperCase() + " 已中止");
      return;
    }

    if (s.isSubAgent) {
      const choice = await requestConfirm(
        "error_recovery",
        s.pendingErrorInfo.message,
        "步骤出错，如何继续？",
        ["继续执行", "重新规划", "中止"],
      );
      handleErrorChoice(choice, ctx, s, cb);
    } else {
      const choice = await ctx.ui.select(
        "步骤出错\n\n" + s.pendingErrorInfo.message + "\n\n如何继续？",
        ["继续执行 (跳过该步)", "重新规划", "中止执行"],
      );
      handleErrorChoice(choice, ctx, s, cb);
    }
  });

  // ---- tool_result: tag confirmed calls ----
  pi.on("tool_result", (event) => {
    if (s.mode === "yolo") return;

    const label = s.confirmedCalls.get(event.toolCallId);
    if (!label) return;
    s.confirmedCalls.delete(event.toolCallId);

    const idx = event.content.findIndex((b: { type: string }) => b.type === "text");
    if (idx >= 0) {
      event.content[idx] = {
        ...event.content[idx],
        text: "[" + label + "]\n" + event.content[idx].text,
      };
    }
  });
}
