import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAITolerantStream } from "../lib/tolerant-stream.js";
import { createAnthropicStream } from "../lib/anthropic-stream.js";

const encoder = new TextEncoder();

function createStreamResponse(chunks: string[]): Response {
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("createOpenAITolerantStream extracts tools and systemPrompt from TranscriptContext", async () => {
  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"/test\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    return createStreamResponse(sse);
  }) as typeof fetch;

  try {
    const streamFn = createOpenAITolerantStream();
    // Simulate real Pi TranscriptContext: no context.tools, no context.systemPrompt
    const transcriptContext = {
      messages: [
        {
          role: "system",
          content: "You are an intelligent coding agent.",
          toolsAdded: [
            {
              name: "read",
              description: "Read a file from disk",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
            {
              name: "bash",
              description: "Execute a bash command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          ],
        },
        {
          role: "user",
          content: "Check files",
        },
      ],
    };

    const model = {
      id: "gpt-6-luna",
      provider: "gptplus-openai",
      api: "gptplus-openai-openai-tolerant",
      baseUrl: "http://23.95.115.142:8080",
    } as any;

    const stream = streamFn(model, transcriptContext as any, { apiKey: "test-key" });
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // 1. Verify captured request body
    assert.ok(capturedBody, "fetch was called");
    assert.equal(capturedBody.model, "gpt-6-luna");
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[0].content, "You are an intelligent coding agent.");
    assert.equal(capturedBody.messages[1].role, "user");
    assert.equal(capturedBody.messages[1].content, "Check files");

    // Tools must be extracted from transcript system message!
    assert.ok(Array.isArray(capturedBody.tools), "tools must be an array");
    assert.equal(capturedBody.tools.length, 2);
    assert.equal(capturedBody.tools[0].function.name, "read");
    assert.equal(capturedBody.tools[1].function.name, "bash");

    // 2. Verify stream events and tool call result
    const toolCallStart = events.find((e) => e.type === "toolcall_start");
    assert.ok(toolCallStart, "must emit toolcall_start");
    const toolCallEnd = events.find((e) => e.type === "toolcall_end");
    assert.ok(toolCallEnd, "must emit toolcall_end");
    assert.equal(toolCallEnd.toolCall.name, "read");
    assert.deepEqual(toolCallEnd.toolCall.arguments, { path: "/test" });

    const finalResult = await stream.result();
    assert.equal(finalResult.stopReason, "toolUse");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAnthropicStream extracts tools and systemPrompt from TranscriptContext", async () => {
  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/test\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    return createStreamResponse(sse);
  }) as typeof fetch;

  try {
    const streamFn = createAnthropicStream();
    const transcriptContext = {
      messages: [
        {
          role: "system",
          content: "You are Claude.",
          toolsAdded: [
            {
              name: "read",
              description: "Read file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
        {
          role: "user",
          content: "Read /test",
        },
      ],
    };

    const model = {
      id: "claude-3-5-sonnet",
      provider: "anthropic-custom",
      api: "anthropic-custom",
      baseUrl: "https://api.anthropic.com",
    } as any;

    const stream = streamFn(model, transcriptContext as any, { apiKey: "test-key" });
    for await (const _event of stream) {
      // consume
    }

    assert.ok(capturedBody, "fetch was called");
    assert.equal(capturedBody.system, "You are Claude.");
    assert.ok(Array.isArray(capturedBody.tools), "tools must be an array");
    assert.equal(capturedBody.tools.length, 1);
    assert.equal(capturedBody.tools[0].name, "read");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
