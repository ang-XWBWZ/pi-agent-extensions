import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { workflowPromptForPhase } from "../types.js";
import { classifyCustomToolEffect } from "../tool-decision.js";
import {
  BASELINE_CORE_TOOLS,
  CHAT_CORE_TOOLS,
  PLAN_CORE_TOOLS,
} from "../../lib/capability-router.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const extensionsRoot = root;

function tsFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === "dist" || entry.name === "scripts")) {
      return [];
    }
    return entry.isDirectory()
      ? tsFiles(path)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  if (
    ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
  ) {
    return property.name.text;
  }
  return "";
}

test("every flat prompt guideline names its tool and stays within budget", () => {
  let toolCount = 0;
  let guidelineCount = 0;
  let guidelineChars = 0;
  const violations: string[] = [];
  const registeredToolNames: string[] = [];

  for (const file of tsFiles(extensionsRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "registerTool" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const object = node.arguments[0];
        const get = (name: string) =>
          object.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              propertyName(property) === name,
          ) as ts.PropertyAssignment | undefined;
        const nameProperty = get("name");
        const guidelinesProperty = get("promptGuidelines");
        if (
          nameProperty &&
          ts.isStringLiteral(nameProperty.initializer)
        ) {
          toolCount++;
          const toolName = nameProperty.initializer.text;
          registeredToolNames.push(toolName);
          if (
            guidelinesProperty &&
            ts.isArrayLiteralExpression(guidelinesProperty.initializer)
          ) {
            for (const item of guidelinesProperty.initializer.elements) {
              if (
                !ts.isStringLiteral(item) &&
                !ts.isNoSubstitutionTemplateLiteral(item)
              ) {
                violations.push(
                  `${relative(root, file)}: ${toolName} has a dynamic guideline`,
                );
                continue;
              }
              guidelineCount++;
              guidelineChars += item.text.length;
              if (!item.text.toLowerCase().includes(toolName.toLowerCase())) {
                violations.push(
                  `${relative(root, file)}: guideline does not name ${toolName}`,
                );
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(violations, []);
  assert.ok(toolCount >= 25, `expected the current tool set, got ${toolCount}`);
  assert.ok(guidelineCount <= 80, `guideline budget exceeded: ${guidelineCount}`);
  assert.ok(guidelineChars <= 8_000, `guideline char budget exceeded: ${guidelineChars}`);
  const unclassified = registeredToolNames.filter(
    (name) =>
      name !== "cmd" &&
      name !== "powershell" &&
      name !== "call_capability" && classifyCustomToolEffect(name) === "unknown",
  );
  assert.deepEqual(
    unclassified,
    [],
    "every registered custom tool must have an explicit risk classification",
  );
});

test("runtime workflow prompts are short and phase-specific", () => {
  const prompts = ["chat", "plan", "work"].map((phase) =>
    workflowPromptForPhase(phase as "chat" | "plan" | "work"),
  );
  assert.ok(prompts.every((prompt) => prompt.length < 700));
  assert.match(prompts[0], /CHAT/);
  assert.match(prompts[1], /PLAN/);
  assert.match(prompts[2], /WORK/);
});

test("static contracts stay separate and authorization-safe", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const system = readFileSync(join(root, "SYSTEM.md"), "utf8");

  assert.ok(agents.length <= 21_000, `AGENTS.md budget exceeded: ${agents.length}`);
  assert.ok(system.length <= 22_000, `SYSTEM.md budget exceeded: ${system.length}`);
  assert.ok(
    agents.length + system.length <= 43_000,
    `combined contract budget exceeded: ${agents.length + system.length}`,
  );

  assert.match(agents, /defines PiAgent's judgment, initiative/i);
  assert.doesNotMatch(agents, /work_goal_start|classify every tool call/i);

  assert.match(system, /`auto` is not a phase/i);
  assert.match(system, /Audit inherits authorization; it never changes phase or grants Auto/i);
  assert.match(system, /No prompt, tool argument, work goal, child task, or project tool may/i);
  assert.match(system, /Destructive and unresolved-unknown approvals are one-shot/i);

  const paragraphs = (text: string) =>
    text
      .split(/\r?\n\r?\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter((paragraph) => paragraph.length >= 80);
  const systemParagraphs = new Set(paragraphs(system));
  const duplicated = paragraphs(agents).filter((paragraph) =>
    systemParagraphs.has(paragraph),
  );
  assert.deepEqual(duplicated, [], "long policy paragraphs must have one owner");
});

test("structured planning has no markdown or synthetic-message trigger", () => {
  const planFeature = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "plan-feature.ts"),
    "utf8",
  );
  assert.doesNotMatch(planFeature, /message_end/);
  assert.doesNotMatch(planFeature, /sendUserMessage/);
  assert.doesNotMatch(planFeature, /Execution\s+Plan/);
});

test("PCS Cache-Safe: only baseline core tools may define promptGuidelines or promptSnippet", () => {
  const baselineTools = new Set<string>([
    ...BASELINE_CORE_TOOLS,
    ...CHAT_CORE_TOOLS,
    ...PLAN_CORE_TOOLS,
  ]);

  const cacheViolations: string[] = [];
  let scannedTools = 0;

  for (const file of tsFiles(extensionsRoot)) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "registerTool" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const object = node.arguments[0];
        const get = (name: string) =>
          object.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              propertyName(property) === name,
          ) as ts.PropertyAssignment | undefined;
        scannedTools++;

        // 动态命名（identifier / 模板串）的工具无法静态核实名称、无法参与命名与
        // 预算审查，因此一律按非基线处理：不允许向前缀注入任何文本。
        const nameProp = get("name");
        const staticName =
          nameProp && ts.isStringLiteral(nameProp.initializer)
            ? nameProp.initializer.text
            : undefined;
        const inBaseline = staticName !== undefined && baselineTools.has(staticName);
        if (!inBaseline) {
          const label = staticName ?? "<dynamically named tool>";
          if (get("promptGuidelines")) {
            cacheViolations.push(
              `${relative(root, file)}: non-baseline tool '${label}' defines promptGuidelines; deferred tools must document usage through CapabilityManifest.usageDoc instead of the system prompt prefix.`,
            );
          }
          if (get("promptSnippet")) {
            cacheViolations.push(
              `${relative(root, file)}: non-baseline tool '${label}' defines promptSnippet; deferred tools must document usage through CapabilityManifest.usageDoc instead of the system prompt prefix.`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.ok(
    scannedTools >= 25,
    `expected to scan the full registered tool set, got ${scannedTools}`,
  );
  assert.deepEqual(
    cacheViolations,
    [],
    "Only baseline core tools may contribute to the system prompt prefix (Cache-Safe Guarantee)",
  );
});
