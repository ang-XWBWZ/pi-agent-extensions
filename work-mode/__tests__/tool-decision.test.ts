import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyCommandRisk,
  classifyCustomToolEffect,
  decideToolCall,
  isAutoScopedPersistentCommand,
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
import { autonomyForSessionStart } from "../../lib/execution-context.js";
import {
  compactAuditValue,
  redactAuditText,
  sanitizeAuditValue,
} from "../../lib/audit-sanitize.js";
import {
  abortWorkGoal,
  appendWorkGoalLog,
  createWorkGoal,
} from "../../lib/work-goal-store.js";

const ctx = { cwd: "D:\\repo" } as ExtensionContext;

function profile(
  intent: ExecutionProfile["intent"],
  approval: ExecutionProfile["approval"] = "ask_risky",
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
    decision(profile("plan"), "wiki_read_chunks", { action: "reset" }).action,
    "deny",
  );
  assert.equal(
    decision(profile("plan"), "wiki_read_entry", {
      source: "D:\\outside\\notes",
      path: "topic.md",
    }).action,
    "ask",
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
  assert.equal(decision(profile("chat"), "wiki_read_sources").action, "deny");
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

test("AUTO does not bypass destructive, protected, unknown, or outside-workspace boundaries", () => {
  const auto = profile("work", "never_ask");
  assert.equal(
    decision(auto, "cmd", { command: "git commit -m test" }).action,
    "allow",
  );
  assert.equal(
    decision(auto, "cmd", { command: "Remove-Item -Recurse build" }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "cmd", { command: "git push origin main" }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "powershell", {
      command: "Set-Content D:\\outside\\notes.txt test",
    }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "cmd", {
      command: "npm test --prefix D:\\outside\\project",
    }).action,
    "ask",
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
  const agentsCustomTool = decision(auto, "wiki_DANGER_load", {
    path: "D:\\repo\\.agents",
  });
  assert.notEqual(agentsCustomTool.action, "deny");
  assert.match(agentsCustomTool.warning ?? "", /\.agents/);
  assert.equal(
    decision(auto, "read", { path: "D:\\outside\\notes.txt" }).action,
    "ask",
  );
  assert.equal(decision(auto, "project_unknown_mutation").action, "ask");
  assert.equal(
    decision(auto, "wiki_DANGER_load", { path: "D:\\outside\\notes" }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "manage_providers", { action: "register", name: "demo" }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "switch_model", {
      action: "remove_from_tier",
      tier: "L2",
    }).action,
    "ask",
  );
  assert.equal(
    decision(auto, "long_attention_config_ps", {
      key: "maxItems",
      value: 10,
    }).action,
    "ask",
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
  assert.equal(
    classifyCustomToolEffect("wiki_DANGER_unload", { path: "D:\\notes" }),
    "destructive",
  );
  assert.equal(classifyCustomToolEffect("wiki_DANGER_unload"), "read");
  assert.equal(classifyCustomToolEffect("wiki_read_chunks"), "read");
  assert.equal(classifyCustomToolEffect("read_agent_output"), "read");
  assert.equal(
    classifyCustomToolEffect("wiki_read_chunks", { action: "reset" }),
    "persistent",
  );
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

test("destructive tool confirmations expose the exact target and cannot be remembered", () => {
  const unload = decision(profile("work", "never_ask"), "wiki_DANGER_unload", {
    path: "D:\\notes",
  });
  assert.equal(unload.action, "ask");
  assert.match(unload.target ?? "", /D:\\notes/);
  assert.equal(unload.confirm?.remember, false);

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
