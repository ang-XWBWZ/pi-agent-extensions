import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCustomProviderContextUsage,
  CUSTOM_PROVIDER_CONTEXT_RESERVE_TOKENS,
  estimateLocalPayloadTokens,
  parseOpenAIUsage,
} from "../lib/message-utils.js";
import {
  calculateCustomProviderContextUsage as calculateDistCustomProviderContextUsage,
  CUSTOM_PROVIDER_CONTEXT_RESERVE_TOKENS as DIST_CONTEXT_RESERVE_TOKENS,
  estimateLocalPayloadTokens as estimateDistLocalPayloadTokens,
  parseOpenAIUsage as parseDistOpenAIUsage,
} from "../../../github特供版/github-dist/provider-manager/lib/message-utils.js";
import {
  DEFAULT_NORMAL_MAX_TOKENS,
  resolveRequestMaxTokens,
} from "../lib/request-limits.js";

const model = {
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
} as any;

const usageParsers = [parseOpenAIUsage, parseDistOpenAIUsage];
const localContextCalculators = [
  [calculateCustomProviderContextUsage, estimateLocalPayloadTokens],
  [calculateDistCustomProviderContextUsage, estimateDistLocalPayloadTokens],
] as const;

test("local payload estimates use Pi's chars/4 estimator for all text", () => {
  for (const [, estimatePayload] of localContextCalculators) {
    assert.equal(estimatePayload("abcdefgh"), 2);
    assert.equal(estimatePayload("中文"), 1);
    assert.equal(estimatePayload("😀"), 1);
  }
});

test("custom provider context uses Pi's local sent payload plus reply without a custom reserve", () => {
  const sentPayload = {
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  };
  const replyContent = [{ type: "text", text: "abcdefgh" }];

  assert.equal(CUSTOM_PROVIDER_CONTEXT_RESERVE_TOKENS, 0);
  assert.equal(DIST_CONTEXT_RESERVE_TOKENS, 0);

  for (const [calculateContext, estimatePayload] of localContextCalculators) {
    const withReportedReply = calculateContext(sentPayload, replyContent, 7);
    assert.equal(withReportedReply.sentTokens, estimatePayload(sentPayload));
    assert.equal(withReportedReply.replyTokens, 7);
    assert.equal(withReportedReply.reserveTokens, 0);
    assert.equal(withReportedReply.totalTokens, withReportedReply.sentTokens + 7);

    const withLocalReply = calculateContext(sentPayload, replyContent, 0);
    assert.equal(withLocalReply.replyTokens, 2);
    assert.equal(withLocalReply.totalTokens, withLocalReply.sentTokens + 2);
  }
});

test("OpenAI usage preserves the provider-reported context total", () => {
  for (const parseUsage of usageParsers) {
    const usage = parseUsage({
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
    assert.equal(usage.totalTokens, 256_000);
  }
});

test("OpenAI usage leaves total unset when the provider omits it", () => {
  for (const parseUsage of usageParsers) {
    const usage = parseUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: {
        cached_tokens: 40,
      },
    }, model);

    assert.equal(usage.input, 60);
    assert.equal(usage.cacheRead, 40);
    assert.equal(usage.output, 20);
    assert.equal(usage.totalTokens, 0);
  }
});

test("normal output uses one fixed 32K cap, bounded by the model and explicit request", () => {
  assert.equal(DEFAULT_NORMAL_MAX_TOKENS, 32_768);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }), 32_768);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 24_000 }), 24_000);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }, 12_000), 12_000);
  assert.equal(resolveRequestMaxTokens({ maxTokens: 68_000 }, 96_000), 68_000);
});
