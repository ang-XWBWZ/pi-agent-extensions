/**
 * stream-compat/__tests__/stream-compat.test.ts — 双轨流兼容扩展单元测试
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveStreamStrategy } from "../lib/strategy-resolver.js";
import { createOpenAITolerantStream } from "../lib/tolerant-stream.js";
import { createAnthropicStream } from "../lib/anthropic-stream.js";
import { patchModelFinishReasonCompat } from "../../stream-compat.js";
import { registerCustomProvider, buildModelConfigs } from "../../provider-manager/lib/register.js";

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

test("resolveStreamStrategy correctly identifies preset rules and overrides", () => {
  // 1. 官方 OpenAI 端点
  const openai = resolveStreamStrategy("openai", "https://api.openai.com/v1");
  assert.equal(openai.track, "builtin");
  assert.equal(openai.flags.supportsFinishReason, true);
  assert.equal(openai.kernelCompat.supportsDeveloperRole, true);

  // 2. 第三方 DeepSeek 中转
  const deepseek = resolveStreamStrategy("gptplus-openai", "http://23.95.115.142:8080", "deepseek-flash");
  assert.equal(deepseek.track, "builtin");
  // 关键：针对第三方中转可能不返回终止，supportsFinishReason 自动设为 false，交由内核自适应终结
  assert.equal(deepseek.kernelCompat.supportsFinishReason, false);
  assert.equal(deepseek.kernelCompat.requiresReasoningContentOnAssistantMessages, true);

  // 3. 本地自建推理服务
  const vllm = resolveStreamStrategy("local", "http://127.0.0.1:8000/v1");
  assert.equal(vllm.track, "tolerant");
  assert.equal(vllm.flags.supportsUsageInStreaming, false);

  // 4. 用户显式指定轨道覆盖
  const overridden = resolveStreamStrategy("gptplus-openai", "http://23.95.115.142:8080", "gpt-6-luna", "tolerant");
  assert.equal(overridden.track, "tolerant");
});

test("tolerant-stream gracefully finishes when third-party relay omits finish_reason and [DONE] on tool calls", async () => {
  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;

  // 模拟第三方中转站：虽然发送了完整的 tool_calls，但连接直接 EOF，既没有 finish_reason，也没有 [DONE]！
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_999","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      // 注意：这里故意不发 finish_reason，不发 [DONE]，模拟第三方中转站直接断开连接
    ];
    return createStreamResponse(sse);
  }) as typeof fetch;

  try {
    const streamFn = createOpenAITolerantStream();
    const transcriptContext = {
      messages: [
        {
          role: "system",
          content: "You are an agent",
          toolsAdded: [
            {
              name: "bash",
              description: "run bash",
              parameters: { type: "object", properties: { command: { type: "string" } } },
            },
          ],
        },
        {
          role: "user",
          content: "run ls",
        },
      ],
    };

    const model = {
      id: "gpt-6-luna",
      provider: "relay-provider",
      api: "relay-provider-tolerant",
      baseUrl: "http://relay.invalid",
    } as any;

    const stream = streamFn(model, transcriptContext as any, { apiKey: "key" });
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // 验证请求体提取了 tools 和 systemPrompt
    assert.equal(capturedBody.messages[0].content, "You are an agent");
    assert.equal(capturedBody.tools.length, 1);
    assert.equal(capturedBody.tools[0].function.name, "bash");

    // 验证在没有 finish_reason 的情况下，依然成功自适应推导为 toolUse！
    const finalResult = await stream.result();
    assert.equal(finalResult.stopReason, "toolUse");
    assert.equal(finalResult.content[0].type, "toolCall");
    assert.equal((finalResult.content[0] as any).name, "bash");
    assert.deepEqual((finalResult.content[0] as any).arguments, { command: "ls" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tolerant-stream gracefully finishes when third-party relay omits finish_reason on normal text", async () => {
  const originalFetch = globalThis.fetch;

  // 模拟第三方中转站：正常输出文本，但不发送 finish_reason，直接 EOF
  globalThis.fetch = (async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello world"衰}}]}\n\n'.replace("衰", ""),
      // 没有 finish_reason, 没有 [DONE]
    ];
    return createStreamResponse(sse);
  }) as typeof fetch;

  try {
    const streamFn = createOpenAITolerantStream();
    const transcriptContext = {
      messages: [{ role: "user", content: "hi" }],
    };
    const model = {
      id: "text-model",
      provider: "relay-provider",
      api: "relay-provider-tolerant",
      baseUrl: "http://relay.invalid",
    } as any;

    const stream = streamFn(model, transcriptContext as any, { apiKey: "key" });
    for await (const _e of stream) {}

    const result = await stream.result();
    // 文本已输出，自适应平稳赋 stop
    assert.equal(result.stopReason, "stop");
    assert.equal((result.content[0] as any).text, "Hello world");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("patchModelFinishReasonCompat protects third-party models without touching official or explicit configs", () => {
  // 1. 第三方工具添加的模型（无 compat，非官方 baseUrl）
  const thirdPartyModel = {
    id: "custom-gpt-4o",
    provider: "third-party-relay",
    api: "openai-completions",
    baseUrl: "https://my-relay.com/v1",
  };
  const patched1 = patchModelFinishReasonCompat(thirdPartyModel);
  assert.equal(patched1, true);
  assert.equal((thirdPartyModel as any).compat?.supportsFinishReason, false);

  // 2. 官方 OpenAI 端点：严格保持原样，不注入 false
  const officialModel = {
    id: "gpt-4o",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
  };
  const patched2 = patchModelFinishReasonCompat(officialModel);
  assert.equal(patched2, false);
  assert.equal((officialModel as any).compat, undefined);

  // 3. 用户显式指定 supportsFinishReason: true 的情况：保留用户配置，不覆盖
  const explicitModel = {
    id: "special-model",
    provider: "third-party-relay",
    api: "openai-completions",
    baseUrl: "https://my-relay.com/v1",
    compat: { supportsFinishReason: true },
  };
  const patched3 = patchModelFinishReasonCompat(explicitModel);
  assert.equal(patched3, false);
  assert.equal(explicitModel.compat.supportsFinishReason, true);

  // 4. 非 OpenAI 协议（如 Anthropic）：不注入 OpenAI compat
  const anthropicModel = {
    id: "claude-3-7-sonnet",
    provider: "anthropic-relay",
    api: "anthropic-messages",
    baseUrl: "https://my-relay.com/v1",
  };
  const patched4 = patchModelFinishReasonCompat(anthropicModel);
  assert.equal(patched4, false);
  assert.equal((anthropicModel as any).compat, undefined);
});

test("registerCustomProvider in auto mode automatically protects models with supportsFinishReason: false", () => {
  let registeredProvider: any = null;
  const fakePi = {
    registerProvider(_name: string, config: any) {
      registeredProvider = config;
    },
  } as any;

  const models = [{ id: "relay-chat", name: "relay-chat" }];
  const modelConfigs = buildModelConfigs(models);

  // 外部第三方工具调用 registerCustomProvider 注册模型，且未指定 streamCompatMode（走 auto 默认）
  registerCustomProvider(
    fakePi,
    "relay-provider",
    "https://api.thirdparty-relay.com/v1",
    "sk-test",
    "openai",
    modelConfigs,
    "auto",
  );

  assert.ok(registeredProvider);
  assert.equal(registeredProvider.models.length, 1);
  // 验证：即使外部传入的 modelConfigs 没有设置 compat，也被自动注入了 supportsFinishReason: false
  assert.equal(registeredProvider.models[0].compat.supportsFinishReason, false);
  // 验证：原生 OpenAI 端点走 openai-completions API 模式（内置主轨）
  assert.equal(registeredProvider.api, "openai-completions");
});
