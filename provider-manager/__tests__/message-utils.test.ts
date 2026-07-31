import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPACTION_SETTINGS,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import {
  createEstimatedUsage,
  parseOpenAIUsage,
} from "../lib/message-utils.js";
import {
  DEFAULT_NORMAL_MAX_TOKENS,
  estimateSerializedTokens,
  resolveRequestMaxTokens,
} from "../lib/token-estimate.js";

const model = {
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
} as any;

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "reply" }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  } as any;
}

test("fallback usage includes the complete outbound request when upstream omits usage", () => {
  const user = {
    role: "user",
    content: [{ type: "text", text: "abcdefgh" }],
    timestamp: 0,
  } as any;
  const completion = assistantMessage({
    content: [{ type: "text", text: "wxyz" }],
  });
  const request = {
    system: "system instructions",
    messages: [user],
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  };

  const usage = createEstimatedUsage(model, request, completion.content);

  assert.equal(usage.input, estimateSerializedTokens(request));
  assert.equal(usage.output, estimateSerializedTokens(completion.content));
  assert.equal(usage.totalTokens, usage.input + usage.output);
  assert.ok(usage.totalTokens > 0);
});

test("fallback usage can trigger Pi's native compaction threshold", () => {
  const contextWindow = 256_000;
  const threshold = contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const request = { messages: [{ role: "user", content: "x".repeat((threshold + 1) * 3) }] };
  const completion = assistantMessage({
    content: [{ type: "text", text: "done" }],
  });

  const usage = createEstimatedUsage(model, request, completion.content);

  assert.equal(
    shouldCompact(
      usage.totalTokens,
      contextWindow,
      DEFAULT_COMPACTION_SETTINGS,
    ),
    true,
  );
});

test("OpenAI usage derives context tokens from components, not reported total", () => {
  const usage = parseOpenAIUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 256_000,
    prompt_tokens_details: {
      cached_tokens: 40,
    },
  }, model);

  assert.equal(usage.input, 60);
  assert.equal(usage.cacheRead, 40);
  assert.equal(usage.output, 20);
  assert.equal(usage.totalTokens, 120);
});

test("normal output uses one fixed 32K cap, bounded by the model and explicit request", () => {
  assert.equal(DEFAULT_NORMAL_MAX_TOKENS, 32_768);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }), 32_768);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 24_000 }), 24_000);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }, 12_000), 12_000);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }, 96_000), 68_000);
});

test("a 32K Pi reserve gives the matching single compaction threshold", () => {
  const contextWindow = 256_000;
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: DEFAULT_NORMAL_MAX_TOKENS };

  assert.equal(shouldCompact(contextWindow - DEFAULT_NORMAL_MAX_TOKENS, contextWindow, settings), false);
  assert.equal(shouldCompact(contextWindow - DEFAULT_NORMAL_MAX_TOKENS + 1, contextWindow, settings), true);
});
