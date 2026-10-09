import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectStableContext, STABLE_CONTEXT_ENTRY } from "../stable-context.js";

function harness(manager = SessionManager.inMemory("/workspace")) {
  const pi: any = { appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data) };
  const ctx: any = { sessionManager: manager };
  const project = (messages: any[], channel: string, content?: string, options = {}) =>
    projectStableContext(pi, ctx, messages, channel, content, options);
  return { manager, project };
}

const user = (text: string, timestamp = 1): any => ({ role: "user", content: text, timestamp });

test("all injection channels keep their original order as raw history grows", () => {
  const h = harness();
  const history = [user("task")];
  let first = h.project(history, "ps", "PS");
  first = h.project(first, "agent-message", "Agent result", { repeat: true });
  first = h.project(first, "requirements", "Contract v1");
  first = h.project(first, "runtime", "Guarded");
  assert.equal(history.length, 1);

  const nextHistory = [...history, user("tool result", 2)];
  let second = h.project(nextHistory, "ps", "PS");
  second = h.project(second, "agent-message");
  second = h.project(second, "requirements", "Contract v2");
  second = h.project(second, "runtime", "Auto");
  assert.deepEqual(second.slice(0, first.length), first, "the entire previous request must remain a prefix");
  assert.deepEqual(second.slice(first.length).map((m: any) => m.content), ["tool result", "Contract v2", "Auto"]);
  assert.equal(h.project(second, "runtime", "Auto"), second, "unchanged projections are idempotent");
});

test("clear notices append without removing a historical reminder", () => {
  const h = harness();
  const history = [user("task")];
  const first = h.project(history, "ps", "Old reminder");
  const second = h.project([...history, user("cleared", 2)], "ps", undefined, { inactiveContent: "No active reminder" });
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal((second.at(-1) as any).content, "No active reminder");
  assert.equal(h.project(second, "ps", undefined, { inactiveContent: "No active reminder" }), second);
});

test("a branch cannot inherit a directive written after its fork point", () => {
  const h = harness();
  const history = [user("task")];
  const forkPoint = h.manager.appendMessage(history[0]);
  h.project(history, "runtime", "Auto on abandoned branch");
  h.manager.branch(forkPoint);
  const next = h.project(history, "runtime", "Guarded on current branch");
  assert.deepEqual(next.map((m: any) => m.content), ["task", "Guarded on current branch"]);
});

test("compacted or edited source prefixes do not resurrect old injection records", () => {
  const h = harness();
  h.project([user("original secret task")], "requirements", "Original contract");
  const next = h.project([user("compacted summary")], "requirements", "Current contract");
  assert.deepEqual(next.map((m: any) => m.content), ["compacted summary", "Current contract"]);
});

test("a new session on the same manager does not inherit projection state", () => {
  const h = harness();
  const history = [user("same text")];
  h.project(history, "runtime", "Auto in old session");
  h.manager.newSession();
  const next = h.project(history, "runtime", "Guarded in new session");
  assert.deepEqual(next.map((m: any) => m.content), ["same text", "Guarded in new session"]);
});

test("the native SDK journal restores the exact projection in a new manager", () => {
  const h = harness();
  const history = [user("task")];
  h.manager.appendMessage(history[0]);
  const first = h.project(history, "runtime", "Guarded");
  const entries = [h.manager.getHeader()!, ...h.manager.getEntries()];
  const restored = harness(SessionManager.inMemory("/workspace", undefined, entries));
  const second = restored.project(history, "runtime", "Guarded");
  assert.deepEqual(second, first);
  assert.equal(restored.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === STABLE_CONTEXT_ENTRY).length, 1);
});

test("repeated reminders append only at new boundaries and notify once", () => {
  const h = harness();
  let appended = 0;
  const options = { repeat: true, onAppend: () => appended++ };
  const history = [user("task")];
  const first = h.project(history, "ps", "Reminder", options);
  assert.equal(h.project(first, "ps", "Reminder", options), first);
  const second = h.project([...history, user("next", 2)], "ps", "Reminder", options);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(appended, 2);
});
