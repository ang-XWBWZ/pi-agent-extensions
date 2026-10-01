import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyCommandRisk,
  classifyCustomToolEffect,
  decideToolCall,
  isAutoScopedPersistentCommand,
  parseMcpCallInfo,
} from "../tool-decision.js";
import {
  formatProfileForPrompt,
  profileFromPhase,
  type ExecutionProfile,
} from "../execution-profile.js";
import type { ExecutionContext } from "../../lib/workflow-types.js";
import {
  advancePlanWithEvidence,
  advancePlanSteps,
  hasUnfinishedPlan,
  isPlanComplete,
  setPlanStepStatus,
} from "../plan-state.js";
import type { PlanStep } from "../types.js";
import {
  autoAllForSessionStart,
  autonomyForSessionStart,
} from "../../lib/execution-context.js";
import {
  compactAuditValue,
  compactReviewValue,
  redactAuditText,
  sanitizeAuditValue,
  sanitizeToolInput,
} from "../../lib/audit-sanitize.js";
import { classifyMcpToolEffect } from "../../mcp/lib/policy.js";
import {
  abortWorkGoal,
  appendWorkGoalLog,
  createWorkGoal,
} from "../../lib/work-goal-store.js";

const ctx = { cwd: "D:\\repo" } as ExtensionContext;

function profile(
  intent: ExecutionProfile["intent"],
  approval: ExecutionProfile["approval"] = "ask_risky",
  autoAll = false,
): ExecutionProfile {
  return {
    intent,
    boundary:
      intent === "work"
        ? approval === "never_ask"
          ? "full_access"
          : "workspace_write"
        : "read_only",
    approval,
    ledger: "off",
    isSubAgent: false,
    autoAll,
    label: intent.toUpperCase(),
  };
}

function decision(
  executionProfile: ExecutionProfile,
  toolName: string,
  input: Record<string, unknown> = {},
) {
  return decideToolCall(
    executionProfile,
    { toolName, toolCallId: "test", input },
    ctx,
  );
}

test("command risk separates inspection, routine work, persistence, and deletion", () => {
  assert.equal(classifyCommandRisk("git status"), "read");
  assert.equal(classifyCommandRisk("Get-Content README.md"), "read");
  assert.equal(classifyCommandRisk("npm test"), "routine");
  assert.equal(classifyCommandRisk("git commit -m test"), "persistent");
  assert.equal(classifyCommandRisk("git restore src/app.ts"), "destructive");
  assert.equal(classifyCommandRisk("git clean -fd"), "destructive");
  assert.equal(
    classifyCommandRisk("git switch --discard-changes main"),
    "destructive",
  );
  assert.equal(classifyCommandRisk("Remove-Item -Recurse build"), "destructive");
  assert.equal(classifyCommandRisk("node custom-script.js"), "unknown");
  assert.equal(
    classifyCommandRisk("npm test && git status"),
    "routine",
  );
});

test("AUTO command preauthorization is limited to recognized scoped persistence", () => {
  assert.equal(isAutoScopedPersistentCommand("git add . && git commit -m test"), true);
  assert.equal(isAutoScopedPersistentCommand("npm install"), true);
  assert.equal(isAutoScopedPersistentCommand("npm install -g demo"), false);
  assert.equal(isAutoScopedPersistentCommand("git push origin main"), false);
  assert.equal(isAutoScopedPersistentCommand("Set-Content D:\\outside\\x.txt hi"), false);
});

test("PLAN allows recognized read-only diagnostics and denies side effects", () => {
  assert.equal(decision(profile("plan"), "cmd", { command: "git status" }).action, "allow");
  assert.equal(
    decision(profile("plan"), "powershell", {
      command: "Get-Content README.md",
    }).action,
    "allow",
  );
  assert.equal(
    decision(profile("plan"), "cmd", { command: "npm install demo" }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "write", {
      path: "D:\\repo\\src\\new.ts",
    }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "mcp_manage", { action: "list" }).action,
    "allow",
  );
  assert.equal(
    decision(profile("plan"), "mcp_manage", { action: "add", name: "pwiki" }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "mcp_call", { server: "pwiki", tool: "wiki_search" }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "manage_requirements", {
      action: "clear",
      force: true,
    }).action,
    "ask",
  );
  assert.equal(
    decision(profile("plan"), "spawn_agent", {
      tasks: [{ id: "implicit", prompt: "inspect" }],
    }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "spawn_agent", {
      tasks: [{ id: "explicit", prompt: "inspect", phase: "plan" }],
    }).action,
    "allow",
  );
  assert.equal(
    decision(profile("plan"), "send_agent_message", {
      taskId: "worker",
      message: "change files",
    }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "control_agent", { action: "resume" }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "control_agent", { action: "list" }).action,
    "allow",
  );
  assert.equal(
    decision(profile("plan"), "read_agent_output", {
      jobId: "job-1",
      taskId: "task-1",
    }).action,
    "allow",
  );
  assert.equal(
    decision(profile("plan"), "powershell", {
      command: "Get-Content D:\\outside\\notes.txt",
    }).action,
    "ask",
  );
  assert.equal(
    decision(profile("plan"), "powershell", {
      command: "Get-Content $env:USERPROFILE\\notes.txt",
    }).action,
    "deny",
  );
});

test("CHAT is conversation-only, including read tools", () => {
  assert.equal(
    decision(profile("chat"), "read", { path: "D:\\repo\\README.md" }).action,
    "deny",
  );
  assert.equal(decision(profile("chat"), "mcp_manage", { action: "list" }).action, "deny");
  assert.match(formatProfileForPrompt(profile("chat")), /do not call tools/i);
  assert.doesNotMatch(formatProfileForPrompt(profile("chat")), /routine scoped work/i);
});

test("guarded WORK keeps routine commands flowing and asks at risk boundaries", () => {
  const guarded = profile("work");
  assert.equal(decision(guarded, "cmd", { command: "git status" }).action, "allow");
  assert.equal(decision(guarded, "cmd", { command: "npm test" }).action, "allow");
  assert.equal(
    decision(guarded, "cmd", { command: "git commit -m test" }).action,
    "ask",
  );
  assert.equal(
    decision(guarded, "cmd", { command: "Remove-Item -Recurse build" }).action,
    "ask",
  );
});

test("AUTO uses AI approval, while AUTO_ALL requires explicit session authorization", () => {
  const auto = profile("work", "never_ask");
  const autoRequest = decision(auto, "powershell", {
    command: "Remove-Item -Recurse build",
    auto_all: true,
  });
  assert.equal(autoRequest.action, "allow");
  assert.equal(autoRequest.flashReview?.effect, "destructive");

  const autoAll = profile("work", "never_ask", true);
  const fullConsent = decision(autoAll, "powershell", {
      command: "Remove-Item -Recurse build",
      purpose: "清理本次构建生成目录",
      auto_all: true,
    });
  assert.equal(fullConsent.action, "allow");
  assert.equal(fullConsent.flashReview, undefined);
  assert.equal(
    decision(autoAll, "cmd", { command: "node custom-script.js", auto_all: true }).action,
    "allow",
  );
  assert.equal(
    decision(autoAll, "bash", { command: "rm -rf build" }).action,
    "allow",
  );
  assert.equal(
    decision(autoAll, "cmd", {
      command: "Set-Content D:\\repo\\.git\\config test",
      auto_all: true,
    }).action,
    "deny",
  );
  const described = decision(auto, "cmd", {
    command: "git push origin main",
    purpose: "推送已验证的变更",
  });
  assert.equal(described.flashReview?.purpose, "推送已验证的变更");
});

test("AUTO routes command approval boundaries to AI and keeps protected paths denied", () => {
  const auto = profile("work", "never_ask");
  assert.equal(
    decision(auto, "cmd", { command: "git commit -m test" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "cmd", { command: "Remove-Item -Recurse build" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "cmd", { command: "git push origin main" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "powershell", {
      command: "Set-Content D:\\outside\\notes.txt test",
    }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "cmd", {
      command: "npm test --prefix D:\\outside\\project",
    }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "powershell", {
      command: "Set-Content D:\\repo\\.git\\config test",
    }).action,
    "deny",
  );
  assert.equal(
    decision(auto, "write", { path: "D:\\repo\\.git\\config" }).action,
    "deny",
  );
  const agentsWrite = decision(auto, "write", {
    path: "D:\\repo\\.agents\\rules.md",
  });
  assert.equal(agentsWrite.action, "allow");
  assert.match(agentsWrite.warning ?? "", /\.agents/);
  const claudeWrite = decision(auto, "write", {
    path: "D:\\repo\\.claude\\settings.json",
  });
  assert.equal(claudeWrite.action, "allow");
  assert.match(claudeWrite.warning ?? "", /\.claude/);
  const agentsDirectoryWrite = decision(auto, "write", {
    path: "D:\\repo\\.agents",
  });
  assert.equal(agentsDirectoryWrite.action, "allow");
  assert.match(agentsDirectoryWrite.warning ?? "", /\.agents/);
  const agentsShellWrite = decision(auto, "powershell", {
    command: "Set-Content .agents\\rules.md test",
  });
  assert.notEqual(agentsShellWrite.action, "deny");
  assert.match(agentsShellWrite.warning ?? "", /\.agents/);
  assert.equal(
    decision(auto, "read", { path: "D:\\outside\\notes.txt" }).action,
    "allow",
  );
  assert.equal(decision(auto, "project_unknown_mutation").action, "allow");
  assert.equal(
    decision(auto, "mcp_call", { server: "unknown", tool: "unknown_write" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "manage_providers", { action: "register", name: "demo" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "switch_model", {
      action: "remove_from_tier",
      tier: "L2",
    }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "long_attention_config_ps", {
      key: "maxItems",
      value: 10,
    }).action,
    "allow",
  );
});

test("custom tool effects cover persistent and destructive extension tools", () => {
  assert.equal(
    classifyCustomToolEffect("manage_providers", { action: "list" }),
    "read",
  );
  assert.equal(
    classifyCustomToolEffect("manage_providers", { action: "register" }),
    "persistent",
  );
  assert.equal(classifyCustomToolEffect("mcp_manage", { action: "list" }), "read");
  assert.equal(classifyCustomToolEffect("mcp_manage", { action: "add" }), "persistent");
  assert.equal(classifyCustomToolEffect("mcp_manage", { action: "remove" }), "destructive");
  assert.equal(classifyCustomToolEffect("mcp_manage", { action: "disconnect" }), "progress");
  assert.equal(classifyCustomToolEffect("mcp_call"), "persistent");
  assert.equal(classifyCustomToolEffect("mcp_discover", { action: "resource" }), "read");
  assert.equal(classifyCustomToolEffect("read_agent_output"), "read");
  assert.equal(
    classifyCustomToolEffect("manage_plan", {
      action: "clear",
      force: true,
    }),
    "destructive",
  );
  assert.equal(
    classifyCustomToolEffect("manage_plan", {
      action: "delete_step",
      stepId: 2,
    }),
    "destructive",
  );
  assert.equal(
    classifyCustomToolEffect("long_attention_config_ps"),
    "read",
  );
  assert.equal(
    classifyCustomToolEffect("long_attention_clear_ps", { scope: "all" }),
    "destructive",
  );
  assert.equal(
    classifyCustomToolEffect("control_agent", { action: "save" }),
    "persistent",
  );
  assert.equal(
    classifyCustomToolEffect("update_agent_task", {
      status: "running",
      progress: 40,
    }),
    "progress",
  );
  assert.equal(classifyCustomToolEffect("project_write_config"), "unknown");
});

test("MCP calls use only the locally installed server policy registry", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.__pi_mcp_policy_registry;
  globals.__pi_mcp_policy_registry = {
    classifyCall: (server: string, tool: string) =>
      server === "pwiki" && tool === "wiki_search"
        ? "read"
      : server === "pwiki" && tool === "wiki_modify_entry"
        ? "persistent"
        : server === "trusted" && tool === "save"
          ? "persistent"
    : server === "trusted" && tool === "erase"
          ? "destructive"
          : "unknown",
    isAlwaysAllowed: (server: string) => server === "trusted",
    resolveAlias: (toolName: string) => toolName === "wiki" ? "pwiki" : undefined,
  };
  try {
    assert.equal(
      classifyCustomToolEffect("mcp_call", { server: "pwiki", tool: "wiki_search" }),
      "read",
    );
    assert.equal(
      decision(profile("plan"), "mcp_call", { server: "pwiki", tool: "wiki_search" }).action,
      "allow",
    );
    assert.equal(
    decision(profile("work", "never_ask"), "mcp_call", {
      server: "pwiki",
      tool: "wiki_modify_entry",
    }).action,
      "allow",
    );
    const mcpReview = decision(profile("work", "never_ask"), "mcp_call", {
      server: "pwiki",
      tool: "wiki_modify_entry",
      arguments: {
        path: "docs/a.md",
        query: "CORS",
        apiKey: "secret-value",
      },
    });
    assert.equal(mcpReview.action, "allow");
    assert.deepEqual(mcpReview.flashReview?.input, {
      server: "pwiki",
      tool: "wiki_modify_entry",
      arguments: {
        path: "docs/a.md",
        query: "CORS",
        apiKey: "secret-value",
      },
    });
    assert.equal(
      classifyCustomToolEffect("wiki", {
        method: "wiki_modify_entry",
        arguments: { path: "docs/a.md" },
      }),
      "persistent",
    );
    const aliasReview = decision(profile("work", "never_ask"), "wiki", {
      method: "wiki_modify_entry",
      arguments: { path: "docs/a.md" },
    });
    assert.equal(aliasReview.action, "allow");
    assert.match(aliasReview.target ?? "", /method=wiki_modify_entry/);
    assert.deepEqual(aliasReview.flashReview?.input, {
      server: "pwiki",
      tool: "wiki_modify_entry",
      arguments: { path: "docs/a.md" },
    });
    assert.equal(
      decision(profile("work"), "mcp_call", {
        server: "trusted",
        tool: "save",
      }).action,
      "allow",
    );
    assert.equal(
      decision(profile("plan"), "mcp_call", {
        server: "trusted",
        tool: "save",
      }).action,
      "deny",
    );
    assert.equal(
    decision(profile("work", "never_ask"), "mcp_call", {
      server: "trusted",
      tool: "unknown",
    }).action,
      "allow",
    );
    assert.equal(
    decision(profile("work", "never_ask"), "mcp_call", {
      server: "trusted",
      tool: "erase",
    }).action,
      "allow",
    );
    assert.equal(
      classifyCustomToolEffect("mcp_call", { server: "other", tool: "wiki_search" }),
      "unknown",
    );
  } finally {
    if (previous === undefined) delete globals.__pi_mcp_policy_registry;
    else globals.__pi_mcp_policy_registry = previous;
  }
});

test("destructive tool confirmations expose the exact target and cannot be remembered", () => {
  const remove = decision(profile("work", "never_ask"), "mcp_manage", {
    action: "remove",
    name: "pwiki",
  });
  assert.equal(remove.action, "allow");
  assert.equal(remove.flashReview?.effect, "destructive");
  assert.match(remove.target ?? "", /name=pwiki/);
  assert.equal(remove.confirm, undefined);

  const kill = decision(profile("work"), "control_agent", {
    action: "kill",
    jobId: "job-1",
    taskId: "task-2",
  });
  assert.match(kill.target ?? "", /jobId=job-1/);
  assert.match(kill.target ?? "", /taskId=task-2/);
});

test("audit ledger cannot elevate CHAT or PLAN into Work", () => {
  assert.equal(decision(profile("chat"), "work_goal_start").action, "deny");
  assert.equal(decision(profile("plan"), "work_goal_start").action, "deny");
  assert.equal(decision(profile("work"), "work_goal_start").action, "allow");

  const guardedAudit: ExecutionContext = {
    sessionId: "audit",
    phase: "work",
    autonomy: "guarded",
    ledger: "work_goal",
    approval: {
      interactive: true,
      preauthorized: false,
      inheritToChildren: false,
      autoAll: false,
    },
    runtime: { cwd: "D:\\repo", startedAt: 0 },
  };
  const auditProfile = profileFromPhase({
    phase: "work",
    isSubAgent: false,
    executionContext: guardedAudit,
  });
  assert.equal(auditProfile.approval, "ask_risky");
  assert.equal(auditProfile.ledger, "work_goal");
});

test("phase remains authoritative even if stale execution context says auto", () => {
  const staleAuto: ExecutionContext = {
    sessionId: "test",
    phase: "work",
    autonomy: "auto",
    ledger: "off",
    approval: {
      interactive: false,
      preauthorized: true,
      inheritToChildren: true,
      autoAll: false,
    },
    runtime: { cwd: "D:\\repo", startedAt: 0 },
  };
  assert.equal(
    profileFromPhase({
      phase: "chat",
      isSubAgent: false,
      executionContext: staleAuto,
    }).intent,
    "chat",
  );
  assert.equal(autonomyForSessionStart(false, staleAuto), "guarded");
  assert.equal(autonomyForSessionStart(true, staleAuto), "auto");
});

test("AUTO_ALL inherits only to explicitly authorized child sessions", () => {
  const inherited: ExecutionContext = {
    sessionId: "parent",
    phase: "work",
    autonomy: "auto",
    ledger: "off",
    approval: {
      interactive: false,
      preauthorized: true,
      inheritToChildren: true,
      autoAll: true,
    },
    runtime: { cwd: "D:\\repo", startedAt: 0 },
  };
  assert.equal(autoAllForSessionStart(false, inherited), false);
  assert.equal(autoAllForSessionStart(true, inherited), true);
  assert.equal(
    autoAllForSessionStart(true, {
      ...inherited,
      approval: { ...inherited.approval, inheritToChildren: false },
    }),
    false,
  );
});

test("plan progression is atomic and never fabricates completion", () => {
  const steps: PlanStep[] = [
    { id: 1, text: "inspect", status: "current" },
    { id: 2, text: "patch", status: "pending" },
    { id: 3, text: "verify", status: "pending" },
  ];

  const first = advancePlanSteps(steps, "done");
  assert.equal(first.ok, true);
  assert.deepEqual(
    steps.map((step) => step.status),
    ["done", "current", "pending"],
  );
  assert.equal(isPlanComplete(steps), false);
  assert.equal(hasUnfinishedPlan(steps), true);

  const failed = advancePlanSteps(steps, "error");
  assert.equal(failed.ok, true);
  assert.deepEqual(
    steps.map((step) => step.status),
    ["done", "error", "pending"],
  );
  assert.equal(isPlanComplete(steps), false);
});

test("plan completion accepts only explicit done or skipped terminal states", () => {
  const steps: PlanStep[] = [
    { id: 1, text: "change", status: "done" },
    { id: 2, text: "obsolete check", status: "skipped" },
  ];
  assert.equal(isPlanComplete(steps), true);
  assert.equal(hasUnfinishedPlan(steps), false);
  assert.deepEqual(advancePlanSteps(steps, "done"), {
    ok: false,
    error: "no_current_step",
  });
});

test("truthful plan transitions require evidence and preserve step order", () => {
  const steps: PlanStep[] = [
    { id: 1, text: "inspect", status: "current" },
    { id: 2, text: "change", status: "pending" },
  ];

  assert.deepEqual(advancePlanWithEvidence(steps, "done", ""), {
    ok: false,
    error: "missing_evidence",
  });
  assert.equal(steps[0].status, "current");

  const advanced = advancePlanWithEvidence(
    steps,
    "done",
    "repository inspected",
    100,
  );
  assert.equal(advanced.ok, true);
  assert.equal(steps[0].evidence, "repository inspected");
  assert.equal(steps[0].updatedAt, 100);
  assert.equal(steps[1].status, "current");

  assert.deepEqual(
    setPlanStepStatus(steps, 1, "done", "fabricated"),
    {
      ok: false,
      error: "non_current_terminal_transition",
    },
  );
});

test("audit sanitization redacts nested fields, assignments, and bearer tokens", () => {
  assert.equal(
    redactAuditText("Authorization: Bearer abc.def and token=xyz"),
    "Authorization: [redacted] and token=[redacted]",
  );
  assert.deepEqual(
    sanitizeAuditValue({
      apiKey: "secret-value",
      nested: { password: "p", safe: "token=abc" },
    }),
    {
      apiKey: "[redacted]",
      nested: { password: "[redacted]", safe: "token=[redacted]" },
    },
  );
  assert.equal(compactAuditValue(undefined), "undefined");

  const goal = createWorkGoal({ goal: "inspect token=abc" });
  assert.equal(goal.goal, "inspect token=[redacted]");
  assert.equal(goal.autonomy, "guarded");
  const log = appendWorkGoalLog(goal.id, {
    type: "note",
    message: "Authorization: Bearer private",
    metadata: { password: "private" },
  });
  assert.equal(log.message, "Authorization: [redacted]");
  assert.deepEqual(log.metadata, { password: "[redacted]" });
  abortWorkGoal(goal.id, "test cleanup");
});

test("parseMcpCallInfo parses call_mcp_tool, mcp_call, alias, direct, and namespaced tools", () => {
  // 1. call_mcp_tool (Antigravity format)
  const antigravityCall = parseMcpCallInfo("call_mcp_tool", {
    ServerName: "pwiki",
    ToolName: "wiki_create_entry",
    Arguments: { entry: "docs/spec.md", title: "Spec" },
  });
  assert.deepEqual(antigravityCall, {
    server: "pwiki",
    tool: "wiki_create_entry",
    arguments: { entry: "docs/spec.md", title: "Spec" },
    isDirect: false,
  });

  // 2. mcp_call
  const standardMcp = parseMcpCallInfo("mcp_call", {
    server: "pwiki",
    tool: "wiki_modify_entry",
    arguments: { path: "docs/api.md" },
  });
  assert.deepEqual(standardMcp, {
    server: "pwiki",
    tool: "wiki_modify_entry",
    arguments: { path: "docs/api.md" },
    isDirect: false,
  });

  // 3. namespaced tool
  const namespaced = parseMcpCallInfo("mcp__pwiki__wiki_search", { query: "auth" });
  assert.deepEqual(namespaced, {
    server: "pwiki",
    tool: "wiki_search",
    arguments: { query: "auth" },
    isDirect: true,
  });

  // 4. direct wiki_* fallback
  const directFallback = parseMcpCallInfo("wiki_area_read", { path: "areas/main" });
  assert.deepEqual(directFallback, {
    server: "pwiki",
    tool: "wiki_area_read",
    arguments: { path: "areas/main" },
    isDirect: true,
  });

  // 5. non-MCP tool returns undefined
  assert.equal(parseMcpCallInfo("manage_providers", { action: "list" }), undefined);
});

test("AUTO approval passes full MCP parameters, synthesizes purpose, and enriches target", () => {
  const auto = profile("work", "never_ask");

  // 1. call_mcp_tool passing parameters to flashReview
  const callMcp = decision(auto, "call_mcp_tool", {
    ServerName: "pwiki",
    ToolName: "wiki_create_entry",
    Arguments: {
      entry: "docs/architecture.md",
      title: "System Architecture",
      content: "This document describes the system architecture in detail...",
    },
    toolAction: "Creating architecture document",
  });
  assert.equal(callMcp.action, "allow");
  assert.equal(callMcp.flashReview?.toolName, "call_mcp_tool");
  assert.equal(callMcp.flashReview?.purpose, "Creating architecture document");
  assert.deepEqual(callMcp.flashReview?.input, {
    server: "pwiki",
    tool: "wiki_create_entry",
    arguments: {
      entry: "docs/architecture.md",
      title: "System Architecture",
      content: "This document describes the system architecture in detail...",
    },
  });
  assert.match(callMcp.flashReview?.command ?? "", /server=pwiki/);
  assert.match(callMcp.flashReview?.command ?? "", /tool=wiki_create_entry/);
  assert.match(callMcp.flashReview?.command ?? "", /entry=docs\/architecture\.md/);
  assert.match(callMcp.flashReview?.command ?? "", /content=\(\d+ chars\)/);

  // 2. Direct tool wiki_modify_entry derives purpose when omitted
  const directMcp = decision(auto, "wiki_modify_entry", {
    entry: "docs/api.md",
    content: "Updated API contents",
  });
  assert.equal(directMcp.action, "allow");
  assert.equal(directMcp.flashReview?.toolName, "wiki_modify_entry");
  assert.equal(directMcp.flashReview?.purpose, "调用 MCP 工具 pwiki/wiki_modify_entry [docs/api.md]");
  assert.deepEqual(directMcp.flashReview?.input, {
    server: "pwiki",
    tool: "wiki_modify_entry",
    arguments: {
      entry: "docs/api.md",
      content: "Updated API contents",
    },
  });

  // 3. Non-MCP custom tools preserve input instead of returning undefined
  const customTool = decision(auto, "manage_providers", {
    action: "register",
    name: "custom-ollama",
    baseUrl: "http://localhost:11434",
  });
  assert.equal(customTool.action, "allow");
  assert.deepEqual(customTool.flashReview?.input, {
    action: "register",
    name: "custom-ollama",
    baseUrl: "http://localhost:11434",
  });
});

test("compactReviewValue handles large body fields and redacts secrets", () => {
  const largeContent = "x".repeat(5000);
  const formatted = compactReviewValue({
    server: "pwiki",
    tool: "wiki_modify_entry",
    arguments: {
      entry: "docs/large.md",
      content: largeContent,
      commitMessage: "Large update",
      apiKey: "secret-token-12345",
    },
  });

  assert.match(formatted, /"entry":"docs\/large\.md"/);
  assert.match(formatted, /"commitMessage":"Large update"/);
  assert.match(formatted, /\[共 5000 字符\]/);
  assert.match(formatted, /"apiKey":"\[redacted\]"/);
  assert.doesNotMatch(formatted, /secret-token-12345/);
});

test("policy correctly classifies new pwiki tools", () => {
  assert.equal(classifyMcpToolEffect("pwiki", "wiki_area_list"), "read");
  assert.equal(classifyMcpToolEffect("pwiki", "wiki_area_read"), "read");
  assert.equal(classifyMcpToolEffect("pwiki", "wiki_area_write"), "persistent");
  assert.equal(classifyMcpToolEffect("pwiki", "wiki_configure_reranker"), "persistent");
});

test("classifies browser reads and chrome desktop access as private_read", () => {
  assert.equal(
    classifyCustomToolEffect("browser_read", { mode: "active" }),
    "private_read",
  );
  assert.equal(
    classifyCustomToolEffect("browser_read", { mode: "headless" }),
    "read",
  );
  assert.equal(classifyCustomToolEffect("chrome_tabs"), "private_read");
  assert.equal(classifyCustomToolEffect("chrome_screenshot"), "private_read");
});

test("decideToolCall requires explicit user confirmation for private_read in guarded mode", () => {
  const p = profile("work", "ask_risky");
  const decision = decideToolCall(
    p,
    { toolCallId: "call-1", toolName: "browser_read", input: { mode: "active" } },
    ctx,
  );
  assert.equal(decision.action, "ask");
  assert.equal(decision.effect, "private_read");
  assert.equal(decision.confirm?.label, "Access private desktop browser session");
  assert.equal(decision.confirm?.remember, true);
});

test("sanitizeToolInput always redacts chrome_act type payloads unconditionally", () => {
  const raw = {
    action: "type",
    selector: "#login-input",
    text: "super-secret-password-123",
  };
  const sanitized = sanitizeToolInput("chrome_act", raw) as Record<string, unknown>;
  assert.equal(sanitized.text, "[redacted]");
  assert.equal(sanitized.textLength, 25);
  assert.doesNotMatch(JSON.stringify(sanitized), /super-secret-password/);
});
