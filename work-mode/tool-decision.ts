import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionProfile } from "./execution-profile.js";
import { isProtectedPath, isUnder, resolvePath } from "./path-guard.js";

export type DecisionAction = "allow" | "ask" | "deny";

export interface ConfirmDecision {
  type: "path" | "bash";
  label: string;
  target: string;
  allowlist: "path" | "cmd";
  confirmedLabel: string;
  onEdit?: (edited: string) => boolean;
}

export interface ToolDecision {
  action: DecisionAction;
  reason?: string;
  confirm?: ConfirmDecision;
}

const SHELL_TOOLS = new Set(["bash", "cmd", "powershell"]);
const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);
const FILE_ACCESS_TOOLS = new Set(["read", "write", "edit"]);

const DESTRUCTIVE_COMMANDS =
  /\b(rm|del|rd|rmdir|move|ren|copy|xcopy|robocopy|attrib|icacls|takeown|format|diskpart)\b/i;

function inputOf(event: { input?: unknown }): Record<string, unknown> {
  return (event.input ?? {}) as Record<string, unknown>;
}

function commandOf(event: { input?: unknown }): string {
  const command = inputOf(event).command;
  return typeof command === "string" ? command.trim() : "";
}

function pathOf(event: { input?: unknown }, cwd: string): string | undefined {
  const path = inputOf(event).path;
  if (typeof path !== "string") return undefined;
  return resolvePath(cwd, path);
}

function isProjectTool(toolName: string): boolean {
  return toolName.startsWith("project_");
}

export function decideToolCall(
  profile: ExecutionProfile,
  event: { toolName: string; toolCallId: string; input?: unknown },
  ctx: ExtensionContext,
): ToolDecision {
  if (profile.approval === "never_ask") {
    return { action: "allow" };
  }

  if (isProjectTool(event.toolName)) {
    return { action: "allow" };
  }

  if (profile.intent === "chat" || profile.intent === "plan") {
    if (FILE_MUTATION_TOOLS.has(event.toolName)) {
      return {
        action: "deny",
        reason:
          "write/edit is blocked outside WORK phase. Confirm requirements first, then switch to WORK.",
      };
    }
    if (SHELL_TOOLS.has(event.toolName)) {
      return {
        action: "deny",
        reason:
          "terminal commands are blocked outside WORK phase. Finish confirmation first or switch to WORK.",
      };
    }
    return { action: "allow" };
  }

  if (profile.boundary === "workspace_write") {
    if (FILE_MUTATION_TOOLS.has(event.toolName)) {
      const targetPath = pathOf(event, ctx.cwd);
      if (targetPath && isProtectedPath(targetPath)) {
        return {
          action: "deny",
          reason: "Cannot modify protected path: " + targetPath,
        };
      }
    }

    if (FILE_ACCESS_TOOLS.has(event.toolName)) {
      const targetPath = pathOf(event, ctx.cwd);
      if (targetPath && !isUnder(ctx.cwd, targetPath)) {
        const verb = event.toolName === "read"
          ? "Read"
          : event.toolName === "write"
            ? "Write"
            : "Edit";
        return {
          action: "ask",
          confirm: {
            type: "path",
            label: verb,
            target: targetPath,
            allowlist: "path",
            confirmedLabel: `WORK ${event.toolName} ok`,
          },
        };
      }
      return { action: "allow" };
    }

    if (SHELL_TOOLS.has(event.toolName)) {
      const command = commandOf(event);
      const destructive = DESTRUCTIVE_COMMANDS.test(command) && command.includes("..");
      return {
        action: "ask",
        confirm: {
          type: "bash",
          label: destructive ? "WORK (destructive)" : "WORK",
          target: command,
          allowlist: "cmd",
          confirmedLabel: `WORK ${event.toolName} ok`,
          onEdit: (edited) => {
            inputOf(event).command = edited;
            return true;
          },
        },
      };
    }
  }

  return { action: "allow" };
}
