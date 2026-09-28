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
  purpose?: string;
  remember?: boolean;
  onEdit?: (edited: string) => boolean;
}

export interface AutoFlashDecision {
  command: string;
  toolName?: string;
  purpose?: string;
  input?: unknown;
  cwd: string;
  effect: ToolEffect;
}

export interface ToolDecision {
  action: DecisionAction;
  effect: ToolEffect;
  reason?: string;
  warning?: string;
  target?: string;
  confirm?: ConfirmDecision;
  flashReview?: AutoFlashDecision;
}

export const SHELL_TOOLS = new Set(["bash", "cmd", "powershell"]);
export const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);
const FILE_ACCESS_TOOLS = new Set(["read", "write", "edit"]);
const READ_TOOLS = new Set([
  "grep",
  "find",
  "ls",
  "context",
  "work_goal_status",
  "work_goal_log",
  "check_agent_results",
  "read_agent_output",
  "load_capability",
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
  "mcp_manage",
  "mcp_call",
  "chrome_act",
]);

export function inputOf(event: { input?: unknown }): Record<string, unknown> {
  return (event.input ?? {}) as Record<string, unknown>;
}

export function commandOf(event: { input?: unknown }): string {
  const command = inputOf(event).command;
  return typeof command === "string" ? command.trim() : "";
}

export function purposeOf(event: { toolName?: string; input?: unknown }): string | undefined {
  const input = inputOf(event);
  const explicit =
    input.purpose ??
    input.toolAction ??
    input.toolSummary ??
    input.description ??
    input.summary ??
    input.reason ??
    input.justification;

  if (typeof explicit === "string") {
    const value = explicit.replace(/\s+/g, " ").trim();
    if (value) return value.slice(0, 240);
  }

  if (typeof event.toolName === "string" && event.toolName.trim()) {
    const mcp = parseMcpCallInfo(event.toolName, input);
    if (mcp) {
      const targetHint =
        mcp.arguments.entry ??
        mcp.arguments.path ??
        mcp.arguments.title ??
        mcp.arguments.query ??
        mcp.arguments.name;
      const hintStr = typeof targetHint === "string" && targetHint.trim()
        ? ` [${targetHint.trim().slice(0, 60)}]`
        : "";
      return `调用 MCP 工具 ${mcp.server}/${mcp.tool}${hintStr}`;
    }
  }

  return undefined;
}

export function pathOf(
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

function isToolEffect(value: unknown): value is ToolEffect {
  return value === "read" || value === "progress" || value === "workspace_write"
    || value === "persistent" || value === "destructive" || value === "unknown";
}

interface McpPolicyRegistry {
  classifyCall?: (server: string, tool: string, argumentsValue: unknown) => unknown;
  isAlwaysAllowed?: (server: string) => unknown;
  resolveAlias?: (toolName: string) => string | undefined;
  resolveDirectTool?: (toolName: string) => { server: string; tool: string } | undefined;
}

function mcpPolicyRegistry(): McpPolicyRegistry | undefined {
  return (globalThis as Record<string, unknown>).__pi_mcp_policy_registry as McpPolicyRegistry | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface McpCallInfo {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  isDirect?: boolean;
}

export function parseMcpCallInfo(
  toolName: string,
  input: Record<string, unknown> = {},
): McpCallInfo | undefined {
  // 1. call_mcp_tool (Antigravity / MCP client format)
  if (toolName === "call_mcp_tool") {
    const server = input.ServerName ?? input.serverName ?? input.server;
    const tool = input.ToolName ?? input.toolName ?? input.tool ?? input.method;
    if (typeof server === "string" && server.trim() && typeof tool === "string" && tool.trim()) {
      const rawArgs = input.Arguments ?? input.arguments;
      const args = isRecord(rawArgs) ? rawArgs : {};
      return {
        server: server.trim(),
        tool: tool.trim(),
        arguments: args,
        isDirect: false,
      };
    }
  }

  // 2. mcp_call (Generic Pi MCP format)
  if (toolName === "mcp_call") {
    const server = typeof input.server === "string" && input.server.trim() ? input.server.trim() : undefined;
    const tool = typeof input.tool === "string" && input.tool.trim() ? input.tool.trim() : undefined;
    if (server && tool) {
      const args = isRecord(input.arguments) ? input.arguments : {};
      return {
        server,
        tool,
        arguments: args,
        isDirect: false,
      };
    }
    return undefined;
  }

  // 3. Registered alias tool (e.g. wiki({ method, arguments }))
  try {
    const aliasServer = mcpPolicyRegistry()?.resolveAlias?.(toolName);
    if (aliasServer) {
      const tool = typeof input.method === "string" && input.method.trim()
        ? input.method.trim()
        : typeof input.tool === "string" && input.tool.trim()
        ? input.tool.trim()
        : undefined;
      if (tool) {
        const args = isRecord(input.arguments) ? input.arguments : {};
        return {
          server: aliasServer,
          tool,
          arguments: args,
          isDirect: false,
        };
      }
    }
  } catch {
    // Ignore registry lookup failure
  }

  // 4. Registered direct tool (from mcpPolicyRegistry)
  try {
    const directTool = mcpPolicyRegistry()?.resolveDirectTool?.(toolName);
    if (directTool) {
      return {
        server: directTool.server,
        tool: directTool.tool,
        arguments: input,
        isDirect: true,
      };
    }
  } catch {
    // Ignore registry lookup failure
  }

  // 5. Namespaced tool name: mcp__<server>__<tool> or mcp_<server>_<tool>
  const namespacedMatch = toolName.match(/^mcp(?:__|_)([a-zA-Z0-9_-]+?)(?:__|_)(.+)$/);
  if (namespacedMatch) {
    const server = namespacedMatch[1];
    const tool = namespacedMatch[2];
    const args = isRecord(input.arguments) ? input.arguments : input;
    return {
      server,
      tool,
      arguments: args,
      isDirect: true,
    };
  }

  // 6. Direct known server prefix fallback (e.g. wiki_* -> pwiki)
  if (toolName.startsWith("wiki_")) {
    return {
      server: "pwiki",
      tool: toolName,
      arguments: isRecord(input.arguments) ? input.arguments : input,
      isDirect: true,
    };
  }

  return undefined;
}

function classifyMcpCall(input: Record<string, unknown>): ToolEffect {
  const server = typeof input.server === "string" ? input.server.trim() : "";
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  // Keep the no-argument static classification conservative and explicit for
  // prompt-policy validation. Real MCP calls always provide server and tool.
  if (!server || !tool) return "persistent";

  try {
    const effect = mcpPolicyRegistry()?.classifyCall?.(server, tool, input.arguments);
    return isToolEffect(effect) ? effect : "unknown";
  } catch {
    return "unknown";
  }
}

function mcpServerForTool(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  return parseMcpCallInfo(toolName, input)?.server;
}

function mcpMethodForTool(toolName: string, input: Record<string, unknown>): string | undefined {
  return parseMcpCallInfo(toolName, input)?.tool;
}

function mcpReviewInput(toolName: string, input: Record<string, unknown>): unknown {
  const mcp = parseMcpCallInfo(toolName, input);
  if (mcp) {
    return {
      server: mcp.server,
      tool: mcp.tool,
      arguments: mcp.arguments,
    };
  }
  return Object.keys(input).length > 0 ? input : undefined;
}

function isMcpAliasTool(toolName: string): boolean {
  if (toolName === "mcp_call" || toolName === "call_mcp_tool") return false;
  return !!parseMcpCallInfo(toolName, {})?.server;
}

function isMcpTool(toolName: string, input: Record<string, unknown> = {}): boolean {
  return toolName === "mcp_call" || toolName === "call_mcp_tool" || !!parseMcpCallInfo(toolName, input);
}

function isAlwaysAllowedMcpCall(
  input: Record<string, unknown>,
  toolName = "mcp_call",
): boolean {
  const server = mcpServerForTool(toolName, input);
  if (!server) return false;
  try {
    return mcpPolicyRegistry()?.isAlwaysAllowed?.(server) === true;
  } catch {
    return false;
  }
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

  if (toolName === "mcp_manage") {
    if (!action || action === "list" || action === "status" || action === "tools") return "read";
    if (action === "disconnect") return "progress";
    if (action === "remove") return "destructive";
    return "persistent";
  }
  if (toolName === "mcp_discover") {
    return "read";
  }

  const mcpInfo = parseMcpCallInfo(toolName, input);
  if (mcpInfo) {
    return classifyMcpCall({
      server: mcpInfo.server,
      tool: mcpInfo.tool,
      arguments: mcpInfo.arguments,
    });
  }

  if (toolName === "mcp_call") {
    return classifyMcpCall(input);
  }

  const aliasServer = mcpServerForTool(toolName, input);
  if (aliasServer) {
    const directTool = mcpPolicyRegistry()?.resolveDirectTool?.(toolName);
    return classifyMcpCall({
      server: aliasServer,
      tool: directTool?.tool ?? input.method,
      arguments: directTool ? input : input.arguments,
    });
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
  if (toolName === "browser_read" || toolName === "chrome_tabs" || toolName === "chrome_screenshot") {
    return "read";
  }
  if (toolName === "chrome_act") {
    if (action === "wait" || action === "scroll") return "progress";
    return "persistent";
  }
  return "unknown";
}

function describeCustomTarget(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const details: string[] = [];
  const mcpInfo = parseMcpCallInfo(toolName, input);

  for (const key of [
    "action",
    "path",
    "source",
    "provider",
    "baseUrl",
    "model",
    "tier",
    "name",
    "server",
    "tool",
    "method",
    "uri",
    "command",
    "cwd",
    "policy",
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

  if (mcpInfo) {
    if (!details.some((d) => d.startsWith("server="))) {
      details.push(`server=${mcpInfo.server}`);
    }
    if (!details.some((d) => d.startsWith("tool=") || d.startsWith("method="))) {
      details.push(`tool=${mcpInfo.tool}`);
    }
    const args = mcpInfo.arguments;
    for (const key of [
      "entry",
      "path",
      "file",
      "name",
      "title",
      "query",
      "area",
      "id",
      "uri",
      "model",
      "action",
      "mode",
    ]) {
      const value = args[key];
      if (
        (typeof value === "string" || typeof value === "number") &&
        String(value).trim() &&
        !details.some((d) => d.startsWith(`${key}=`))
      ) {
        const strVal = String(value).trim();
        const formatted = strVal.includes(" ") ? `"${strVal}"` : strVal;
        details.push(`${key}=${formatted}`);
      }
    }
    for (const key of ["content", "text", "body", "patch", "diff", "code"]) {
      const value = args[key];
      if (typeof value === "string" && value.length > 0 && !details.some((d) => d.startsWith(`${key}=`))) {
        details.push(`${key}=(${value.length} chars)`);
        break;
      }
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

function allowWithFlash(
  effect: ToolEffect,
  target: string,
  request: AutoFlashDecision,
): ToolDecision {
  return { action: "allow", effect, target, flashReview: request };
}

function usesAiApproval(profile: ExecutionProfile): boolean {
  return profile.approval === "never_ask" && profile.autoAll !== true;
}

function ask(
  effect: ToolEffect,
  type: ConfirmDecision["type"],
  label: string,
  target: string,
  allowlist: ConfirmDecision["allowlist"],
  onEdit?: (edited: string) => boolean,
  remember = true,
  purpose?: string,
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
      purpose,
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
  const purpose = purposeOf(event);

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
    if (usesAiApproval(profile)) {
      return allowWithFlash("unknown", event.toolName, {
        command: event.toolName,
        toolName: event.toolName,
        purpose,
        cwd: ctx.cwd,
        effect: "unknown",
      });
    }
    return ask(
      "unknown",
      "action",
      `${event.toolName} without a verifiable path`,
      event.toolName,
      "action",
      undefined,
      false,
      purpose,
    );
  }
  if (targetPath && !isUnder(ctx.cwd, targetPath)) {
    if (usesAiApproval(profile)) {
      return allowWithFlash(effect, targetPath, {
        command: targetPath,
        toolName: event.toolName,
        purpose,
        cwd: ctx.cwd,
        effect,
      });
    }
    return ask(
      effect,
      "path",
      mutation ? "Outside-workspace write" : "Outside-workspace read",
      targetPath,
      "path",
      undefined,
      true,
      purpose,
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
  const input = inputOf(event);
  const purpose = purposeOf(event);
  const risk = classifyCommandRisk(command);
  const paths = referencedCommandPaths(command, ctx.cwd);
  const unverifiablePath = hasUnverifiableCommandPath(command);
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
    if (unverifiablePath) {
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
          undefined,
          true,
          purpose,
        )
      : allow("read", command);
  }
  // AUTO_ALL is explicit user consent: protected paths were checked above,
  // and every other command skips the ordinary approval/reviewer gate.
  if (profile.autoAll && (input.auto_all === true || event.toolName === "bash")) {
    return allow(effect, command);
  }

  // AUTO is AI approval. Safe in-workspace reads/routine work and the
  // existing scoped-persistence allowlist continue without a redundant model
  // round trip; every boundary that would otherwise ask a person is reviewed
  // by AUTO_FLASH instead.
  if (usesAiApproval(profile)) {
    const safeScopedCommand =
      !outsideTarget &&
      !unverifiablePath &&
      (risk === "read" || risk === "routine" ||
        (risk === "persistent" && isAutoScopedPersistentCommand(command)));
    if (safeScopedCommand) return allow(effect, command);
    return allowWithFlash(effect, command, {
      command,
      toolName: event.toolName,
      purpose,
      cwd: ctx.cwd,
      effect,
    });
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
      purpose,
    );
  }
  if (outsideTarget) {
    return ask(
      effect,
      "path",
      "Outside-workspace terminal action",
      outsideTarget,
      "path",
      undefined,
      true,
      purpose,
    );
  }
  if (unverifiablePath) {
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
      purpose,
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
    purpose,
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
  const purpose = purposeOf(event);
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
          undefined,
          true,
          purpose,
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
        purpose,
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

  if (path && isProtectedPath(path) && effect !== "read") {
    return deny(
      "destructive",
      `Protected paths cannot be modified by ${event.toolName}: ${path}`,
      path,
    );
  }

  if (profile.autoAll) {
    return allow(effect, target);
  }

  if (usesAiApproval(profile)) {
    if (effect === "read" || effect === "progress" || effect === "workspace_write") {
      if (path && !isUnder(ctx.cwd, path)) {
        return allowWithFlash(effect, path, {
          command: target,
          toolName: event.toolName,
          purpose,
          input: mcpReviewInput(event.toolName, input),
          cwd: ctx.cwd,
          effect,
        });
      }
      return allow(effect, target);
    }
    return allowWithFlash(effect, target, {
      command: target,
      toolName: event.toolName,
      purpose,
      input: mcpReviewInput(event.toolName, input),
      cwd: ctx.cwd,
      effect,
    });
  }

  // A server-level always-allow rule is an explicit local preference, but it
  // cannot promote a phase or turn unknown/destructive actions into safe ones.
  if (effect === "persistent" && isAlwaysAllowedMcpCall(input, event.toolName)) {
    return allow(effect, target);
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
      purpose,
    );
  }
  if (path && !isUnder(ctx.cwd, path)) {
    return ask(
      effect,
      "path",
      "Outside-workspace tool action",
      path,
      "path",
      undefined,
      true,
      purpose,
    );
  }
  if (
    profile.approval === "never_ask" &&
    !AUTO_CONFIRM_TOOLS.has(event.toolName) &&
    !isMcpTool(event.toolName, input) &&
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
    undefined,
    true,
    purpose,
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
