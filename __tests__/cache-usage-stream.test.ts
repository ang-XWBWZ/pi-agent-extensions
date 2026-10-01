import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAITolerantStream } from "../stream-compat/lib/tolerant-stream.js";

const model: any = { id: "cache-probe", provider: "probe", api: "probe-tolerant", baseUrl: "https://example.invalid/v1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context: any = { messages: [{ role: "system", content: "Synthetic cache probe" }, { role: "user", content: "OK" }] };
const finish = `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5564, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 5376 } } })}\n\n`;

function response(chunks: string[], holdOpen = false, onCancel = () => {}) {
  let index = 0;
  let cancelled = false;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (!cancelled) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      } else if (!holdOpen) controller.close();
      else await new Promise(() => {});
    },
    cancel() { cancelled = true; onCancel(); },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

for (const [label, chunks] of [
  ["same chunk", [finish + usage + "data: [DONE]\n\n"]],
  ["later chunk", [finish, usage, "data: [DONE]\n\n"]],
  ["split usage frame", [finish, usage.slice(0, 27), usage.slice(27), "data: [DONE]\n\n"]],
] as Array<[string, string[]]>) {
  test(`cache usage survives finish_reason followed by ${label}`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => response(chunks);
    try {
      const result = await createOpenAITolerantStream()(model, context, { apiKey: "offline-test", timeoutMs: 3000 }).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(result.usage.cacheRead, 5376);
      assert.equal(result.usage.input, 188);
      assert.equal(result.usage.output, 5);
      assert.equal(result.usage.totalTokens, 5569);
    } finally { globalThis.fetch = original; }
  });
}

test("a relay that omits usage and leaves its socket open still settles and cancels the reader", async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => response([finish], true, () => { cancelled = true; });
  try {
    const result = await Promise.race([
      createOpenAITolerantStream()(model, context, { apiKey: "offline-test", timeoutMs: 3000 }).result(),
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Stream failed to settle within its bounded grace period")), 2000); timer.unref(); }),
    ]);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.usage.cacheRead, 0);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test("user cancellation interrupts the usage grace period", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response([finish], true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    const result = await createOpenAITolerantStream()(model, context, { apiKey: "offline-test", signal: controller.signal, timeoutMs: 3000 }).result();
    assert.equal(result.stopReason, "aborted");
  } finally { clearTimeout(timer); globalThis.fetch = original; }
});
