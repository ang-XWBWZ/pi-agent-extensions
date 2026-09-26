/**
 * stream-compat/lib/stream-probe.ts — 供应商流式特征主动探测器
 */

import type { StreamTrack } from "../types.js";

export interface ProbeResult {
  ok: boolean;
  statusCode?: number;
  supportsStreamOptions: boolean;
  returnedToolCalls: boolean;
  returnedFinishReason: boolean;
  recommendedTrack: StreamTrack;
  diagnosis: string;
}

export async function probeProviderStream(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ProbeResult> {
  const normBase = baseUrl.replace(/\/+$/, "");
  let url = normBase;
  if (!url.endsWith("/chat/completions")) {
    if (!url.endsWith("/v1")) url += "/v1";
    url += "/chat/completions";
  }

  const payload: any = {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
    tools: [
      {
        type: "function",
        function: {
          name: "probe_tool",
          description: "A test tool",
          parameters: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    ],
  };

  let supportsStreamOptions = true;
  let returnedToolCalls = false;
  let returnedFinishReason = false;

  try {
    let res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 400 || res.status === 422) {
      // 尝试剥离 stream_options
      delete payload.stream_options;
      supportsStreamOptions = false;
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
      });
    }

    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.status,
        supportsStreamOptions,
        returnedToolCalls: false,
        returnedFinishReason: false,
        recommendedTrack: "tolerant",
        diagnosis: `请求失败: HTTP ${res.status}`,
      };
    }

    if (!res.body) {
      return {
        ok: false,
        supportsStreamOptions,
        returnedToolCalls: false,
        returnedFinishReason: false,
        recommendedTrack: "tolerant",
        diagnosis: "上游未返回流式响应体",
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
      if (sseText.length > 4096) {
        await reader.cancel();
        break;
      }
    }

    if (/tool_calls/i.test(sseText)) {
      returnedToolCalls = true;
    }
    if (/finish_reason/i.test(sseText)) {
      returnedFinishReason = true;
    }

    let recommendedTrack: StreamTrack = "builtin";
    const issues: string[] = [];

    if (!supportsStreamOptions) {
      issues.push("上游不支持 stream_options 统计");
    }
    if (!returnedFinishReason) {
      issues.push("上游存在 finish_reason 丢失现象");
      recommendedTrack = "tolerant";
    }

    const diagnosis = issues.length > 0
      ? `检测到兼容性特征: ${issues.join("; ")}。推荐使用 ${recommendedTrack} 轨道。`
      : "上游符合标准 OpenAI 流式规范，推荐使用 builtin (主轨)。";

    return {
      ok: true,
      statusCode: 200,
      supportsStreamOptions,
      returnedToolCalls,
      returnedFinishReason,
      recommendedTrack,
      diagnosis,
    };
  } catch (err: any) {
    return {
      ok: false,
      supportsStreamOptions: false,
      returnedToolCalls: false,
      returnedFinishReason: false,
      recommendedTrack: "tolerant",
      diagnosis: `网络异常: ${err.message}`,
    };
  }
}
