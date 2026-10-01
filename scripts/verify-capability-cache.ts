/** Manual live acceptance probe. Uses the configured provider without changing
 * settings or exposing credentials. Sends only synthetic data, up to four short
 * responses, and reports cache usage plus hashes of the actual request prefix.
 * Run: ./node_modules/.bin/tsx scripts/verify-capability-cache.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime, ModelRegistry,
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { restoreCustomProviders } from "../provider-manager/lib/register.js";
import { capabilityToolRegistry } from "../lib/capability-dispatch.js";
import { BASELINE_CORE_TOOLS, registerCapability } from "../lib/capability-router.js";
import { setupCore } from "../work-mode/core.js";
import { setupPlanFeature } from "../work-mode/plan-feature.js";
import { setupRequirementsFeature } from "../work-mode/requirements-feature.js";
import cmdExtension from "../cmd-tool.js";
import powershellExtension from "../powershell-tool.js";

async function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const temporary = mkdtempSync(join(tmpdir(), "pi-live-cache-"));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(temporary, "auth.json"), refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  restoreCustomProviders({ registerProvider: (name: string, config: any) => registry.registerProvider(name, config) } as any);
  const model = registry.find(settings.defaultProvider, settings.defaultModel);
  if (!model) throw new Error("Configured model unavailable");

  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const native = new Map<string, any>();
  let active: string[] = [];
  let nativeWrites = 0;
  const ctx: any = { cwd: temporary, sessionManager: { getEntries: () => [] }, ui: { setStatus: () => {}, notify: () => {} } };
  const pi: any = {
    on: (name: string, fn: any) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    registerTool: (definition: any) => native.set(definition.name, definition), registerCommand: (name: string, definition: any) => commands.set(name, definition), appendEntry: () => {},
    setActiveTools: (names: string[]) => { active = [...names]; nativeWrites++; }, getActiveTools: () => active,
  };
  for (const definition of [createReadToolDefinition(temporary), createEditToolDefinition(temporary), createWriteToolDefinition(temporary), createBashToolDefinition(temporary)]) native.set(definition.name, definition);
  const state: any = { phase: "work", isSubAgent: false, planSteps: [], planFullText: "", pathAllowlist: new Set(), cmdAllowlist: new Set(), actionAllowlist: new Set() };
  setupPlanFeature(pi, state);
  setupRequirementsFeature(pi, state, { acceptContract: () => {}, pauseForRevision: () => {} });
  cmdExtension(pi); powershellExtension(pi);
  registerCapability({ id: "cache_acceptance_probe", name: "Cache acceptance probe", summary: "Synthetic cache test", keywords: [], phases: ["work", "plan"], tools: ["cache_probe_echo"], usageDoc: "Return synthetic probe text through call_capability." });
  capabilityToolRegistry(pi).registerTool({ name: "cache_probe_echo", label: "Echo", description: "Echo synthetic text", parameters: Type.Object({ message: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "OK" }], details: {} }) });
  setupCore(pi, state, { resetForNewTurn: () => {} });
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "switch" }, ctx);
  assert.deepEqual(active, BASELINE_CORE_TOOLS);

  const requests: any[] = [];
  const rawUsage: Array<Promise<any[]>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
    if (body) { try { const parsed = JSON.parse(body); if (parsed.model && (parsed.messages || parsed.input)) requests.push(parsed); } catch {} }
    const response = await realFetch(input, init);
    if (body && response.ok) {
      rawUsage.push(response.clone().text().then((text) => {
        const usages: any[] = [];
        for (const line of text.split("\n")) {
          try {
            const value = JSON.parse(line.startsWith("data: ") ? line.slice(6) : line);
            const usage = value.usage ?? value.response?.usage;
            if (usage) usages.push(usage);
          } catch {}
        }
        // Usage objects contain counters; print no response text or headers.
        const numeric = (value: any): any => typeof value === "number" ? value :
          value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
            .filter(([, child]) => typeof child === "number" || (child !== null && typeof child === "object"))
            .map(([key, child]) => [key, numeric(child)])) : undefined;
        return usages.map(numeric);
      }));
    }
    return response;
  };
  const tools = () => active.map((name) => { const { description, parameters } = native.get(name); return { name, description, parameters }; });
  // A substantial fixed synthetic prefix exceeds common cache minimums.
  const systemPrompt = "This is a synthetic cache acceptance test. Reply OK without calling tools.\n" +
    Array.from({ length: 180 }, (_, i) => `Reference ${i}: preserve stable tool definitions and the existing message prefix; capability guides appear only at the end.`).join("\n");
  const initial: any[] = [{ role: "user", content: "Reply OK. Do not use tools.", timestamp: 0 }];
  const samples: any[] = [];
  async function request(label: string, messages: any[]) {
    const before = requests.length;
    const response = await registry.streamSimple(model!, { systemPrompt, tools: tools(), messages }, {
      sessionId: "pi-fixed-capability-cache-acceptance", cacheRetention: "long", maxTokens: 256,
      reasoning: "low", timeoutMs: 45_000, maxRetries: 0,
    }).result();
    if (response.stopReason === "error" || !response.usage) throw new Error("Provider request failed or omitted usage");
    assert.equal(requests.length, before + 1, "probe expects one HTTP model request per sample");
    const payload = requests.at(-1);
    const messagesField = payload.messages ?? payload.input;
    const prefix = { tools: payload.tools, instructions: payload.instructions, messages: messagesField.slice(0, (requests[0].messages ?? requests[0].input).length) };
    const hash = createHash("sha256").update(JSON.stringify(prefix)).digest("hex");
    const sample = { label, input: response.usage.input, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, output: response.usage.output, prefixSha256: hash, rawUsage: await rawUsage.at(-1) };
    samples.push(sample);
    console.log(JSON.stringify(sample));
    return response;
  }
  try {
    const first = await request("initial", initial);
    await request("warm", initial);
    const loaded = await native.get("load_capability").execute("probe-load", { capability: "cache_acceptance_probe" }, undefined, undefined, ctx);
    assert.equal(loaded.details.success, true);
    const call: any = { ...first, content: [{ type: "toolCall", id: "probe-load", name: "load_capability", arguments: { capability: "cache_acceptance_probe" } }], stopReason: "toolUse" };
    const expanded: any[] = [...initial, call, { role: "toolResult", toolCallId: "probe-load", toolName: "load_capability", content: loaded.content, isError: false, timestamp: 1 }, { role: "user", content: "Reply OK without tools.", timestamp: 2 }];
    const third = await request("after_load", expanded);
    const repeated = await native.get("load_capability").execute("probe-repeat", { capability: "cache_acceptance_probe" }, undefined, undefined, ctx);
    await commands.get("plan").handler("", ctx);
    let finalMessages = [...expanded, third, { role: "user", content: repeated.content[0].text + "\nReply OK without tools.", timestamp: 3 }];
    for (const handler of handlers.get("context") ?? []) {
      const transformed = await handler({ messages: finalMessages }, ctx);
      if (transformed?.messages) finalMessages = transformed.messages;
    }
    await request("repeat_load_and_plan", finalMessages);
    assert.equal(nativeWrites, 1);
    assert.equal(new Set(samples.map((s) => s.prefixSha256)).size, 1, "actual HTTP request prefix changed");
    const initialInput = samples[0].input + samples[0].cacheRead + samples[0].cacheWrite;
    assert.ok(initialInput > 1024, "probe prefix is too short to test cache reuse");
    for (const sample of samples.slice(1)) assert.ok(sample.cacheRead >= initialInput * 0.8, `${sample.label}: provider did not report reuse of the substantial original prefix`);
    console.log(JSON.stringify({ status: "verified", provider: model.provider, model: model.id, nativeTools: active, samples }));
  } finally { globalThis.fetch = realFetch; }
}
main().catch((error) => {
  // Do not print provider error bodies, URLs, headers or credentials.
  console.log(JSON.stringify({ status: "unverified", failure: error instanceof assert.AssertionError ? error.message : "Live provider request or local setup failed; no cache success claimed" }));
  process.exitCode = 1;
});
