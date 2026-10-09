/** Replay extension context at its original history boundary instead of moving it. */
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STABLE_CONTEXT_ENTRY = "pi-stable-context";

interface ContextRecord {
  version: 1;
  id: string;
  channel: string;
  sourceLength: number;
  prefixHash: string;
  content: string;
}

interface ProjectionState {
  sessionId?: string;
  records: ContextRecord[];
}

// Pi's jiti loader creates separate module copies for different extensions.
const globals = globalThis as Record<string, unknown>;
const states = (globals.__pi_stable_context_states ??= new WeakMap<object, ProjectionState>()) as WeakMap<object, ProjectionState>;

function isRecord(value: unknown): value is ContextRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as ContextRecord;
  return record.version === 1 && typeof record.id === "string" &&
    typeof record.channel === "string" && typeof record.content === "string" &&
    Number.isInteger(record.sourceLength) && record.sourceLength >= 0 &&
    typeof record.prefixHash === "string";
}

export function isStableContextMessage(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === STABLE_CONTEXT_ENTRY;
}

/**
 * A custom journal entry does not enter Pi's ordinary transcript. Reconstruct its
 * user-visible LLM message only when the exact source prefix still exists. This
 * preserves request prefixes across tool loops, reloads and forks, while dropping
 * records from an abandoned branch or a compacted history.
 */
export function projectStableContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: AgentMessage[],
  channel: string,
  content?: string,
  options: { inactiveContent?: string; repeat?: boolean; onAppend?: () => void } = {},
): AgentMessage[] {
  const manager = ctx?.sessionManager;
  const owner = manager ?? pi;
  const sessionId = manager?.getSessionId?.();
  let state = states.get(owner);
  if (!state || state.sessionId !== sessionId) {
    state = { sessionId, records: [] };
    states.set(owner, state);
  }

  // The real SDK exposes both methods. Reading the current branch is essential:
  // a record written after a fork point must not leak into the other branch.
  if (typeof manager?.getBranch === "function" && typeof manager.getLeafId === "function") {
    state.records = manager.getBranch().flatMap((entry) =>
      entry.type === "custom" && entry.customType === STABLE_CONTEXT_ENTRY && isRecord(entry.data)
        ? [entry.data] : []);
  }

  const source = messages.filter((message) => !isStableContextMessage(message));
  const digest = createHash("sha256");
  const hashes = [digest.copy().digest("hex")];
  for (const message of source) {
    digest.update(JSON.stringify(message)).update("\n");
    hashes.push(digest.copy().digest("hex"));
  }
  state.records = state.records.filter((record) => hashes[record.sourceLength] === record.prefixHash);

  const previous = [...state.records].reverse().find((record) => record.channel === channel);
  const next = content ?? (previous ? options.inactiveContent : undefined);
  const newBoundary = previous?.sourceLength !== source.length || previous?.prefixHash !== hashes[source.length];
  if (next !== undefined && (previous?.content !== next || (options.repeat && newBoundary))) {
    const record: ContextRecord = {
      version: 1, id: randomUUID(), channel, sourceLength: source.length,
      prefixHash: hashes[source.length], content: next,
    };
    // Persist through the supported extension API, never direct session-file writes.
    pi.appendEntry(STABLE_CONTEXT_ENTRY, record);
    state.records.push(record);
    options.onAppend?.();
  }

  const boundaries = new Map<number, ContextRecord[]>();
  for (const record of state.records) {
    const group = boundaries.get(record.sourceLength) ?? [];
    group.push(record);
    boundaries.set(record.sourceLength, group);
  }
  const projected: AgentMessage[] = [];
  for (let index = 0; index <= source.length; index++) {
    for (const record of boundaries.get(index) ?? []) {
      projected.push({
        role: "custom", customType: STABLE_CONTEXT_ENTRY, display: false,
        content: record.content, details: { id: record.id, channel: record.channel }, timestamp: 0,
      });
    }
    if (index < source.length) projected.push(source[index]);
  }
  return JSON.stringify(projected) === JSON.stringify(messages) ? messages : projected;
}
