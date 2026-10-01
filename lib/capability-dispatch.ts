/** Session-local implementations behind the fixed call_capability transport. */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { BASELINE_CORE_TOOLS, findCapabilityByTool, getCapability, getDefaultActivationState } from "./capability-router.js";
import { getExecutionContext, withSessionScope } from "./execution-context.js";
import { getSessionRuntime } from "./session-runtime.js";

type Operation = { definition: ToolDefinition<any, any, any>; capability?: string };
type ResolvedCall = Operation & { input: Record<string, unknown>; operation: string; raw: string };
// Pi loads each extension with jiti moduleCache=false. Share only the registry
// container across module instances; every implementation remains session-keyed.
type DispatchRegistry = {
  sessions: WeakMap<object, Map<string, Operation>>;
  registries: WeakMap<ExtensionAPI, Pick<ExtensionAPI, "registerTool">>;
  approvals: WeakMap<object, Map<string, ResolvedCall>>;
};
const globals = globalThis as Record<string, unknown>;
const key = "__pi_capability_dispatch_registry";
const shared = (globals[key] ??= {
  sessions: new WeakMap(), registries: new WeakMap(), approvals: new WeakMap(),
}) as DispatchRegistry;
const { sessions, registries, approvals } = shared;

export function getSessionCapabilityOperations(manager: object): ReadonlyMap<string, Operation> {
  return sessions.get(manager) ?? new Map();
}

/** Retain implementations per extension instance and bind them at session_start.
 * Never use another session's closure, including dynamically registered MCP tools.
 */
export function capabilityToolRegistry(pi: ExtensionAPI, capability?: string): Pick<ExtensionAPI, "registerTool"> {
  const existing = registries.get(pi);
  if (existing) return existing;
  const definitions = new Map<string, Operation>();
  let manager: object | undefined;
  pi.on("session_start", (_event, ctx) => {
    manager = ctx.sessionManager;
    const operations = sessions.get(manager) ?? new Map<string, Operation>();
    for (const [name, operation] of definitions) operations.set(name, operation);
    sessions.set(manager, operations);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(ctx.sessionManager);
    approvals.delete(ctx.sessionManager);
    manager = undefined;
  });
  const registry: Pick<ExtensionAPI, "registerTool"> = {
    registerTool(definition) {
      // SDK refreshTools auto-enables newly registered native tools. Hidden
      // operations must never enter that registry, even during MCP discovery.
      if (!capability && BASELINE_CORE_TOOLS.includes(definition.name)) pi.registerTool(definition);
      const operation = { definition, capability };
      definitions.set(definition.name, operation);
      if (manager) sessions.get(manager)?.set(definition.name, operation);
    },
  };
  registries.set(pi, registry);
  return registry;
}

function admittedOperation(name: string, ctx: ExtensionContext): Operation {
  const runtime = getSessionRuntime(ctx.sessionManager);
  if (!runtime) throw new Error("Capability call requires an initialized session.");
  if (BASELINE_CORE_TOOLS.includes(name)) throw new Error("Use the native baseline tool directly.");
  const operation = sessions.get(ctx.sessionManager)?.get(name);
  if (!operation) throw new Error(`Unknown capability operation: ${name}`);
  const manifest = operation.capability ? getCapability(operation.capability) : findCapabilityByTool(name);
  if (!manifest) throw new Error(`Operation has no capability manifest: ${name}`);
  if (!getDefaultActivationState(ctx.sessionManager).activated.has(manifest.id)) {
    throw new Error(`Load capability '${manifest.id}' before calling '${name}'.`);
  }
  const phase = getExecutionContext(ctx.sessionManager).phase;
  if (phase === "chat" || !(manifest.phases ?? ["work"]).includes(phase)) {
    throw new Error(`Operation '${name}' is unavailable in ${phase}.`);
  }
  if (runtime.allowedTools && !runtime.allowedTools.has(name)) {
    throw new Error(`Operation '${name}' exceeds the child tool ceiling.`);
  }
  return operation;
}

export function resolveCapabilityCall(raw: unknown, ctx: ExtensionContext): ResolvedCall {
  const args = raw as { capability?: unknown; operation?: unknown; arguments?: unknown } | undefined;
  if (!args || typeof args.capability !== "string" || typeof args.operation !== "string") {
    throw new Error("call_capability requires capability and operation names.");
  }
  const operation = admittedOperation(args.operation, ctx);
  const manifest = operation.capability ? getCapability(operation.capability) : findCapabilityByTool(args.operation);
  if (manifest?.id !== args.capability) throw new Error("Capability does not own this operation.");
  const supplied = args.arguments ?? {};
  const prepared = operation.definition.prepareArguments?.(supplied) ?? supplied;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new Error(`Arguments do not match the schema for '${args.operation}'.`);
  }
  let input: Record<string, unknown>;
  try {
    // Preserve native validation, including optional-null normalization and
    // schema coercion. The permission guard reviews these exact final values.
    input = validateToolArguments(operation.definition, { type: "toolCall", id: "capability-validation", name: args.operation, arguments: prepared as JsonObject });
  } catch {
    throw new Error(`Arguments do not match the schema for '${args.operation}'.`);
  }
  return { ...operation, input, operation: args.operation, raw: JSON.stringify(raw) };
}

/** Permission guard records the exact reviewed call. Execute cannot bypass it. */
export function approveCapabilityCall(ctx: ExtensionContext, id: string, call: ResolvedCall): void {
  const pending = approvals.get(ctx.sessionManager) ?? new Map<string, ResolvedCall>();
  pending.set(id, call);
  approvals.set(ctx.sessionManager, pending);
}

export function discardCapabilityApproval(ctx: ExtensionContext, id: string): void {
  approvals.get(ctx.sessionManager)?.delete(id);
}

export async function executeCapabilityCall(
  id: string, raw: unknown, signal: AbortSignal | undefined,
  onUpdate: Parameters<ToolDefinition["execute"]>[3], ctx: ExtensionContext,
) {
  const pending = approvals.get(ctx.sessionManager);
  const approved = pending?.get(id);
  pending?.delete(id);
  if (signal?.aborted) throw new Error("Capability call aborted.");
  if (!approved || approved.raw !== JSON.stringify(raw)) throw new Error("Capability call has not passed the permission guard.");
  const current = admittedOperation(approved.operation, ctx);
  if (current.definition !== approved.definition) throw new Error("Operation changed after review; call it again.");
  return withSessionScope(ctx.sessionManager, () => approved.definition.execute(id, approved.input, signal, onUpdate, ctx));
}

export function describeCapabilityOperations(capability: string, ctx: ExtensionContext): string {
  const runtime = getSessionRuntime(ctx.sessionManager);
  const lines = [`Call these operations through call_capability({ capability: '${capability}', operation: '<name>', arguments: {...} }).`,
    "Operation names in the guide refer to this fixed entry point, not additional native tools."];
  for (const [name, op] of sessions.get(ctx.sessionManager) ?? []) {
    if ((op.capability ?? findCapabilityByTool(name)?.id) !== capability) continue;
    if (runtime?.allowedTools && !runtime.allowedTools.has(name)) continue;
    lines.push(`${name}: ${op.definition.description}\nArguments JSON Schema: ${JSON.stringify(op.definition.parameters)}`);
  }
  return lines.join("\n\n");
}
