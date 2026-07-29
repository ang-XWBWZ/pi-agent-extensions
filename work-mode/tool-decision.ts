import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionProfile } from "./execution-profile.js";
import {
  isAdvisoryPath,
  isProtectedPath,
  isUnder,
  resolvePath,
} from "./path-guard.js";

export type DecisionAction = "allow" | "ask" | "deny";
export type ToolEffect =
  | "read"
  | "progress"
  | "workspace_write"
  | "persistent"
  | "destructive"
  | "unknown";
export type CommandRisk =
  | "read"
  | "routine"
  | "persistent"
  | "destructive"
  | "unknown";

export interface ConfirmDecision {
  type: "path" | "command" | "action";
  label: string;
  target: string;
  allowlist: "path" | "cmd" | "action";
  confirmedLabel: string;
  remember?: boolean;
  onEdit?: (edited: string) => boolean;
}

export interface ToolDecision {
  action: DecisionAction;
  effect: ToolEffect;
  reason?: string;
  warning?: string;
  target?: string;
  confirm?: ConfirmDecision;
}

const SHELL_TOOLS = new Set(["bash", "cmd", "powershell"]);
const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);
const FILE_ACCESS_TOOLS = new Set(["read", "write", "edit"]);
const READ_TOOLS = new Set([
  "grep",
  "find",
  "ls",
  "context",
  "wiki_read_search",
  "wiki_read_entry",
  "wiki_read_chunks",
  "wiki_read_sources",
  "work_goal_status",
  "work_goal_log",
  "check_agent_results",
  "read_agent_output",
]);
const PROGRESS_TOOLS = new Set([
  "spawn_agent",
  "send_agent_message",
  "update_agent_task",
  "work_goal_start",
  "work_goal_finish",
  "work_goal_abort",
]);
const PERSISTENT_TOOLS = new Set([
  "wiki_edit_create",
  "wiki_edit_modify",
  "wiki_edit_move",
  "wiki_edit_rename",
  "wiki_DANGER_load",
  "wiki_DANGER_refresh",
  "wiki_DANGER_compile",
  "wiki_DANGER_store",
  "manage_providers",
]);
const DESTRUCTIVE_COMMAND =
  /(?:\b(?:rm|del|erase|rd|rmdir|truncate|mkfs)\b|\b(?:Remove-Item|Clear-Content)\b|\bformat\b|\bdiskpart\b|\bshutdown\b|\breboot\b|\bgit\s+(?:reset\s+--hard|restore\b|checkout\s+--|checkout\s+[^;&|\r\n]*(?:-f|--force)\b|switch\s+[^;&|\r\n]*(?:-f|--force|--discard-changes)\b|clean\s+[^;&|\r\n]*-[a-z]*f[a-z]*|push\s+[^;&|\r\n]*--force(?:-with-lease)?|commit\s+[^;&|\r\n]*--amend|stash\s+(?:pop|drop|clear)|branch\s+[^;&|\r\n]*-[dD]\b|tag\s+(?:-d|--delete)\b))/i;
const PERSISTENT_COMMAND =
  /(?:\b(?:copy|xcopy|robocopy|move|ren|rename|mkdir|touch)\b|\b(?:Set-Content|Add-Content|Out-File|New-Item|Set-Item|Move-Item|Copy-Item|Rename-Item|Start-Process)\b|\b(?:npm|pnpm|yarn|pip|pip3|cargo)\s+(?:ci|install|add|remove|uninstall|publish)\b|\bgit\s+(?:add|commit|push|pull|fetch|switch|checkout|merge|rebase|tag|stash)\b|(?:^|[\s;])>{1,2}(?=\s*\S))/i;
const ROUTINE_COMMAND =
  /^(?:npm|pnpm|yarn)\s+(?:test|lint|build|check|typecheck|run\s+(?:test|lint|build|check|typecheck))\b|^(?:node\s+--test|pytest\b|python\s+-m\s+pytest\b|dotnet\s+(?:test|build)\b|cargo\s+(?:test|check)\b|go\s+test\b|tsc\s+--noEmit\b)/i;
const READ_COMMAND =
  /^(?:rg\b|grep\b|findstr\b|where\b|dir\b|ls\b|pwd\b|type\b|cat\b|head\b|tail\b|wc\b|Get-Content\b|Get-ChildItem\b|Get-Item\b|Get-Command\b|Get-Location\b|Select-String\b|Test-Path\b|Resolve-Path\b|Measure-Object\b|Sort-Object\b|Where-Object\b|ForEach-Object\b|Format-(?:Table|List|Wide)\b|Out-String\b|git\s+(?:status|diff|log|show|rev-parse|ls-files|grep)\b|git\s+(?:remote\s+-v|config\s+(?:--get|--get-all|--list)\b)|git\s+branch\s*(?:(?:--show-current|--list|--all|--remotes|-a|-r|-v|-vv)\b)?\s*$|(?:npm|pnpm|yarn)\s+(?:ls|list|view|info)\b|node\s+--version\b|npm\s+--version\b|pnpm\s+--version\b|python\s+--version\b)/i;
const AUTO_SCOPED_PERSISTENT_COMMAND =
  /^(?:git\s+(?:add\b|commit\b|fetch\b|switch\b|checkout\b|merge\b|stash\s+(?:push|apply|list|show)\b)|(?:npm|pnpm|yarn)\s+(?:ci|install|add|remove|uninstall)\b)/i;
const AUTO_CONFIRM_TOOLS = new Set([
  "manage_providers",
  "manage_tools",
  "manage_skills",
  "long_attention_config_ps",
  "wiki_DANGER_semantic",
]);

function inputOf(event: { input?: unknown }): Record<string, unknown> {
  return (event.input ?? {}) as Record<string, unknown>;
}

function commandOf(event: { input?: unknown }): string {
  const command = inputOf(event).command;
  return typeof command === "string" ? command.trim() : "";
}

function pathOf(
  event: { input?: unknown },
  cwd: string,
): string | undefined {
  const path = inputOf(event).path;
  if (typeof path !== "string") return undefined;
  return resolvePath(cwd, path);
}

function splitCommand(command: string): string[] {
  return command
    .split(/\r?\n|;|&&|\|\||(?<!\|)\|(?!\|)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\$[\w:]+\s*=\s*/, "").trim());
}

function referencedCommandPaths(command: string, cwd: string): string[] {
  const rawPaths: string[] = [];
  const patterns = [
    /["']([a-z]:[\\/][^"']+)["']/gi,
    /\b([a-z]:[\\/][^\s;&|"'<>]+)/gi,
    /(?:^|[\s"'=])((?:\.\.[\\/])[^\s;&|"'<>]+|(?:\.git|\.pi|\.agents|\.claude|node_modules)(?:[\\/][^\s;&|"'<>]+)?)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const value = match[1]?.replace(/[),\]}]+$/, "");
      if (value) rawPaths.push(value);
    }
  }
  return [
    ...new Set(rawPaths.map((value) => resolvePath(cwd, value))),
  ];
}

function hasUnverifiableCommandPath(command: string): boolean {
  return /(?:\$env:[a-z_]\w*|%(?:userprofile|home|appdata|temp|tmp)%|\$(?:home|userprofile)\b|(?:^|\s)~[\\/])/i.test(
    command,
  );
}

export function classifyCommandRisk(command: string): CommandRisk {
  const value = command.trim();
  if (!value) return "unknown";
  if (DESTRUCTIVE_COMMAND.test(value)) return "destructive";
  if (PERSISTENT_COMMAND.test(value)) return "persistent";

  const parts = splitCommand(value);
  if (parts.length > 0 && parts.every((part) => READ_COMMAND.test(part))) {
    return "read";
  }
  if (
    parts.length > 0 &&
    parts.every(
      (part) => READ_COMMAND.test(part) || ROUTINE_COMMAND.test(part),
    ) &&
    parts.some((part) => ROUTINE_COMMAND.test(part))
  ) {
    return "routine";
  }
  return "unknown";
}

export function isAutoScopedPersistentCommand(command: string): boolean {
  const value = command.trim();
  const parts = splitCommand(value);
  if (parts.length === 0 || DESTRUCTIVE_COMMAND.test(value)) return false;
  return parts.every(
    (part) =>
      AUTO_SCOPED_PERSISTENT_COMMAND.test(part) &&
      !/(?:^|\s)(?:-g|--global)\b/i.test(part),
  );
}

export function classifyCustomToolEffect(
  toolName: string,
  input: Record<string, unknown> = {},
): ToolEffect {
  const action = typeof input.action === "string" ? input.action : "";
  const path = typeof input.path === "string" ? input.path.trim() : "";

  if (toolName === "wiki_read_chunks") {
    return action === "reset" || action === "unlock" ? "persistent" : "read";
  }
  if (toolName === "wiki_DANGER_unload") {
    return path ? "destructive" : "read";
  }

  if (READ_TOOLS.has(toolName)) return "read";
  if (PROGRESS_TOOLS.has(toolName)) return "progress";
  if (PERSISTENT_TOOLS.has(toolName)) {
    if (toolName === "manage_providers" && (!action || action === "list")) {
      return "read";
    }
    return "persistent";
  }
  if (toolName === "manage_requirements") {
    if (action === "status") return "read";
    return action === "clear" && input.force === true
      ? "destructive"
      : "progress";
  }
  if (toolName === "manage_plan") {
    if (action === "status") return "read";
    return (action === "clear" && input.force === true) ||
      action === "delete_step"
      ? "destructive"
      : "progress";
  }
  if (toolName === "long_attention_list_ps") return "read";
  if (toolName === "long_attention_add_ps") return "progress";
  if (toolName === "long_attention_clear_ps") return "destructive";
  if (toolName === "long_attention_config_ps") {
    return input.key ? "persistent" : "read";
  }
  if (toolName === "switch_model") {
    return action === "show_tier_config" ? "read" : "persistent";
  }
  if (toolName === "manage_tools" || toolName === "manage_skills") {
    return action.endsWith("_list") || action === "list" ? "read" : "persistent";
  }
  if (toolName === "control_agent") {
    if (["list", "status", "list_saves"].includes(action)) return "read";
    if (action === "delete_save" || action === "kill" || action === "kill_job") {
      return "destructive";
    }
    if (action === "save") return "persistent";
    return "progress";
  }
  if (toolName === "wiki_DANGER_semantic") {
    return action ? "persistent" : "read";
  }

  return "unknown";
}

function describeCustomTarget(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const details: string[] = [];
  for (const key of [
    "action",
    "path",
    "source",
    "provider",
    "baseUrl",
    "model",
    "tier",
    "name",
    "id",
    "stepId",
    "relPath",
    "scope",
    "jobId",
    "taskId",
    "to",
  ]) {
    const value = input[key];
    if (
      (typeof value === "string" || typeof value === "number") &&
      String(value).trim()
    ) {
      details.push(`${key}=${String(value).trim()}`);
    }
  }
  return details.length > 0 ? `${toolName} ${details.join(" ")}` : toolName;
}

function customPath(
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  for (const key of ["source", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return resolvePath(cwd, value.trim());
    }
  }
  return undefined;
}

function deny(effect: ToolEffect, reason: string, target?: string): ToolDecision {
  return { action: "deny", effect, reason, target };
}

function allow(effect: ToolEffect, target?: string): ToolDecision {
  return { action: "allow", effect, target };
}

function ask(
  effect: ToolEffect,
  type: ConfirmDecision["type"],
  label: string,
  target: string,
  allowlist: ConfirmDecision["allowlist"],
  onEdit?: (edited: string) => boolean,
  remember = true,
): ToolDecision {
  return {
    action: "ask",
    effect,
    target,
    confirm: {
      type,
      label,
      target,
      allowlist,
      confirmedLabel: `${label} confirmed`,
      remember,
      onEdit,
    },
  };
}

function withAdvisoryPathWarning(
  decision: ToolDecision,
  targetPath: string | undefined,
): ToolDecision {
  if (!targetPath || !isAdvisoryPath(targetPath)) return decision;
  return {
    ...decision,
    warning: `提醒路径：${targetPath}。请核对准确目标和变更范围；该目录不再因路径规则自动拦截。`,
  };
}

function decideFileCall(
  profile: ExecutionProfile,
  event: { toolName: string; input?: unknown },
  ctx: ExtensionContext,
): ToolDecision {
  const mutation = FILE_MUTATION_TOOLS.has(event.toolName);
  const targetPath = pathOf(event, ctx.cwd);
  const effect: ToolEffect = mutation ? "workspace_write" : "read";

  if (mutation && targetPath && isProtectedPath(targetPath)) {
    return deny(
      "destructive",
      `Protected paths cannot be modified by the workflow runtime: ${targetPath}`,
      targetPath,
    );
  }
  if (profile.intent === "chat") {
    return deny(
      effect,
      `${event.toolName} is unavailable in CHAT; switch to PLAN or WORK first.`,
      targetPath,
    );
  }
  if (mutation && profile.intent === "plan") {
    return deny(
      effect,
      `${event.toolName} is unavailable in PLAN; confirm the Work Contract first.`,
      targetPath,
    );
  }
  if (!targetPath) {
    return ask(
      "unknown",
      "action",
      `${event.toolName} without a verifiable path`,
      event.toolName,
      "action",
      undefined,
      false,
    );
  }
  if (targetPath && !isUnder(ctx.cwd, targetPath)) {
    return ask(
      effect,
      "path",
      mutation ? "Outside-workspace write" : "Outside-workspace read",
      targetPath,
      "path",
    );
  }
  return allow(effect, targetPath);
}

function decideShellCall(
  profile: ExecutionProfile,
  event: { toolName: string; input?: unknown },
  ctx: ExtensionContext,
): ToolDecision {
  const command = commandOf(event);
  const risk = classifyCommandRisk(command);
  const paths = referencedCommandPaths(command, ctx.cwd);
  const protectedPathIsMetadataOnly =
    splitCommand(command).length > 0 &&
    splitCommand(command).every((part) => /^git\s+(?:add|status|diff)\b/i.test(part));
  const protectedTarget =
    risk === "read" || protectedPathIsMetadataOnly
      ? undefined
      : paths.find((path) => isProtectedPath(path));
  const outsideTarget = paths.find((path) => !isUnder(ctx.cwd, path));
  const effect: ToolEffect =
    risk === "read"
      ? "read"
      : risk === "routine"
        ? "workspace_write"
        : risk === "persistent"
          ? "persistent"
          : risk === "destructive"
            ? "destructive"
            : "unknown";

  if (profile.intent === "chat") {
    return deny(effect, "Terminal commands are disabled in CHAT.", command);
  }
  if (protectedTarget) {
    return deny(
      "destructive",
      `Explicit shell writes to protected paths are blocked: ${protectedTarget}`,
      protectedTarget,
    );
  }
  if (profile.intent === "plan") {
    if (risk !== "read") {
      return deny(
        effect,
        "PLAN permits only recognized read-only diagnostics.",
        command,
      );
    }
    if (hasUnverifiableCommandPath(command)) {
      return deny(
        "unknown",
        "PLAN cannot verify an environment-expanded path.",
        command,
      );
    }
    return outsideTarget
      ? ask(
          "read",
          "path",
          "Outside-workspace terminal read",
          outsideTarget,
          "path",
        )
      : allow("read", command);
  }
  if (risk === "destructive") {
    return ask(
      effect,
      "command",
      "Destructive command",
      command,
      "cmd",
      (edited) => {
        inputOf(event).command = edited;
        return true;
      },
      false,
    );
  }
  if (outsideTarget) {
    return ask(
      effect,
      "path",
      "Outside-workspace terminal action",
      outsideTarget,
      "path",
    );
  }
  if (hasUnverifiableCommandPath(command)) {
    return ask(
      "unknown",
      "command",
      "Command with unverifiable path",
      command,
      "cmd",
      (edited) => {
        inputOf(event).command = edited;
        return true;
      },
      false,
    );
  }
  if (risk === "read" || risk === "routine") return allow(effect, command);
  if (
    profile.approval === "never_ask" &&
    risk === "persistent" &&
    isAutoScopedPersistentCommand(command)
  ) {
    return allow(effect, command);
  }
  return ask(
    effect,
    "command",
    risk === "persistent" ? "Persistent command" : "Unclassified command",
    command,
    "cmd",
    (edited) => {
      inputOf(event).command = edited;
      return true;
    },
    risk === "persistent",
  );
}

function planCanUseProgressTool(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === "manage_requirements") return true;
  if (toolName === "manage_plan") return input.action === "status";
  if (toolName === "spawn_agent") {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    return tasks.every((task) => {
      if (!task || typeof task !== "object") return false;
      const phase = (task as Record<string, unknown>).phase;
      return phase === "chat" || phase === "plan";
    });
  }
  if (toolName === "update_agent_task") return true;
  return toolName === "long_attention_add_ps";
}

function decideToolCallBase(
  profile: ExecutionProfile,
  event: { toolName: string; toolCallId: string; input?: unknown },
  ctx: ExtensionContext,
): ToolDecision {
  if (FILE_ACCESS_TOOLS.has(event.toolName)) {
    return decideFileCall(profile, event, ctx);
  }
  if (SHELL_TOOLS.has(event.toolName)) {
    return decideShellCall(profile, event, ctx);
  }

  const input = inputOf(event);
  const effect = classifyCustomToolEffect(event.toolName, input);
  const target = describeCustomTarget(event.toolName, input);
  const path = customPath(input, ctx.cwd);

  if (profile.intent === "chat") {
    return deny(
      effect,
      `${event.toolName} is unavailable in CHAT; switch to PLAN or WORK first.`,
      target,
    );
  }

  if (effect === "read") {
    return path && !isUnder(ctx.cwd, path)
      ? ask(
          effect,
          "path",
          "Outside-workspace tool read",
          path,
          "path",
        )
      : allow(effect, target);
  }

  if (profile.intent === "plan") {
    if (
      event.toolName === "manage_requirements" &&
      input.action === "clear" &&
      input.force === true
    ) {
      return ask(
        "destructive",
        "action",
        "Clear accepted Work Contract",
        target,
        "action",
        undefined,
        false,
      );
    }
    return effect === "progress" &&
      planCanUseProgressTool(event.toolName, input)
      ? allow(effect, target)
      : deny(
          effect,
          `${event.toolName} is not a read-only PLAN operation.`,
          target,
        );
  }

  if (effect === "progress" || effect === "workspace_write") {
    return allow(effect, target);
  }
  if (effect === "destructive" || effect === "unknown") {
    return ask(
      effect,
      "action",
      effect === "destructive" ? "Destructive tool action" : "Unclassified tool action",
      target,
      "action",
      undefined,
      false,
    );
  }
  if (path && !isUnder(ctx.cwd, path)) {
    return ask(
      effect,
      "path",
      "Outside-workspace tool action",
      path,
      "path",
    );
  }
  if (
    profile.approval === "never_ask" &&
    !AUTO_CONFIRM_TOOLS.has(event.toolName) &&
    !(
      event.toolName === "switch_model" &&
      typeof input.action === "string" &&
      input.action !== "show_tier_config"
    )
  ) {
    return allow(effect, target);
  }
  return ask(
    effect,
    "action",
    "Persistent tool action",
    target,
    "action",
  );
}

function advisoryTargetForToolCall(
  event: { toolName: string; input?: unknown },
  ctx: ExtensionContext,
  decision: ToolDecision,
): string | undefined {
  if (decision.effect === "read") return undefined;
  if (FILE_ACCESS_TOOLS.has(event.toolName)) {
    return FILE_MUTATION_TOOLS.has(event.toolName)
      ? pathOf(event, ctx.cwd)
      : undefined;
  }
  if (SHELL_TOOLS.has(event.toolName)) {
    return referencedCommandPaths(commandOf(event), ctx.cwd)
      .find((path) => isAdvisoryPath(path));
  }
  return customPath(inputOf(event), ctx.cwd);
}

export function decideToolCall(
  profile: ExecutionProfile,
  event: { toolName: string; toolCallId: string; input?: unknown },
  ctx: ExtensionContext,
): ToolDecision {
  const decision = decideToolCallBase(profile, event, ctx);
  return withAdvisoryPathWarning(
    decision,
    advisoryTargetForToolCall(event, ctx, decision),
  );
}
