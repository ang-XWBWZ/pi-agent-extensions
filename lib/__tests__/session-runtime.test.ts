import test from "node:test";
import assert from "node:assert/strict";
import {
  bindSessionExecutionContext,
  ensureSessionRuntime,
  getExecutionContext,
  initializeExecutionContext,
  setExecutionContext,
  withSessionBootstrapScope,
  withSessionScope,
} from "../execution-context.ts";
import {
  computeActiveTools,
  createCapabilityActivationState,
  getDefaultActivationState,
  isCapabilityActive,
} from "../capability-router.ts";
import { getSessionRuntimeById, listSessionRuntimes } from "../session-runtime.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("two sessions keep independent execution contexts", () => {
  const sessionA = {};
  const sessionB = {};

  initializeExecutionContext(
    { phase: "work", autonomy: "auto", cwd: "/a" },
    sessionA,
  );
  initializeExecutionContext(
    { phase: "plan", autonomy: "guarded", cwd: "/b" },
    sessionB,
  );

  assert.equal(getExecutionContext(sessionA).autonomy, "auto");
  assert.equal(getExecutionContext(sessionA).phase, "work");
  // Chat/Plan 强制 Guarded，即使传入 auto。
  assert.equal(getExecutionContext(sessionB).autonomy, "guarded");
  assert.equal(getExecutionContext(sessionB).phase, "plan");
  assert.notEqual(
    getExecutionContext(sessionA).sessionId,
    getExecutionContext(sessionB).sessionId,
  );
});

test("updating one session context never leaks into another", () => {
  const sessionA = {};
  const sessionB = {};
  initializeExecutionContext({ phase: "work", autonomy: "guarded", cwd: "/a" }, sessionA);
  initializeExecutionContext({ phase: "work", autonomy: "guarded", cwd: "/b" }, sessionB);

  withSessionScope(sessionA, () => {
    const current = getExecutionContext();
    setExecutionContext({ ...current, autonomy: "auto", approval: { ...current.approval, preauthorized: true } });
  });

  assert.equal(getExecutionContext(sessionA).autonomy, "auto");
  assert.equal(getExecutionContext(sessionB).autonomy, "guarded");
});

test("concurrent session scopes resolve to their own context", async () => {
  const sessionA = {};
  const sessionB = {};
  initializeExecutionContext({ phase: "work", autonomy: "auto", cwd: "/a" }, sessionA);
  initializeExecutionContext({ phase: "work", autonomy: "guarded", cwd: "/b" }, sessionB);

  const [a, b] = await Promise.all([
    withSessionScope(sessionA, async () => {
      await delay(8);
      return getExecutionContext().autonomy;
    }),
    withSessionScope(sessionB, async () => {
      await delay(1);
      return getExecutionContext().autonomy;
    }),
  ]);

  assert.equal(a, "auto");
  assert.equal(b, "guarded");
});

test("capability activation is per session", () => {
  const sessionA = {};
  const sessionB = {};
  withSessionBootstrapScope(sessionA, () => undefined);
  withSessionBootstrapScope(sessionB, () => undefined);

  withSessionScope(sessionA, () => {
    getDefaultActivationState().activated.add("cap_alpha");
  });

  assert.equal(withSessionScope(sessionA, () => isCapabilityActive("cap_alpha")), true);
  assert.equal(withSessionScope(sessionB, () => isCapabilityActive("cap_alpha")), false);
});

test("unregistered session runtime is guarded, never inherited", () => {
  const session = {};
  ensureSessionRuntime(session);

  const ctx = getExecutionContext(session);
  assert.equal(ctx.autonomy, "guarded");
  assert.equal(ctx.approval.preauthorized, false);
  assert.equal(ctx.approval.inheritToChildren, false);
  assert.equal(ctx.approval.autoAll, false);
});

test("explicit inheritance binding is opt-in and session-local", () => {
  const child = {};
  ensureSessionRuntime(child);
  bindSessionExecutionContext(child, {
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
    runtime: { cwd: "/parent", startedAt: 0 },
  });

  const childCtx = getExecutionContext(child);
  assert.equal(childCtx.autonomy, "auto");
  assert.equal(childCtx.approval.autoAll, true);
});

test("A08: tool projection intersects the phase set with the session allowlist", () => {
  const activation = createCapabilityActivationState();
  const allowed = new Set(["read", "bash"]);
  const projected = computeActiveTools("work", activation, allowed);
  assert.deepEqual(projected.sort(), ["bash", "read"]);
});

test("session runtimes are addressable by explicit session id and releasable", () => {
  const session = {};
  const runtime = initializeExecutionContext(
    { phase: "work", autonomy: "guarded", cwd: "/x" },
    session,
  );
  const found = listSessionRuntimes().find(
    (item) => item.sessionId === getSessionRuntimeById(runtime.sessionId)?.sessionId,
  );
  assert.ok(found);
});
