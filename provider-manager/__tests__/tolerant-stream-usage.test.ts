import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenAIUsage, applyCustomProviderContextUsage } from "../lib/message-utils.js";
import { detectModelCost } from "../lib/discovery.js";

test("detectModelCost provides standard pricing for DeepSeek models", () => {
  const v3Cost = detectModelCost("deepseek-chat");
  assert.equal(v3Cost.input, 0.14);
  assert.equal(v3Cost.output, 0.28);
  assert.equal(v3Cost.cacheRead, 0.014);

  const flashCost = detectModelCost("deepseek-flash");
  assert.equal(flashCost.input, 0.14);
  assert.equal(flashCost.output, 0.28);

  const r1Cost = detectModelCost("deepseek-reasoner");
  assert.equal(r1Cost.input, 0.55);
  assert.equal(r1Cost.output, 2.19);
});

test("parseOpenAIUsage parses various cache hit fields across OpenAI-compatible providers", () => {
  const model: any = {
    id: "deepseek-flash",
    cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  };

  // Case 1: OpenAI prompt_tokens_details.cached_tokens
  const usage1 = parseOpenAIUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 800 },
  }, model);

  assert.equal(usage1.input, 200); // 1000 - 800
  assert.equal(usage1.cacheRead, 800);
  assert.equal(usage1.output, 200);
  assert.ok(usage1.cost.total > 0);

  // Case 2: DeepSeek prompt_cache_hit_tokens
  const usage2 = parseOpenAIUsage({
    prompt_tokens: 2000,
    completion_tokens: 500,
    total_tokens: 2500,
    prompt_cache_hit_tokens: 1800,
  }, model);

  assert.equal(usage2.input, 200); // 2000 - 1800
  assert.equal(usage2.cacheRead, 1800);
  assert.equal(usage2.output, 500);
  assert.ok(usage2.cost.total > 0);

  // Case 3: Kimi / 代理直挂 cached_tokens
  const usage3 = parseOpenAIUsage({
    prompt_tokens: 500,
    completion_tokens: 100,
    total_tokens: 600,
    cached_tokens: 400,
  }, model);

  assert.equal(usage3.input, 100);
  assert.equal(usage3.cacheRead, 400);
  assert.ok(usage3.cost.total > 0);
});

test("applyCustomProviderContextUsage preserves authoritative server usage input and cost", () => {
  const initialUsage: any = {
    input: 150,
    output: 50,
    cacheRead: 850,
    cacheWrite: 0,
    totalTokens: 1050,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
  };

  const finalUsage = applyCustomProviderContextUsage(
    initialUsage,
    { messages: [] },
    [{ type: "text", text: "hello" }],
  );

  assert.equal(finalUsage.input, 150);
  assert.equal(finalUsage.cacheRead, 850);
  assert.equal(finalUsage.output, 50);
  assert.equal(finalUsage.cost.total, 0.0031);
});
