/**
 * manage-providers.ts — manage_providers 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readCustomProviders,
  writeCustomProviders,
  normalizeBaseUrl,
  type DiscoveredModel,
} from "../lib/config.js";
import { testProviderConnection, discoverModelsFromProvider } from "../lib/discovery.js";
import { buildModelConfigs, registerCustomProvider } from "../lib/register.js";

export function registerManageProviders(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "manage_providers",
    label: "Manage Providers",
    description: "注册、移除、列出自定义模型供应商。",
    promptSnippet: "Register/list/remove custom model providers. Use switch_model only after provider registration.",
    promptGuidelines: [
      "Use action=register with baseUrl+apiKey to add a custom provider.",
      "apiStyle can be auto, openai, or anthropic; auto tests OpenAI-compatible first.",
      "Provider names are suffixed with detected API style: {name}-{openai|anthropic}.",
      "All custom provider models support every standard thinking level by default.",
      "Use action=set_reasoning_models with provider+reasoningModels only when you want to restrict reasoning models.",
      "Use action=set_model_limits with provider+model+contextWindow/maxTokens to edit one model's limits.",
      "Use action=list to inspect persisted custom providers.",
      "Use action=remove with provider=<name> to unregister and remove a custom provider.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "register|remove|list|set_reasoning_models|set_model_limits" })),
      provider: Type.Optional(Type.String({ description: "供应商名称" })),
      model: Type.Optional(Type.String({ description: "模型 ID (set_model_limits 使用)" })),
      baseUrl: Type.Optional(Type.String({ description: "API 基础地址 (register 必填)" })),
      apiKey: Type.Optional(Type.String({ description: "API 密钥 (register 必填)" })),
      apiStyle: Type.Optional(Type.String({ description: "openai|anthropic|auto，默认 auto" })),
      testModel: Type.Optional(Type.String({ description: "测试用模型 ID" })),
      contextWindow: Type.Optional(Type.Number({ description: "上下文窗口大小，可选" })),
      maxTokens: Type.Optional(Type.Number({ description: "最大输出 token，可选" })),
      reasoningModels: Type.Optional(Type.Array(Type.String({ description: "Model IDs that should keep thinking/reasoning when restricting manually" }))),
      supportsUsageInStreaming: Type.Optional(Type.Boolean({ description: "OpenAI 流式响应是否支持 usage 尾包，默认 true；异常时可设 false" })),
      streamCompatMode: Type.Optional(Type.String({ description: "流兼容模式: builtin(默认) | finish-reason-fallback(上游缺少finish_reason时用)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      const action = params.action || "list";

      if (action === "list") {
        const customProviders = readCustomProviders();
        const names = Object.keys(customProviders);
        if (names.length === 0) {
          return { content: [{ type: "text", text: "没有已注册的自定义供应商。使用 manage_providers action=register 添加。" }], details: { providers: [] } };
        }
        const lines = names.map((name) => {
          const c = customProviders[name];
          const since = new Date(c.createdAt).toLocaleDateString();
          return `  • ${name} — ${c.apiStyle}, ${c.models.length} 个模型 (${since})`;
        });
        return { content: [{ type: "text", text: `自定义供应商 (${names.length}):\n${lines.join("\n")}` }], details: { providers: names } };
      }

      if (action === "remove") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider 名称" }], details: {} };
        const customProviders = readCustomProviders();
        if (!customProviders[providerName]) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `自定义供应商 "${providerName}" 不存在。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }
        try { pi.unregisterProvider(providerName); } catch {}
        delete customProviders[providerName];
        writeCustomProviders(customProviders);
        return { content: [{ type: "text", text: `✅ 已移除自定义供应商: ${providerName}` }], details: { provider: providerName } };
      }

      if (action === "set_reasoning_models") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider" }], details: {} };
        if (!Array.isArray(params.reasoningModels)) return { content: [{ type: "text", text: "需要 reasoningModels" }], details: {} };
        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `provider 不存在: ${providerName}。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }

        const reasoningModelIds = new Set((params.reasoningModels as string[]).map((id) => id.trim()).filter(Boolean));
        cfg.models = cfg.models.map((m) => ({ ...m, reasoning: reasoningModelIds.has(m.id) }));
        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(pi, providerName, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, cfg.streamCompatMode ?? "builtin");

        return {
          content: [{ type: "text", text: `✅ 已更新 ${providerName} reasoning models: ${[...reasoningModelIds].join(", ") || "(none)"}` }],
          details: { provider: providerName, reasoningModels: [...reasoningModelIds] },
        };
      }

      if (action === "set_model_limits") {
        const providerName = params.provider?.trim();
        const modelId = params.model?.trim();
        if (!providerName) return { content: [{ type: "text", text: "需要 provider" }], details: {} };
        if (!modelId) return { content: [{ type: "text", text: "需要 model" }], details: {} };
        const contextWindow = params.contextWindow !== undefined ? Number(params.contextWindow) : undefined;
        const maxTokens = params.maxTokens !== undefined ? Number(params.maxTokens) : undefined;
        if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
          return { content: [{ type: "text", text: "contextWindow 必须是正数" }], details: {} };
        }
        if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
          return { content: [{ type: "text", text: "maxTokens 必须是正数" }], details: {} };
        }
        if (contextWindow === undefined && maxTokens === undefined) {
          return { content: [{ type: "text", text: "需要 contextWindow 或 maxTokens" }], details: {} };
        }

        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `provider 不存在: ${providerName}。已注册: ${keys.join(", ") || "(无)"}` }], details: {} };
        }

        let found = false;
        cfg.models = cfg.models.map((m) => {
          if (m.id !== modelId) return m;
          found = true;
          return {
            ...m,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          };
        });
        if (!found) {
          return { content: [{ type: "text", text: `模型不存在: ${providerName}/${modelId}` }], details: {} };
        }

        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(pi, providerName, cfg.baseUrl, cfg.apiKey, cfg.apiStyle, modelConfigs, cfg.streamCompatMode ?? "builtin");

        const updated = modelConfigs.find((m) => m.id === modelId);
        return {
          content: [{ type: "text", text: `✅ 已更新 ${providerName}/${modelId}: contextWindow=${updated?.contextWindow}, maxTokens=${updated?.maxTokens}` }],
          details: { provider: providerName, model: modelId, contextWindow: updated?.contextWindow, maxTokens: updated?.maxTokens },
        };
      }

      if (action !== "register") {
        return { content: [{ type: "text", text: `未知 action: ${action}。支持: register|remove|list|set_reasoning_models|set_model_limits` }], details: {} };
      }

      // ---- register ----
      const baseUrl = params.baseUrl?.trim();
      const apiKey = params.apiKey?.trim();
      if (!baseUrl) return { content: [{ type: "text", text: "需要 baseUrl (API 基础地址)" }], details: {} };
      if (!apiKey) return { content: [{ type: "text", text: "需要 apiKey (API 密钥)" }], details: {} };

      let rawName = (params.provider || "custom").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      rawName = rawName.replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!rawName) rawName = "custom";

      const apiStyle = params.apiStyle || "auto";
      if (!["auto", "openai", "anthropic"].includes(apiStyle)) {
        return { content: [{ type: "text", text: `无效 apiStyle: ${apiStyle}。支持: auto, openai, anthropic` }], details: {} };
      }

      const testResult = await testProviderConnection(baseUrl, apiKey, apiStyle, params.testModel);
      if (!testResult.ok) {
        return { content: [{ type: "text", text: `❌ 连接测试失败: ${testResult.error}\n请检查 baseUrl 和 apiKey 是否正确，以及 API 风格是否匹配。` }], details: {} };
      }

      const detectedApi = testResult.detectedApi!;
      const providerName = `${rawName}-${detectedApi}`;
      const existingProviders = readCustomProviders();
      if (existingProviders[providerName]) {
        return { content: [{ type: "text", text: `供应商 "${providerName}" 已存在。如要更新请先执行 remove 移除。` }], details: {} };
      }
      if (ctx.modelRegistry.getAll().some((m: any) => m.provider === providerName)) {
        return { content: [{ type: "text", text: `供应商 "${providerName}" 已存在于模型注册表中。` }], details: {} };
      }

      const discoveredModels = await discoverModelsFromProvider(baseUrl, apiKey, detectedApi);
      const reasoningModelIds = Array.isArray(params.reasoningModels)
        ? new Set((params.reasoningModels as string[]).map((id) => id.trim()).filter(Boolean))
        : undefined;
      const persistedModels = reasoningModelIds
        ? discoveredModels.map((m) => ({ ...m, reasoning: reasoningModelIds.has(m.id) }))
        : discoveredModels;
      const supportsUsageInStreaming = typeof params.supportsUsageInStreaming === "boolean"
        ? params.supportsUsageInStreaming
        : undefined;
      const compat = detectedApi === "openai" && typeof supportsUsageInStreaming === "boolean"
        ? { supportsUsageInStreaming }
        : undefined;
      const modelConfigs = buildModelConfigs(
        persistedModels,
        params.contextWindow ? Number(params.contextWindow) : undefined,
        params.maxTokens ? Number(params.maxTokens) : undefined,
        compat,
      );
      const streamCompatModeRaw = params.streamCompatMode || "builtin";
      if (!["builtin", "finish-reason-fallback"].includes(streamCompatModeRaw)) {
        return { content: [{ type: "text", text: `无效 streamCompatMode: ${streamCompatModeRaw}。支持: builtin | finish-reason-fallback` }], details: {} };
      }
      const streamCompatMode = streamCompatModeRaw as "builtin" | "finish-reason-fallback";

      try {
        registerCustomProvider(pi, providerName, baseUrl, apiKey, detectedApi, modelConfigs, streamCompatMode);
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `❌ 注册失败: ${(e as Error).message}` }], details: {} };
      }

      const customProviders = readCustomProviders();
      customProviders[providerName] = {
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        apiStyle: detectedApi,
        models: persistedModels,
        createdAt: Date.now(),
        streamCompatMode,
        ...(typeof supportsUsageInStreaming === "boolean" ? { supportsUsageInStreaming } : {}),
      };
      writeCustomProviders(customProviders);

      const modelList = discoveredModels.slice(0, 10).map((m) => {
        const cfg = modelConfigs.find((c) => c.id === m.id);
        const cw = cfg?.contextWindow ?? 0;
        const ctxLabel = cw >= 1000000 ? `${(cw / 1000000).toFixed(0)}M` : `${(cw / 1000).toFixed(0)}k`;
        const reasoningLabel = cfg?.reasoning ? ", reasoning" : "";
        return `  - ${m.id} (上下文: ${ctxLabel}${reasoningLabel})`;
      }).join("\n");
      const more = discoveredModels.length > 10 ? `\n  ... 以及 ${discoveredModels.length - 10} 个其他模型` : "";

      const streamModeLabel = streamCompatMode === "finish-reason-fallback"
        ? `   流模式: finish-reason-fallback (含 pi-main 消息转换)`
        : `   流模式: builtin (OpenAI SDK)`;

      return {
        content: [{ type: "text", text: [
          `✅ 自定义供应商注册成功: ${providerName}`,
          `   检测到 API 风格: ${detectedApi}`,
          `   基础地址: ${normalizeBaseUrl(baseUrl)}`,
          streamModeLabel,
          detectedApi === "openai" && typeof supportsUsageInStreaming === "boolean"
            ? `   流式 usage: ${supportsUsageInStreaming ? "开启" : "关闭"}`
            : "",
          `   发现 ${discoveredModels.length} 个模型: ${discoveredModels.length > 0 ? "" : "(可在 models.json 中手动添加)"}`,
          discoveredModels.length > 0 ? modelList + more : "",
          "",
          `使用方式:`,
          `  • 切换模型: switch_model provider=${providerName} model=<模型ID>`,
          `  • 添加到层级: /tier-add <L0|L1|L2> ${providerName} <模型ID>`,
          `  • 设置默认: /set-default ${providerName} <模型ID>`,
          `  • 查看供应商: manage_providers action=list`,
          `  • 移除供应商: manage_providers action=remove provider=${providerName}`,
        ].join("\n") }],
        details: {
          provider: providerName,
          api: detectedApi,
          streamCompatMode,
          supportsUsageInStreaming,
          reasoningModels: modelConfigs.filter((m) => m.reasoning).map((m) => m.id),
          baseUrl: normalizeBaseUrl(baseUrl),
          modelsCount: discoveredModels.length,
          models: discoveredModels.map((m) => m.id),
        },
      };
    },
  });
}
