/**
 * One-shot Work Contract confirmation.
 *
 * The model submits one complete contract. The user accepts, edits, or rejects
 * it in the UI. Acceptance is the only path that transitions the contract into
 * executable Work.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactAuditText } from "../lib/audit-sanitize.js";
import type { ConversationPhase } from "./types.js";
import {
  isToolResultError,
  renderStructuredToolCall,
  renderToolResult,
} from "../lib/tui-render.js";

export interface WorkContract {
  objective: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  assumptions: string[];
  acceptance: string[];
  risks: string[];
  steps: string[];
  workContract: string;
}

type ContractStatus = "empty" | "draft" | "proposed" | "accepted" | "rejected";

interface RequirementsState extends WorkContract {
  status: ContractStatus;
  revision?: string;
}

interface RequirementsHostState {
  phase: ConversationPhase;
  isSubAgent: boolean;
}

interface RequirementsEntry {
  type: "custom";
  customType: "work-contract-state";
  data: RequirementsState;
}

interface RequirementsCallbacks {
  acceptContract: (contract: WorkContract, ctx: ExtensionContext) => void;
  pauseForRevision: (ctx: ExtensionContext) => void;
}

const emptyState = (): RequirementsState => ({
  objective: "",
  scope: [],
  outOfScope: [],
  constraints: [],
  assumptions: [],
  acceptance: [],
  risks: [],
  steps: [],
  workContract: "",
  status: "empty",
});

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string"
    ? redactAuditText(value.trim()).slice(0, limit)
    : "";
}

function cleanList(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(String(item), 300))
    .filter(Boolean)
    .slice(0, limit);
}

function formatSection(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [title + ":", ...items.map((item) => `- ${item}`)];
}

export function formatWorkContract(contract: WorkContract): string {
  return [
    `目标: ${contract.objective}`,
    ...formatSection("范围", contract.scope),
    ...formatSection("不包含", contract.outOfScope),
    ...formatSection("约束", contract.constraints),
    ...formatSection("假设", contract.assumptions),
    ...formatSection("验收", contract.acceptance),
    ...formatSection("风险", contract.risks),
    ...formatSection(
      "执行步骤",
      contract.steps.map((step, index) => `${index + 1}. ${step}`),
    ),
    `执行契约: ${contract.workContract}`,
  ].join("\n");
}

function stateFromParams(params: Record<string, unknown>): RequirementsState {
  return {
    objective: cleanText(params.objective, 500),
    scope: cleanList(params.scope),
    outOfScope: cleanList(params.outOfScope),
    constraints: cleanList(params.constraints),
    assumptions: cleanList(params.assumptions),
    acceptance: cleanList(params.acceptance),
    risks: cleanList(params.risks),
    steps: cleanList(params.steps, 10),
    workContract: cleanText(params.workContract, 1000),
    status: "draft",
  };
}

function stateFromStored(value: RequirementsState): RequirementsState {
  const normalized = stateFromParams(value as unknown as Record<string, unknown>);
  const status: ContractStatus = [
    "empty",
    "draft",
    "proposed",
    "accepted",
    "rejected",
  ].includes(value.status)
    ? value.status
    : "draft";
  return {
    ...normalized,
    status,
    revision: cleanText(value.revision, 6000) || undefined,
  };
}

function validateContract(state: RequirementsState): string[] {
  const missing: string[] = [];
  if (!state.objective) missing.push("objective");
  if (state.scope.length === 0) missing.push("scope");
  if (state.acceptance.length === 0) missing.push("acceptance");
  if (state.steps.length === 0) missing.push("steps");
  if (!state.workContract) missing.push("workContract");
  return missing;
}

export function setupRequirementsFeature(
  pi: ExtensionAPI,
  host: RequirementsHostState,
  callbacks: RequirementsCallbacks,
): void {
  const state = emptyState();

  function replaceState(next: RequirementsState) {
    Object.assign(state, next);
  }

  function persist() {
    pi.appendEntry("work-contract-state", {
      ...state,
      scope: [...state.scope],
      outOfScope: [...state.outOfScope],
      constraints: [...state.constraints],
      assumptions: [...state.assumptions],
      acceptance: [...state.acceptance],
      risks: [...state.risks],
      steps: [...state.steps],
    });
  }

  pi.on("session_start", (_event, ctx) => {
    let restored: RequirementsState | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        (entry as RequirementsEntry).customType === "work-contract-state"
      ) {
        restored = (entry as RequirementsEntry).data;
      }
    }
    if (restored) replaceState(stateFromStored(restored));
  });

  pi.registerTool({
    name: "manage_requirements",
    label: "Work Contract",
    description:
      "Propose one complete Work Contract for user acceptance, or inspect the current contract. Acceptance is recorded in the session audit.",
    promptSnippet: "Propose or inspect one complete Work Contract",
    promptGuidelines: [
      "Use manage_requirements action=propose only after read-only discovery has resolved non-blocking uncertainty.",
      "Call manage_requirements propose once with the complete objective, scope, acceptance, risks, and top-level steps.",
      "Do not use manage_requirements for routine one-step Work or execution progress.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "propose | status | clear" }),
      objective: Type.Optional(Type.String({ description: "Desired outcome" })),
      scope: Type.Optional(
        Type.Array(Type.String(), { description: "In-scope deliverables" }),
      ),
      outOfScope: Type.Optional(
        Type.Array(Type.String(), { description: "Explicit exclusions" }),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String(), { description: "Hard constraints" }),
      ),
      assumptions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Low-risk assumptions made explicit",
        }),
      ),
      acceptance: Type.Optional(
        Type.Array(Type.String(), {
          description: "Observable acceptance criteria",
        }),
      ),
      risks: Type.Optional(
        Type.Array(Type.String(), {
          description: "Material risks and rollback considerations",
        }),
      ),
      steps: Type.Optional(
        Type.Array(Type.String(), {
          description: "Two to ten top-level execution steps",
        }),
      ),
      workContract: Type.Optional(
        Type.String({
          description: "Concise execution boundary and authorization summary",
        }),
      ),
      openQuestions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Blocking questions; proposal pauses while non-empty",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Required to clear an accepted contract",
        }),
      ),
    }),

    renderCall(args, theme, context) {
      const count = (value: unknown) => Array.isArray(value) ? `${value.length} items` : undefined;
      return renderStructuredToolCall(theme, context, "manage_requirements", [
        { name: "action", value: args.action, tone: "warning" },
        { name: "objective", value: args.objective, tone: "accent", maxLength: 160 },
        { name: "scope", value: count(args.scope), tone: "muted" },
        { name: "outOfScope", value: count(args.outOfScope), tone: "muted" },
        { name: "constraints", value: count(args.constraints), tone: "muted" },
        { name: "assumptions", value: count(args.assumptions), tone: "muted" },
        { name: "acceptance", value: count(args.acceptance), tone: "muted" },
        { name: "risks", value: count(args.risks), tone: "muted" },
        { name: "steps", value: count(args.steps), tone: "muted" },
        { name: "workContract", value: args.workContract, maxLength: 140 },
        { name: "openQuestions", value: count(args.openQuestions), tone: "warning" },
        { name: "force", value: args.force, tone: "warning" },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 8,
        isError: isToolResultError(result, context),
      });
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text:
                state.status === "empty"
                  ? "当前没有 Work Contract"
                  : `Contract status: ${state.status}\n${formatWorkContract(state)}`,
            },
          ],
          details: { ...state },
        };
      }

      if (params.action === "clear") {
        if (state.status === "accepted" && params.force !== true) {
          return {
            content: [
              {
                type: "text",
                text: "已接受的 Work Contract 不能静默清除；用户明确放弃后传 force=true。",
              },
            ],
            details: { error: "accepted_contract", state: { ...state } },
          };
        }
        replaceState(emptyState());
        persist();
        return {
          content: [{ type: "text", text: "Work Contract 已清除" }],
          details: { ...state },
        };
      }

      if (params.action !== "propose") {
        return {
          content: [
            {
              type: "text",
              text: `未知 manage_requirements 操作: ${params.action}`,
            },
          ],
          details: { error: "unknown_action" },
        };
      }

      if (host.isSubAgent) {
        return {
          content: [
            {
              type: "text",
              text: "子 Agent 不能向用户确认 Work Contract；请把分析结果交给主 Agent。",
            },
          ],
          details: { error: "subagent_cannot_confirm" },
        };
      }

      if (host.phase === "chat") {
        return {
          content: [
            {
              type: "text",
              text: "CHAT 阶段不启动工作契约；切换到 PLAN 或 WORK 后再提交。",
            },
          ],
          details: { error: "wrong_phase", phase: host.phase },
        };
      }

      const openQuestions = cleanList(params.openQuestions);
      const proposed = stateFromParams(params as Record<string, unknown>);
      replaceState(proposed);
      if (openQuestions.length > 0) {
        state.status = "draft";
        persist();
        callbacks.pauseForRevision(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Work Contract 尚未就绪，先向用户询问：\n${openQuestions.map((item) => `- ${item}`).join("\n")}`,
            },
          ],
          details: { error: "open_questions", openQuestions, state: { ...state } },
        };
      }

      const missing = validateContract(state);
      if (missing.length > 0) {
        persist();
        callbacks.pauseForRevision(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Work Contract 缺少必要字段: ${missing.join(", ")}`,
            },
          ],
          details: { error: "missing_fields", missing, state: { ...state } },
        };
      }

      state.status = "proposed";
      persist();
      const formatted = formatWorkContract(state);
      const choice = await ctx.ui.select(
        `确认 Work Contract\n\n${formatted}`,
        ["接受并开始执行", "修改契约", "暂不执行"],
      );

      if (choice === "接受并开始执行") {
        state.status = "accepted";
        state.revision = undefined;
        persist();
        callbacks.acceptContract({ ...state }, ctx);
        return {
          content: [
            {
              type: "text",
              text: "用户已接受 Work Contract。继续在当前调用链中执行，无需生成额外用户消息。",
            },
          ],
          details: { accepted: true, contract: { ...state } },
        };
      }

      if (choice === "修改契约") {
        const revision = await ctx.ui.editor("修改 Work Contract", formatted);
        state.status = "draft";
        state.revision = cleanText(revision, 6000);
        persist();
        callbacks.pauseForRevision(ctx);
        return {
          content: [
            {
              type: "text",
              text: state.revision
                ? `用户要求修改契约：\n${state.revision}`
                : "用户选择修改契约，但未提交内容。请询问最小的阻塞问题。",
            },
          ],
          details: { accepted: false, revision: state.revision, state: { ...state } },
        };
      }

      state.status = "rejected";
      persist();
      callbacks.pauseForRevision(ctx);
      return {
        content: [
          {
            type: "text",
            text: "用户暂未接受 Work Contract。停止执行并等待新的方向。",
          },
        ],
        details: { accepted: false, rejected: true, state: { ...state } },
      };
    },
  });
}
