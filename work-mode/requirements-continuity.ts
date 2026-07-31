/**
 * Durable continuity for requirement-driven coding work.
 *
 * Pi remains the sole owner of compaction timing and of the ordinary LLM
 * summary. This module records a small, structured delivery checkpoint at
 * each successful compaction, then injects it as ephemeral context on later
 * turns. The contract and acceptance criteria therefore survive compaction
 * without replacing Pi's general-purpose summary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactAuditText } from "../lib/audit-sanitize.js";

export const REQUIREMENTS_CONTINUITY_MARKER = "[requirements-continuity]";
export const REQUIREMENTS_CHECKPOINT_ENTRY = "requirements-continuity-checkpoint";

const MAX_FILES = 24;
const MAX_SIGNALS = 8;
const MAX_ANCHOR_CHARS = 9_000;

type UnknownRecord = Record<string, unknown>;

export interface RequirementContractSnapshot {
  status: string;
  objective: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  assumptions: string[];
  acceptance: string[];
  risks: string[];
  workContract: string;
}

export interface PlanStepSnapshot {
  id: number;
  text: string;
  status: string;
  evidence?: string;
}

export interface RequirementsCheckpoint {
  version: 1;
  createdAt: number;
  tokensBefore: number;
  contract?: RequirementContractSnapshot;
  plan: PlanStepSnapshot[];
  readFiles: string[];
  modifiedFiles: string[];
  validation: string[];
  decisions: string[];
  blockers: string[];
}

interface CompactionPreparationLike {
  tokensBefore?: unknown;
  messagesToSummarize?: unknown;
  fileOps?: unknown;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const text = redactAuditText(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function cleanList(value: unknown, maxItems: number, maxItemChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueTail(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.unshift(value);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeContract(value: unknown): RequirementContractSnapshot | undefined {
  const data = asRecord(value);
  if (!data) return undefined;

  const contract: RequirementContractSnapshot = {
    status: cleanText(data.status, 32) || "unknown",
    objective: cleanText(data.objective, 600),
    scope: cleanList(data.scope, 8, 260),
    outOfScope: cleanList(data.outOfScope, 6, 220),
    constraints: cleanList(data.constraints, 8, 260),
    assumptions: cleanList(data.assumptions, 6, 220),
    acceptance: cleanList(data.acceptance, 8, 260),
    risks: cleanList(data.risks, 6, 220),
    workContract: cleanText(data.workContract, 1_000),
  };

  return contract.objective || contract.scope.length > 0 || contract.acceptance.length > 0
    ? contract
    : undefined;
}

function normalizePlan(value: unknown): PlanStepSnapshot[] {
  const data = asRecord(value);
  const steps = data?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => !!item)
    .map((item, index) => ({
      id: typeof item.id === "number" && Number.isFinite(item.id) ? item.id : index + 1,
      text: cleanText(item.text, 360),
      status: cleanText(item.status, 24) || "pending",
      evidence: cleanText(item.evidence, 420) || undefined,
    }))
    .filter((step) => step.text)
    .slice(0, 10);
}

function customData(entry: unknown, customType: string): unknown | undefined {
  const record = asRecord(entry);
  return record?.type === "custom" && record.customType === customType ? record.data : undefined;
}

function latestCustomData(entries: readonly unknown[], customType: string): unknown | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const data = customData(entries[index], customType);
    if (data !== undefined) return data;
  }
  return undefined;
}

function normalizeCheckpoint(value: unknown): RequirementsCheckpoint | undefined {
  const data = asRecord(value);
  if (!data || data.version !== 1) return undefined;

  const contract = normalizeContract(data.contract);
  const plan = normalizePlan({ steps: data.plan });
  const checkpoint: RequirementsCheckpoint = {
    version: 1,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
    tokensBefore: typeof data.tokensBefore === "number" ? data.tokensBefore : 0,
    contract,
    plan,
    readFiles: cleanList(data.readFiles, MAX_FILES, 360),
    modifiedFiles: cleanList(data.modifiedFiles, MAX_FILES, 360),
    validation: cleanList(data.validation, MAX_SIGNALS, 520),
    decisions: cleanList(data.decisions, MAX_SIGNALS, 520),
    blockers: cleanList(data.blockers, MAX_SIGNALS, 520),
  };

  return isRelevant(checkpoint) ? checkpoint : undefined;
}

function isRelevant(checkpoint: Pick<RequirementsCheckpoint, "contract" | "plan">): boolean {
  return !!checkpoint.contract || checkpoint.plan.length > 0;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return cleanText(content, 1_600);
  if (!Array.isArray(content)) return "";
  return cleanText(
    content
      .map((item) => {
        const block = asRecord(item);
        if (!block) return "";
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n"),
    1_600,
  );
}

function touch(set: Set<string>, value: unknown): void {
  const path = cleanText(value, 500);
  if (!path) return;
  set.delete(path);
  set.add(path);
}

function addIterableToSet(set: Set<string>, value: unknown): void {
  if (!value || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") return;
  for (const item of value as Iterable<unknown>) touch(set, item);
}

function collectFiles(entries: readonly unknown[], preparation: CompactionPreparationLike): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const read = new Set<string>();
  const modified = new Set<string>();
  const fileOps = asRecord(preparation.fileOps);
  addIterableToSet(read, fileOps?.read);
  addIterableToSet(modified, fileOps?.written);
  addIterableToSet(modified, fileOps?.edited);

  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const message = asRecord(entryRecord?.message);
    if (entryRecord?.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const item of message.content) {
      const block = asRecord(item);
      if (block?.type !== "toolCall") continue;
      const args = asRecord(block.arguments);
      const path = args?.path;
      if (block.name === "read") touch(read, path);
      if (block.name === "write" || block.name === "edit" || block.name === "apply_patch") {
        touch(modified, path);
      }
    }
  }

  const modifiedFiles = [...modified].slice(-MAX_FILES);
  const modifiedSet = new Set(modifiedFiles);
  return {
    readFiles: [...read].filter((path) => !modifiedSet.has(path)).slice(-MAX_FILES),
    modifiedFiles,
  };
}

function auditSignals(entries: readonly unknown[]): { validation: string[]; blockers: string[] } {
  const validation: string[] = [];
  const blockers: string[] = [];

  for (const entry of entries) {
    const data = customData(entry, "work-audit");
    const audit = asRecord(data);
    if (!audit) continue;

    const kind = cleanText(audit.kind, 40);
    const tool = cleanText(audit.toolName, 80) || "tool";
    const target = cleanText(audit.target, 260);
    const result = cleanText(audit.result ?? audit.reason, 440);
    const description = [tool, target && `(${target})`, result && `— ${result}`]
      .filter(Boolean)
      .join(" ");

    if (kind === "tool_failed" || kind === "tool_blocked") {
      blockers.push(`失败/阻塞: ${description}`);
    } else if (kind === "tool_finished" && result) {
      validation.push(`验证/执行: ${description}`);
    }
  }

  return {
    validation: uniqueTail(validation, MAX_SIGNALS),
    blockers: uniqueTail(blockers, MAX_SIGNALS),
  };
}

const REQUIREMENT_SIGNAL = /必须|禁止|不要|仅|要求|验收|范围|约束|优先|改成|保留|删除|兼容|性能|安全|should|must|requirement|acceptance|scope|constraint|do not|only/i;

function userDecisionSignals(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const important: string[] = [];
  const recent: string[] = [];

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asRecord(messages[index]);
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content);
    if (!text || text.startsWith(REQUIREMENTS_CONTINUITY_MARKER)) continue;
    const signal = `用户决定: ${cleanText(text, 520)}`;
    if (REQUIREMENT_SIGNAL.test(text)) important.push(signal);
    else recent.push(signal);
  }

  return uniqueTail([...recent.reverse().slice(-3), ...important.reverse()], MAX_SIGNALS);
}

function currentContract(
  entries: readonly unknown[],
  previous?: RequirementsCheckpoint,
): RequirementContractSnapshot | undefined {
  const stored = latestCustomData(entries, "work-contract-state");
  // An explicit empty/rejected state is meaningful: it must not revive an old
  // accepted contract from a checkpoint.
  return stored === undefined ? previous?.contract : normalizeContract(stored);
}

function currentPlan(
  entries: readonly unknown[],
  previous?: RequirementsCheckpoint,
): PlanStepSnapshot[] {
  const stored = latestCustomData(entries, "work-plan-state");
  // plan-feature persists { steps: [] } when the user clears the plan.
  return stored === undefined ? previous?.plan ?? [] : normalizePlan(stored);
}

export function buildRequirementsCheckpoint(
  branchEntries: readonly unknown[],
  preparation: CompactionPreparationLike = {},
): RequirementsCheckpoint | undefined {
  const previous = normalizeCheckpoint(latestCustomData(branchEntries, REQUIREMENTS_CHECKPOINT_ENTRY));
  const contract = currentContract(branchEntries, previous);
  const plan = currentPlan(branchEntries, previous);
  const base: Pick<RequirementsCheckpoint, "contract" | "plan"> = { contract, plan };
  if (!isRelevant(base)) return undefined;

  const files = collectFiles(branchEntries, preparation);
  const audit = auditSignals(branchEntries);
  const planBlockers = plan
    .filter((step) => step.status === "error")
    .map((step) => `计划步骤失败: ${step.text}${step.evidence ? ` — ${step.evidence}` : ""}`);

  return {
    version: 1,
    createdAt: Date.now(),
    tokensBefore: typeof preparation.tokensBefore === "number" ? preparation.tokensBefore : 0,
    contract,
    plan,
    readFiles: uniqueTail([...(previous?.readFiles ?? []), ...files.readFiles], MAX_FILES),
    modifiedFiles: uniqueTail([...(previous?.modifiedFiles ?? []), ...files.modifiedFiles], MAX_FILES),
    validation: uniqueTail([...(previous?.validation ?? []), ...audit.validation], MAX_SIGNALS),
    decisions: uniqueTail(
      [...(previous?.decisions ?? []), ...userDecisionSignals(preparation.messagesToSummarize)],
      MAX_SIGNALS,
    ),
    blockers: uniqueTail([...(previous?.blockers ?? []), ...audit.blockers, ...planBlockers], MAX_SIGNALS),
  };
}

function bullets(title: string, values: string[], maxItems: number, maxChars: number): string[] {
  const items = values.map((value) => cleanText(value, maxChars)).filter(Boolean).slice(0, maxItems);
  return items.length === 0 ? [] : [title, ...items.map((item) => `- ${item}`)];
}

function clipAnchor(text: string): string {
  if (text.length <= MAX_ANCHOR_CHARS) return text;
  const head = Math.floor(MAX_ANCHOR_CHARS * 0.7);
  const tail = Math.floor(MAX_ANCHOR_CHARS * 0.25);
  return `${text.slice(0, head)}\n…[检查点已截断]…\n${text.slice(-tail)}`;
}

export function buildContinuityAnchor(checkpoint: RequirementsCheckpoint): string {
  const contractStatus = checkpoint.contract?.status;
  const supersessionRule = "若最新用户请求明确替代当前目标，以最新用户请求为准，并更新或清理对应的工作状态。";
  const continuationInstruction = contractStatus === "accepted"
    ? `这是跨压缩重建的工作状态，不是新的用户请求。以已接受的需求契约和验收标准为准，继续当前工作，不要无故复述它。${supersessionRule}`
    : contractStatus === "draft" || contractStatus === "proposed"
      ? `这是跨压缩重建的工作状态，不是新的用户请求。需求契约尚未被用户接受；保留分析与问题，但不要把它当作执行授权。${supersessionRule}`
      : contractStatus === "rejected"
        ? `这是跨压缩重建的工作状态，不是新的用户请求。该需求契约已被用户拒绝；不要据此继续执行，等待新的方向。${supersessionRule}`
        : `这是跨压缩重建的工作状态，不是新的用户请求。将它作为当前工作的约束和进度参考，不要无故复述它。${supersessionRule}`;
  const lines = [
    REQUIREMENTS_CONTINUITY_MARKER,
    continuationInstruction,
  ];

  if (checkpoint.contract) {
    const contract = checkpoint.contract;
    lines.push("", `## 需求契约（${contract.status}）`, `目标: ${contract.objective || "未记录"}`);
    lines.push(...bullets("范围:", contract.scope, 6, 220));
    lines.push(...bullets("不包含:", contract.outOfScope, 4, 180));
    lines.push(...bullets("约束:", contract.constraints, 6, 220));
    lines.push(...bullets("验收标准:", contract.acceptance, 6, 220));
    lines.push(...bullets("风险/假设:", [...contract.risks, ...contract.assumptions], 6, 200));
    if (contract.workContract) lines.push(`执行边界: ${cleanText(contract.workContract, 900)}`);
  }

  if (checkpoint.plan.length > 0) {
    lines.push("", "## 执行计划");
    for (const step of checkpoint.plan.slice(0, 10)) {
      const icon = step.status === "done" ? "x" : step.status === "current" ? ">" : step.status === "error" ? "!" : " ";
      lines.push(`- [${icon}] ${step.text}${step.evidence ? ` — ${step.evidence}` : ""}`);
    }
  }

  lines.push(...bullets("\n## 验证证据:", checkpoint.validation, 5, 420));
  lines.push(...bullets("\n## 近期用户决定:", checkpoint.decisions, 5, 420));
  lines.push(...bullets("\n## 未解决信号:", checkpoint.blockers, 5, 420));
  lines.push(...bullets("\n## 已修改文件:", checkpoint.modifiedFiles, 16, 300));
  lines.push(...bullets("\n## 只读参考文件:", checkpoint.readFiles, 12, 300));

  return clipAnchor(lines.join("\n"));
}

function removeExistingAnchor(messages: readonly unknown[]): unknown[] {
  return messages.filter((message) => {
    const record = asRecord(message);
    return !(
      record?.role === "user" &&
      typeof record.content === "string" &&
      record.content.startsWith(REQUIREMENTS_CONTINUITY_MARKER)
    );
  });
}

function currentCheckpoint(entries: readonly unknown[], previous?: RequirementsCheckpoint): RequirementsCheckpoint | undefined {
  const contract = currentContract(entries, previous);
  const plan = currentPlan(entries, previous);
  if (!isRelevant({ contract, plan })) return undefined;
  return {
    version: 1,
    createdAt: previous?.createdAt ?? Date.now(),
    tokensBefore: previous?.tokensBefore ?? 0,
    contract,
    plan,
    readFiles: previous?.readFiles ?? [],
    modifiedFiles: previous?.modifiedFiles ?? [],
    validation: previous?.validation ?? [],
    decisions: previous?.decisions ?? [],
    blockers: previous?.blockers ?? [],
  };
}

/** Install the continuity layer without overriding Pi's compaction decision or summary. */
export function setupRequirementsContinuity(pi: ExtensionAPI): void {
  let latest: RequirementsCheckpoint | undefined;
  let pending: RequirementsCheckpoint | undefined;

  pi.on("session_start", (_event, ctx) => {
    latest = normalizeCheckpoint(latestCustomData(ctx.sessionManager.getBranch(), REQUIREMENTS_CHECKPOINT_ENTRY));
  });

  pi.on("session_before_compact", (event) => {
    pending = buildRequirementsCheckpoint(event.branchEntries, event.preparation);
    // No return: Pi remains the only owner of trigger timing and LLM summary generation.
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!pending) return;
    latest = pending;
    pi.appendEntry(REQUIREMENTS_CHECKPOINT_ENTRY, pending);
    ctx.ui.setStatus("requirements-continuity", "📋");
    pending = undefined;
  });

  pi.on("context", (event, ctx) => {
    const checkpoint = currentCheckpoint(ctx.sessionManager.getBranch(), latest);
    const messages = removeExistingAnchor(event.messages);
    if (!checkpoint) {
      return messages.length === event.messages.length ? undefined : { messages };
    }
    messages.push({
      role: "user",
      content: buildContinuityAnchor(checkpoint),
      timestamp: Date.now(),
    });
    return { messages: messages as typeof event.messages };
  });
}
