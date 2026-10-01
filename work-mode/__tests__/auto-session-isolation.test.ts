import test from "node:test";
import assert from "node:assert/strict";
import {
  initializeExecutionContext,
  withSessionScope,
} from "../../lib/execution-context.js";
import {
  checkAutoCircuitBreaker,
  getAutoStepCount,
  isAutoStopped,
  recordAutoStep,
  resetAutoSteps,
  setAutoStopped,
} from "../auto-status.js";

test("A05: AUTO steps, stop flag and circuit breaker are per session", () => {
  const sessionA = {};
  const sessionB = {};
  initializeExecutionContext({ phase: "work", autonomy: "auto", cwd: "/a" }, sessionA);
  initializeExecutionContext({ phase: "work", autonomy: "auto", cwd: "/b" }, sessionB);

  withSessionScope(sessionA, () => {
    for (let i = 0; i < 5; i++) recordAutoStep();
    setAutoStopped(true);
  });

  assert.equal(withSessionScope(sessionA, () => getAutoStepCount()), 5);
  assert.equal(withSessionScope(sessionA, () => isAutoStopped()), true);

  // 未受影响的其他会话
  assert.equal(withSessionScope(sessionB, () => getAutoStepCount()), 0);
  assert.equal(withSessionScope(sessionB, () => isAutoStopped()), false);

  // 无会话作用域的操作只影响全局兼容状态，不回写会话
  resetAutoSteps();
  assert.equal(withSessionScope(sessionA, () => getAutoStepCount()), 5);
});

test("A05: circuit breaker trips independently per session", () => {
  const sessionA = {};
  const sessionB = {};
  initializeExecutionContext({ phase: "work", autonomy: "auto", cwd: "/a" }, sessionA);
  initializeExecutionContext({ phase: "work", autonomy: "auto", cwd: "/b" }, sessionB);

  withSessionScope(sessionA, () => {
    for (let i = 0; i < 100; i++) recordAutoStep();
  });

  assert.equal(withSessionScope(sessionA, () => checkAutoCircuitBreaker().broken), true);
  assert.equal(withSessionScope(sessionB, () => checkAutoCircuitBreaker().broken), false);
  assert.equal(withSessionScope(sessionB, () => getAutoStepCount()), 0);
});
