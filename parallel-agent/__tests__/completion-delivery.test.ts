import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const parallelAgentRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("sub-agent completion does not create queued user messages", () => {
  const spawnAgent = readFileSync(join(parallelAgentRoot, "tools", "spawn-agent.ts"), "utf8");
  const widget = readFileSync(join(parallelAgentRoot, "lib", "widget.ts"), "utf8");

  assert.doesNotMatch(spawnAgent, /sendUserMessage/);
  assert.doesNotMatch(widget, /sendUserMessage/);
  assert.match(spawnAgent, /customType:\s*"sub-agent-results"/);
  assert.match(spawnAgent, /display:\s*false/);
  assert.match(spawnAgent, /deliverAs:\s*"followUp",\s*triggerTurn:\s*true/);
  assert.match(widget, /Events\.JOB_COMPLETE/);
  assert.match(widget, /for \(const eventName of genericEvents\) bus\.on\(eventName, onVisibleEvent\)/);
});
