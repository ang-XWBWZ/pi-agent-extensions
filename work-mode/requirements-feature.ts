import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type QuestionStatus = "open" | "resolved";

interface RequirementQuestion {
  id: number;
  text: string;
  status: QuestionStatus;
  answer?: string;
}

interface RequirementsState {
  objective: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  questions: RequirementQuestion[];
  assumptions: string[];
  acceptance: string[];
  risks: string[];
  workContract: string;
  ready: boolean;
}

const initialState = (): RequirementsState => ({
  objective: "",
  scope: [],
  outOfScope: [],
  constraints: [],
  questions: [],
  assumptions: [],
  acceptance: [],
  risks: [],
  workContract: "",
  ready: false,
});

let nextQuestionId = 1;

function appendUnique(list: string[], value: string | undefined): void {
  const text = value?.trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function replaceList(current: string[], next: unknown): string[] {
  if (!Array.isArray(next)) return current;
  return next.map(String).map((s) => s.trim()).filter(Boolean);
}

function formatList(title: string, items: string[]): string[] {
  if (items.length === 0) return [`${title}: (none)`];
  return [title + ":", ...items.map((item) => `- ${item}`)];
}

function formatRequirements(s: RequirementsState): string {
  const questions = s.questions.length === 0
    ? ["Questions: (none)"]
    : [
        "Questions:",
        ...s.questions.map((q) => {
          const suffix = q.answer ? ` -> ${q.answer}` : "";
          return `- [${q.id}] ${q.status}: ${q.text}${suffix}`;
        }),
      ];

  return [
    `Objective: ${s.objective || "(unset)"}`,
    ...formatList("Scope", s.scope),
    ...formatList("Out of scope", s.outOfScope),
    ...formatList("Constraints", s.constraints),
    ...questions,
    ...formatList("Assumptions", s.assumptions),
    ...formatList("Acceptance", s.acceptance),
    ...formatList("Risks", s.risks),
    `Ready for work: ${s.ready ? "yes" : "no"}`,
    `Work contract: ${s.workContract || "(unset)"}`,
  ].join("\n");
}

export function setupRequirementsFeature(pi: ExtensionAPI): void {
  const state = initialState();

  pi.registerTool({
    name: "manage_requirements",
    label: "Manage Requirements",
    description:
      "Maintain a Plan-stage requirement confirmation card: objective, scope, questions, assumptions, constraints, acceptance criteria, risks, and the final Work Contract.",
    promptSnippet: "Confirm requirements before Work (frame, questions, assumptions, acceptance, ready)",
    promptGuidelines: [
      "Use when: the user's request is ambiguous, multi-step, cross-module, risky, or could be implemented in incompatible ways.",
      "Do not use when: the task is a direct answer, a trivial one-file edit, or the user explicitly wants immediate execution.",
      "Phase policy: Chat may use status only; Plan should use this tool to record open questions and assumptions; Work should only read status or clear after completion.",
      "Workflow: set_frame -> add_question/add_assumption/add_constraint -> resolve_question -> set_acceptance -> mark_ready with a concise Work Contract.",
      "Question rule: ask only questions that can change implementation, safety, scope, or acceptance. Prefer assumptions for low-risk gaps.",
      "Conflict policy: use manage_requirements for demand confirmation; use manage_plan only for execution progress after Work starts.",
      "Failure / fallback: if key information remains unknown, keep ready=false and ask the user the smallest blocking question.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "set_frame | add_question | resolve_question | add_assumption | add_constraint | set_acceptance | add_risk | mark_ready | status | clear",
      }),
      objective: Type.Optional(Type.String({ description: "User goal or desired outcome" })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "In-scope areas or deliverables" })),
      outOfScope: Type.Optional(Type.Array(Type.String(), { description: "Explicitly excluded areas" })),
      question: Type.Optional(Type.String({ description: "Question to ask or track" })),
      questionId: Type.Optional(Type.Number({ description: "Question id for resolve_question" })),
      answer: Type.Optional(Type.String({ description: "Answer for resolve_question" })),
      assumption: Type.Optional(Type.String({ description: "Assumption adopted by the agent" })),
      constraint: Type.Optional(Type.String({ description: "Hard or soft constraint" })),
      acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria" })),
      risk: Type.Optional(Type.String({ description: "Risk or failure mode to track" })),
      workContract: Type.Optional(Type.String({ description: "Final concise contract for Work mode" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      switch (params.action) {
        case "set_frame": {
          if (typeof params.objective === "string") state.objective = params.objective.trim();
          state.scope = replaceList(state.scope, params.scope);
          state.outOfScope = replaceList(state.outOfScope, params.outOfScope);
          state.ready = false;
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };
        }

        case "add_question": {
          const text = params.question?.trim();
          if (!text) return { content: [{ type: "text", text: "question is required" }], details: { error: "missing_question" } };
          const question: RequirementQuestion = { id: nextQuestionId++, text, status: "open" };
          state.questions.push(question);
          state.ready = false;
          return { content: [{ type: "text", text: `Added question [${question.id}]: ${question.text}` }], details: question };
        }

        case "resolve_question": {
          if (params.questionId == null) {
            return { content: [{ type: "text", text: "questionId is required" }], details: { error: "missing_questionId" } };
          }
          const target = state.questions.find((q) => q.id === params.questionId);
          if (!target) return { content: [{ type: "text", text: `question not found: ${params.questionId}` }], details: { error: "not_found" } };
          target.status = "resolved";
          target.answer = params.answer?.trim() || "(resolved)";
          return { content: [{ type: "text", text: `Resolved question [${target.id}]: ${target.answer}` }], details: target };
        }

        case "add_assumption":
          appendUnique(state.assumptions, params.assumption);
          state.ready = false;
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };

        case "add_constraint":
          appendUnique(state.constraints, params.constraint);
          state.ready = false;
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };

        case "set_acceptance":
          state.acceptance = replaceList(state.acceptance, params.acceptance);
          state.ready = false;
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };

        case "add_risk":
          appendUnique(state.risks, params.risk);
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };

        case "mark_ready": {
          const openQuestions = state.questions.filter((q) => q.status === "open");
          if (openQuestions.length > 0) {
            state.ready = false;
            return {
              content: [{ type: "text", text: `Cannot mark ready: ${openQuestions.length} open question(s).\n\n${formatRequirements(state)}` }],
              details: { error: "open_questions", openQuestions, state },
            };
          }
          state.workContract = params.workContract?.trim() || state.workContract;
          state.ready = Boolean(state.objective && state.acceptance.length > 0 && state.workContract);
          if (!state.ready) {
            return {
              content: [{ type: "text", text: "Cannot mark ready: objective, acceptance, and workContract are required.\n\n" + formatRequirements(state) }],
              details: { error: "missing_ready_fields", state },
            };
          }
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };
        }

        case "status":
          return { content: [{ type: "text", text: formatRequirements(state) }], details: state };

        case "clear": {
          Object.assign(state, initialState());
          return { content: [{ type: "text", text: "Requirements cleared." }], details: state };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });
}
