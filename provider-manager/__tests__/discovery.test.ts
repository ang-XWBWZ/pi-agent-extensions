import test from "node:test";
import assert from "node:assert/strict";
import { detectContextWindow } from "../lib/discovery.js";
import { estimateSerializedTokens } from "../lib/token-estimate.js";

test("OpenAI GPT-family custom models default to a 256K context window", () => {
  for (const modelId of [
    "gpt-4.1",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "openai/gpt-5.5",
  ]) {
    assert.equal(detectContextWindow(modelId), 256_000, modelId);
  }
});

test("non-GPT model-specific defaults remain intact", () => {
  assert.equal(detectContextWindow("codex-mini-latest"), 200_000);
  assert.equal(detectContextWindow("claude-sonnet-4"), 200_000);
  assert.equal(detectContextWindow("v4-pro"), 1_000_000);
});

test("fallback token estimates account conservatively for CJK text", () => {
  assert.equal(estimateSerializedTokens("abcdef"), 2);
  assert.equal(estimateSerializedTokens("中文"), 3);
  assert.ok(
    estimateSerializedTokens({ messages: [{ role: "user", content: "中文" }] })
      > estimateSerializedTokens("中文"),
  );
});
