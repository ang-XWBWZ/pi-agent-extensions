import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAITolerantStream } from "../lib/tolerant-stream.js";
import { createAnthropicStream } from "../lib/anthropic-stream.js";
import { createOpenAITolerantStream as createDistOpenAITolerantStream } from "../../../github特供版/github-dist/provider-manager/lib/tolerant-stream.js";
import { createAnthropicStream as createDistAnthropicStream } from "../../../github特供版/github-dist/provider-manager/lib/anthropic-stream.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitWithAbort } from "../lib/abortable-request.ts";

const testRoot = dirname(fileURLToPath(import.meta.url));

const encoder = new TextEncoder();

const context = {
  systemPrompt: "",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 0,
  }],
  tools: [],
} as any;

function model(api: string) {
  return {
    id: "test-model",
    name: "test-model",
    api,
    provider: "test-provider",
    baseUrl: "https://provider.invalid",
    reasoning: false,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as any;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settlesWithin<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} did not settle in time`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function collectEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withFetchStub<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyAbortSettles(
  streamFactory: () => any,
  api: string,
): Promise<void> {
  const readStarted = deferred();
  const controller = new AbortController();
  const reader = {
    read: () => {
      readStarted.resolve();
      return new Promise<never>(() => undefined);
    },
    cancel: async () => undefined,
  };
  const response = { ok: true, status: 200, body: { getReader: () => reader } } as any;

  await withFetchStub((async () => response) as typeof fetch, async () => {
    const stream = streamFactory()(model(api), context, {
      apiKey: "test-key",
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    const eventsPromise = collectEvents(stream);
    await settlesWithin(readStarted.promise, "reader start");
    controller.abort();

    const events = await settlesWithin(eventsPromise, "aborted stream");
    const error = events.find((event) => event.type === "error");
    assert.equal(error?.reason, "aborted");
    assert.equal(error?.error?.stopReason, "aborted");
  });
}

async function verifyTerminalFrameSettles(
  streamFactory: () => any,
  api: string,
  payload: string,
): Promise<void> {
  let reads = 0;
  let cancelled = false;
  const reader = {
    read: () => {
      if (reads++ === 0) {
        return Promise.resolve({ done: false, value: encoder.encode(payload) });
      }
      return new Promise<never>(() => undefined);
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const response = { ok: true, status: 200, body: { getReader: () => reader } } as any;

  await withFetchStub((async () => response) as typeof fetch, async () => {
    const stream = streamFactory()(model(api), context, {
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const events = await settlesWithin(collectEvents(stream), "terminal stream");
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.reason, "stop");
    assert.equal(cancelled, true);
  });
}

test("custom provider streams always settle after cancellation or terminal frames", async (t) => {
  await t.test("OpenAI-compatible reader abort settles even when read never resolves", async () => {
    await verifyAbortSettles(createOpenAITolerantStream, "openai-completions");
  });

  await t.test("Anthropic-compatible reader abort settles even when read never resolves", async () => {
    await verifyAbortSettles(createAnthropicStream, "anthropic-messages");
  });

  await t.test("OpenAI-compatible finish_reason does not wait for socket EOF", async () => {
    const payload = `data: ${JSON.stringify({
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\n`;
    await verifyTerminalFrameSettles(createOpenAITolerantStream, "openai-completions", payload);
  });

  await t.test("Anthropic-compatible message_stop does not wait for socket EOF", async () => {
    const payload = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    await verifyTerminalFrameSettles(createAnthropicStream, "anthropic-messages", payload);
  });

  await t.test("GitHub distribution mirrors cancellation and terminal settlement", async () => {
    await verifyAbortSettles(createDistOpenAITolerantStream, "openai-completions");
    await verifyAbortSettles(createDistAnthropicStream, "anthropic-messages");

    const openPayload = `data: ${JSON.stringify({
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\n`;
    await verifyTerminalFrameSettles(createDistOpenAITolerantStream, "openai-completions", openPayload);

    const anthropicPayload = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    await verifyTerminalFrameSettles(createDistAnthropicStream, "anthropic-messages", anthropicPayload);
  });
});

test("abort guard settles a hanging operation immediately", async () => {
  const controller = new AbortController();
  const hanging = awaitWithAbort(() => new Promise<never>(() => undefined), controller.signal);
  controller.abort();
  await assert.rejects(hanging, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("custom provider sources retain the stream settlement contract", () => {
  const tolerant = readFileSync(join(testRoot, "..", "lib", "tolerant-stream.ts"), "utf8");
  const anthropic = readFileSync(join(testRoot, "..", "lib", "anthropic-stream.ts"), "utf8");

  assert.match(tolerant, /awaitWithAbort\(\s*\(\) => reader!\.read\(\),\s*controller\.signal/);
  assert.match(tolerant, /sawDoneMarker \|\| hasFinishReason/);
  assert.match(tolerant, /if \(processedSseFrame\) \{\s*refreshIdleTimer\(\)/);

  assert.match(anthropic, /awaitWithAbort\(\s*\(\) => reader!\.read\(\),\s*controller\.signal/);
  assert.match(anthropic, /eventType === "message_stop"/);
  assert.match(anthropic, /eventType === "ping"\) continue/);
  assert.match(anthropic, /if \(controller\.signal\.aborted\) throw createRequestAbortError\(\)/);
});
