import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("deployment guidance preserves runtime data and project skill scope", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const readme = read("README.md");
  const workflow = read("skills/pi-ext-workflow/SKILL.md");
  const workflowMirror = read(".pi/skills/pi-ext-workflow/SKILL.md");
  const dev = read("skills/pi-ext-dev/SKILL.md");
  const devMirror = read(".pi/skills/pi-ext-dev/SKILL.md");
  const codeMap = read("skills/pi-ext-code-map/SKILL.md");
  const codeMapMirror = read(".pi/skills/pi-ext-code-map/SKILL.md");
  const agents = read("AGENTS.md");
  const system = read("SYSTEM.md");

  assert.doesNotMatch(readme, /cp\s+-r\s+skills\/\s+~\/\.pi\/agent\/skills\//i);
  assert.doesNotMatch(workflow, /robocopy[^\r\n]*\/MIR/i);
  assert.doesNotMatch(codeMap, /robocopy[^\r\n]*\/MIR/i);
  assert.match(workflow, /\.pi\/skills\/.*用户全局/s);
  assert.match(workflow, /node_modules\/.*models\/.*vectors\.json/s);
  assert.match(workflow, /AGENTS\.md.*SYSTEM\.md.*Copy-Item/s);
  assert.match(agents, /must not call `process\.exit`[\s\S]*durable panel/i);
  assert.match(system, /save session\/output\/panel before abort\/dispose/i);
  assert.equal(workflowMirror, workflow);
  assert.equal(devMirror, dev);
  assert.equal(codeMapMirror, codeMap);
});
