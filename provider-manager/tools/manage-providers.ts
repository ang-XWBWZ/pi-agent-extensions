/**
 * manage-providers.ts - manage_providers tool registration
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readCustomProviders,
  writeCustomProviders,
  normalizeBaseUrl,
} from "../lib/config.js";
import type { AnthropicThinkingMode } from "../lib/config.js";
import {
  testProviderConnection,
  discoverModelsFromProvider,
  discoverModelsFromProviderWithDiagnostics,
} from "../lib/discovery.js";
import { buildModelConfigs, registerCustomProvider } from "../lib/register.js";

type OpenAIApiMode = "chat-completions" | "responses";
type StreamCompatMode = "builtin" | "finish-reason-fallback";

function isOpenAIApiMode(value: unknown): value is OpenAIApiMode {
  return value === "chat-completions" || value === "responses";
}

function isStreamCompatMode(value: unknown): value is StreamCompatMode {
  return value === "builtin" || value === "finish-reason-fallback";
}

function isAnthropicThinkingMode(value: unknown): value is AnthropicThinkingMode {
  return value === "builtin" || value === "adaptive_effort";
}

export function registerManageProviders(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "manage_providers",
    label: "Manage Providers",
    description: "Register, remove, and list custom model providers.",
    promptSnippet: "Register/list/remove custom model providers. Use switch_model only after provider registration.",
    promptGuidelines: [
      "Use when: the user explicitly wants to register, remove, repair, refresh, or inspect custom model providers.",
      "Do not use when: ordinary model switching, tier routing, or thinking-level adjustment is enough.",
      "Phase policy: Plan may list providers or plan a provider change; Work may register/remove only with explicit credentials and user intent.",
      "Workflow: list existing providers -> register/refresh/remove -> switch_model or tier-add after registration succeeds.",
      "Conflict policy: switch_model owns active model selection; manage_providers owns persistent provider configuration.",
      "Failure / fallback: if connection tests fail, report baseUrl/apiStyle/model discovery diagnostics and stop instead of trying random modes repeatedly.",
      "Use action=register with baseUrl+apiKey to add a custom provider.",
      "apiStyle can be auto, openai, or anthropic; auto tests OpenAI-compatible first.",
      "For OpenAI providers, default to Chat Completions compatibility mode. Use Responses direct mode only as an explicit or fallback path.",
      "Use streamCompatMode=finish-reason-fallback only for OpenAI Chat Completions streams that lack finish_reason.",
      "AI may proactively choose apiStyle, openaiApiMode, and streamCompatMode based on provider capability tests.",
      "Provider names are suffixed with detected API style: {name}-{openai|anthropic}.",
      "All custom provider models support every standard thinking level by default.",
      "Use action=set_reasoning_models with provider+reasoningModels only when you want to restrict reasoning models.",
      "Use action=set_model_limits with provider+model+contextWindow/maxTokens to edit one model's limits.",
      "Use action=refresh_models with provider=<name> to rediscover and persist models for an existing provider.",
      "Use action=set_stream_compat_mode with provider+streamCompatMode to switch an OpenAI Chat Completions provider between builtin and finish-reason-fallback.",
      "For Anthropic providers, use anthropicThinkingMode=adaptive_effort (recommended) to send thinking:{type:adaptive}+output_config:{effort:low|medium|high|xhigh|max}. Use builtin to fall back to Pi kernel.",
      "Use action=list to inspect persisted custom providers.",
      "Use action=remove with provider=<name> to unregister and remove a custom provider.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "register|remove|list|set_reasoning_models|set_model_limits|set_stream_compat_mode|refresh_models" })),
      provider: Type.Optional(Type.String({ description: "Provider name" })),
      model: Type.Optional(Type.String({ description: "Model ID for set_model_limits" })),
      baseUrl: Type.Optional(Type.String({ description: "API base URL for register" })),
      apiKey: Type.Optional(Type.String({ description: "API key for register" })),
      apiStyle: Type.Optional(Type.String({ description: "openai|anthropic|auto, default auto" })),
      openaiApiMode: Type.Optional(Type.String({ description: "OpenAI API mode: auto(default: prefer chat-completions compatibility, fallback responses) | chat-completions | responses" })),
      testModel: Type.Optional(Type.String({ description: "Model ID used for connection tests" })),
      contextWindow: Type.Optional(Type.Number({ description: "Optional context window override" })),
      maxTokens: Type.Optional(Type.Number({ description: "Optional max output token override" })),
      reasoningModels: Type.Optional(Type.Array(Type.String({ description: "Model IDs that should keep thinking/reasoning when restricting manually" }))),
      supportsUsageInStreaming: Type.Optional(Type.Boolean({ description: "Whether OpenAI streaming supports usage tail chunks" })),
      streamCompatMode: Type.Optional(Type.String({ description: "builtin | finish-reason-fallback" })),
      anthropicThinkingMode: Type.Optional(Type.String({ description: "Claude thinking mode: builtin | adaptive_effort (recommended)" })),
    }),
    async execute(_id, params, _sig, _up, ctx) {
      const action = params.action || "list";

      if (action === "list") {
        const customProviders = readCustomProviders();
        const names = Object.keys(customProviders);
        if (names.length === 0) {
          return { content: [{ type: "text", text: "No custom providers registered. Use manage_providers action=register to add one." }], details: { providers: [] } };
        }
        const lines = names.map((name) => {
          const c = customProviders[name];
          const since = new Date(c.createdAt).toLocaleDateString();
          const apiMode = c.apiStyle === "openai" ? `, ${c.openaiApiMode ?? "chat-completions"}` : "";
          return `  - ${name}: ${c.apiStyle}${apiMode}, ${c.models.length} models (${since})`;
        });
        return { content: [{ type: "text", text: `Custom providers (${names.length}):\n${lines.join("\n")}` }], details: { providers: names } };
      }

      if (action === "remove") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "provider is required" }], details: {} };
        const customProviders = readCustomProviders();
        if (!customProviders[providerName]) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `Provider "${providerName}" does not exist. Registered: ${keys.join(", ") || "(none)"}` }], details: {} };
        }
        try { pi.unregisterProvider(providerName); } catch {}
        delete customProviders[providerName];
        writeCustomProviders(customProviders);
        return { content: [{ type: "text", text: `Removed custom provider: ${providerName}` }], details: { provider: providerName } };
      }

      if (action === "set_reasoning_models") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "provider is required" }], details: {} };
        if (!Array.isArray(params.reasoningModels)) return { content: [{ type: "text", text: "reasoningModels is required" }], details: {} };
        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `Provider does not exist: ${providerName}. Registered: ${keys.join(", ") || "(none)"}` }], details: {} };
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
        registerCustomProvider(
          pi,
          providerName,
          cfg.baseUrl,
          cfg.apiKey,
          cfg.apiStyle,
          modelConfigs,
          cfg.streamCompatMode ?? "builtin",
          cfg.openaiApiMode ?? "chat-completions",
          cfg.anthropicThinkingMode ?? "builtin",
        );

        return {
          content: [{ type: "text", text: `Updated ${providerName} reasoning models: ${[...reasoningModelIds].join(", ") || "(none)"}` }],
          details: { provider: providerName, reasoningModels: [...reasoningModelIds] },
        };
      }

      if (action === "set_model_limits") {
        const providerName = params.provider?.trim();
        const modelId = params.model?.trim();
        if (!providerName) return { content: [{ type: "text", text: "provider is required" }], details: {} };
        if (!modelId) return { content: [{ type: "text", text: "model is required" }], details: {} };
        const contextWindow = params.contextWindow !== undefined ? Number(params.contextWindow) : undefined;
        const maxTokens = params.maxTokens !== undefined ? Number(params.maxTokens) : undefined;
        if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
          return { content: [{ type: "text", text: "contextWindow must be positive" }], details: {} };
        }
        if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0)) {
          return { content: [{ type: "text", text: "maxTokens must be positive" }], details: {} };
        }
        if (contextWindow === undefined && maxTokens === undefined) {
          return { content: [{ type: "text", text: "contextWindow or maxTokens is required" }], details: {} };
        }

        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `Provider does not exist: ${providerName}. Registered: ${keys.join(", ") || "(none)"}` }], details: {} };
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
          return { content: [{ type: "text", text: `Model does not exist: ${providerName}/${modelId}` }], details: {} };
        }

        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(
          pi,
          providerName,
          cfg.baseUrl,
          cfg.apiKey,
          cfg.apiStyle,
          modelConfigs,
          cfg.streamCompatMode ?? "builtin",
          cfg.openaiApiMode ?? "chat-completions",
          cfg.anthropicThinkingMode ?? "builtin",
        );

        const updated = modelConfigs.find((m) => m.id === modelId);
        return {
          content: [{ type: "text", text: `Updated ${providerName}/${modelId}: contextWindow=${updated?.contextWindow}, maxTokens=${updated?.maxTokens}` }],
          details: { provider: providerName, model: modelId, contextWindow: updated?.contextWindow, maxTokens: updated?.maxTokens },
        };
      }

      if (action === "set_stream_compat_mode") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "provider is required" }], details: {} };
        const streamCompatModeRaw = params.streamCompatMode || "builtin";
        if (!isStreamCompatMode(streamCompatModeRaw)) {
          return { content: [{ type: "text", text: `Invalid streamCompatMode: ${streamCompatModeRaw}. Supported: builtin | finish-reason-fallback` }], details: {} };
        }

        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `Provider does not exist: ${providerName}. Registered: ${keys.join(", ") || "(none)"}` }], details: {} };
        }
        if (cfg.apiStyle !== "openai") {
          return { content: [{ type: "text", text: "streamCompatMode can only be changed for OpenAI providers" }], details: { provider: providerName, apiStyle: cfg.apiStyle } };
        }

        const openaiApiMode = cfg.openaiApiMode ?? "chat-completions";
        if (openaiApiMode !== "chat-completions" && streamCompatModeRaw !== "builtin") {
          return { content: [{ type: "text", text: "finish-reason-fallback only supports openaiApiMode=chat-completions" }], details: { provider: providerName, openaiApiMode } };
        }

        cfg.streamCompatMode = streamCompatModeRaw;
        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(
          pi,
          providerName,
          cfg.baseUrl,
          cfg.apiKey,
          cfg.apiStyle,
          modelConfigs,
          cfg.streamCompatMode,
          openaiApiMode,
          cfg.anthropicThinkingMode ?? "builtin",
        );

        const piApi = streamCompatModeRaw === "finish-reason-fallback"
          ? `${providerName}-openai-tolerant`
          : openaiApiMode === "responses"
            ? "openai-responses"
            : "openai-completions";
        return {
          content: [{ type: "text", text: `Updated ${providerName}: openaiApiMode=${openaiApiMode}, streamCompatMode=${streamCompatModeRaw}, piApi=${piApi}` }],
          details: { provider: providerName, openaiApiMode, streamCompatMode: streamCompatModeRaw, piApi },
        };
      }

      if (action === "refresh_models") {
        const providerName = params.provider?.trim();
        if (!providerName) return { content: [{ type: "text", text: "provider is required" }], details: {} };
        const customProviders = readCustomProviders();
        const cfg = customProviders[providerName];
        if (!cfg) {
          const keys = Object.keys(customProviders);
          return { content: [{ type: "text", text: `Provider does not exist: ${providerName}. Registered: ${keys.join(", ") || "(none)"}` }], details: {} };
        }

        const discovery = await discoverModelsFromProviderWithDiagnostics(cfg.baseUrl, cfg.apiKey, cfg.apiStyle);
        const discoveredModels = discovery.models;
        if (discoveredModels.length === 0) {
          return {
            content: [{ type: "text", text: `No models discovered for ${providerName}; existing model list was left unchanged. Reason: ${discovery.error || "unknown"}` }],
            details: { provider: providerName, modelsCount: 0, status: discovery.status, error: discovery.error },
          };
        }

        const existingById = new Map(cfg.models.map((m) => [m.id, m]));
        cfg.models = discoveredModels.map((m) => {
          const existing = existingById.get(m.id);
          return {
            ...m,
            ...(existing?.reasoning !== undefined ? { reasoning: existing.reasoning } : {}),
            ...(existing?.contextWindow !== undefined ? { contextWindow: existing.contextWindow } : {}),
            ...(existing?.maxTokens !== undefined ? { maxTokens: existing.maxTokens } : {}),
          };
        });
        customProviders[providerName] = cfg;
        writeCustomProviders(customProviders);

        const compat = cfg.apiStyle === "openai" && typeof cfg.supportsUsageInStreaming === "boolean"
          ? { supportsUsageInStreaming: cfg.supportsUsageInStreaming }
          : undefined;
        const modelConfigs = buildModelConfigs(cfg.models, undefined, undefined, compat);
        try { pi.unregisterProvider(providerName); } catch {}
        registerCustomProvider(
          pi,
          providerName,
          cfg.baseUrl,
          cfg.apiKey,
          cfg.apiStyle,
          modelConfigs,
          cfg.streamCompatMode ?? "builtin",
          cfg.openaiApiMode ?? "chat-completions",
          cfg.anthropicThinkingMode ?? "builtin",
        );

        return {
          content: [{ type: "text", text: `Refreshed ${providerName}: discovered ${discoveredModels.length} models.` }],
          details: { provider: providerName, modelsCount: discoveredModels.length, models: discoveredModels.map((m) => m.id) },
        };
      }

      if (action !== "register") {
        return { content: [{ type: "text", text: `Unknown action: ${action}. Supported: register|remove|list|set_reasoning_models|set_model_limits|set_stream_compat_mode|refresh_models` }], details: {} };
      }

      const baseUrl = params.baseUrl?.trim();
      const apiKey = params.apiKey?.trim();
      if (!baseUrl) return { content: [{ type: "text", text: "baseUrl is required" }], details: {} };
      if (!apiKey) return { content: [{ type: "text", text: "apiKey is required" }], details: {} };

      let rawName = (params.provider || "custom").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      rawName = rawName.replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (!rawName) rawName = "custom";

      const apiStyle = params.apiStyle || "auto";
      if (!["auto", "openai", "anthropic"].includes(apiStyle)) {
        return { content: [{ type: "text", text: `Invalid apiStyle: ${apiStyle}. Supported: auto, openai, anthropic` }], details: {} };
      }
      const requestedOpenAIMode = params.openaiApiMode || "auto";
      if (!["auto", "responses", "chat-completions"].includes(requestedOpenAIMode)) {
        return { content: [{ type: "text", text: `Invalid openaiApiMode: ${requestedOpenAIMode}. Supported: auto | responses | chat-completions` }], details: {} };
      }

      const preferredOpenAIMode = requestedOpenAIMode === "responses" ? "responses" : "chat-completions";
      const testResult = await testProviderConnection(baseUrl, apiKey, apiStyle, params.testModel, preferredOpenAIMode);
      if (!testResult.ok) {
        return { content: [{ type: "text", text: `Connection test failed: ${testResult.error}\nCheck baseUrl, apiKey, and API style.` }], details: {} };
      }

      const detectedApi = testResult.detectedApi!;
      const openaiApiMode = detectedApi === "openai"
        ? requestedOpenAIMode === "auto"
          ? (testResult.openaiApiMode ?? "chat-completions")
          : requestedOpenAIMode as OpenAIApiMode
        : undefined;
      if (detectedApi === "openai" && requestedOpenAIMode === "chat-completions" && testResult.openaiApiMode !== "chat-completions") {
        return {
          content: [{ type: "text", text: "OpenAI Chat Completions compatibility test failed; Responses direct mode appears available. Use openaiApiMode=auto or responses if you want the fallback path." }],
          details: { detectedMode: testResult.openaiApiMode },
        };
      }
      if (detectedApi === "openai" && requestedOpenAIMode === "responses" && testResult.openaiApiMode !== "responses") {
        return {
          content: [{ type: "text", text: "OpenAI Responses direct-mode stream test failed; cannot register with openaiApiMode=responses. Use auto or chat-completions compatibility mode." }],
          details: { supportsOpenAIResponses: testResult.supportsOpenAIResponses === true },
        };
      }

      const providerName = `${rawName}-${detectedApi}`;
      const existingProviders = readCustomProviders();
      if (existingProviders[providerName]) {
        return { content: [{ type: "text", text: `Provider "${providerName}" already exists. Remove it first to update.` }], details: {} };
      }
      if (ctx.modelRegistry.getAll().some((m: any) => m.provider === providerName)) {
        return { content: [{ type: "text", text: `Provider "${providerName}" already exists in model registry.` }], details: {} };
      }

      const cachedModels = Array.isArray(testResult.discoveredModels) ? testResult.discoveredModels : undefined;
      const discovery = cachedModels && cachedModels.length > 0
        ? { models: cachedModels, status: 200, error: undefined }
        : await discoverModelsFromProviderWithDiagnostics(baseUrl, apiKey, detectedApi);
      const discoveredModels = discovery.models;
      if (discoveredModels.length === 0 && !params.testModel) {
        return {
          content: [{ type: "text", text: `Connection test passed, but no models were discovered from /v1/models. Reason: ${discovery.error || "unknown"}. Register with testModel=<modelId> or fix the provider's /v1/models endpoint.` }],
          details: { provider: providerName, api: detectedApi, modelsCount: 0, status: discovery.status, error: discovery.error },
        };
      }
      const reasoningModelIds = Array.isArray(params.reasoningModels)
        ? new Set((params.reasoningModels as string[]).map((id) => id.trim()).filter(Boolean))
        : undefined;
      const baseModels = discoveredModels.length > 0
        ? discoveredModels
        : [{ id: params.testModel!.trim(), name: params.testModel!.trim() }];
      const persistedModels = reasoningModelIds
        ? baseModels.map((m) => ({ ...m, reasoning: reasoningModelIds.has(m.id) }))
        : baseModels;
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

      const streamCompatModeRaw = params.streamCompatMode
        || (detectedApi === "openai" && openaiApiMode === "chat-completions" && testResult.needsFinishReasonFallback
          ? "finish-reason-fallback"
          : "builtin");
      if (!isStreamCompatMode(streamCompatModeRaw)) {
        return { content: [{ type: "text", text: `Invalid streamCompatMode: ${streamCompatModeRaw}. Supported: builtin | finish-reason-fallback` }], details: {} };
      }
      const streamCompatMode = streamCompatModeRaw;
      if (detectedApi === "openai" && openaiApiMode === "responses" && streamCompatMode !== "builtin") {
        return { content: [{ type: "text", text: "openaiApiMode=responses uses Pi openai-responses and does not support finish-reason-fallback." }], details: {} };
      }
      if (detectedApi === "openai" && openaiApiMode !== undefined && !isOpenAIApiMode(openaiApiMode)) {
        return { content: [{ type: "text", text: `Invalid resolved OpenAI API mode: ${openaiApiMode}` }], details: {} };
      }

      const anthropicThinkingModeRaw = params.anthropicThinkingMode ??
        (detectedApi === "anthropic" ? "adaptive_effort" : undefined);
      const anthropicThinkingMode: AnthropicThinkingMode | undefined =
        isAnthropicThinkingMode(anthropicThinkingModeRaw)
          ? anthropicThinkingModeRaw
          : undefined;

      try {
        registerCustomProvider(
          pi,
          providerName,
          baseUrl,
          apiKey,
          detectedApi,
          modelConfigs,
          streamCompatMode,
          openaiApiMode,
          anthropicThinkingMode ?? "builtin",
        );
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `Registration failed: ${(e as Error).message}` }], details: {} };
      }

      const customProviders = readCustomProviders();
      customProviders[providerName] = {
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        apiStyle: detectedApi,
        ...(openaiApiMode ? { openaiApiMode } : {}),
        ...(anthropicThinkingMode && anthropicThinkingMode !== "builtin" ? { anthropicThinkingMode } : {}),
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
        return `  - ${m.id} (context: ${ctxLabel}${reasoningLabel})`;
      }).join("\n");
      const more = discoveredModels.length > 10 ? `\n  ... and ${discoveredModels.length - 10} more models` : "";
      const streamModeLabel = streamCompatMode === "finish-reason-fallback"
        ? "   streamCompatMode: finish-reason-fallback"
        : "   streamCompatMode: builtin";
      const openaiModeLabel = detectedApi === "openai" ? `   openaiApiMode: ${openaiApiMode}` : "";

      return {
        content: [{ type: "text", text: [
          `Custom provider registered: ${providerName}`,
          `   detected apiStyle: ${detectedApi}`,
          openaiModeLabel,
          `   baseUrl: ${normalizeBaseUrl(baseUrl)}`,
          streamModeLabel,
          detectedApi === "openai" && typeof supportsUsageInStreaming === "boolean"
            ? `   streaming usage: ${supportsUsageInStreaming ? "enabled" : "disabled"}`
            : "",
          `   discovered ${discoveredModels.length} models${discoveredModels.length > 0 ? ":" : ""}`,
          discoveredModels.length > 0 ? modelList + more : "",
          "",
          "Usage:",
          `  - switch_model provider=${providerName} model=<modelId>`,
          `  - /tier-add <L0|L1|L2> ${providerName} <modelId>`,
          `  - /set-default ${providerName} <modelId>`,
          "  - manage_providers action=list",
          `  - manage_providers action=remove provider=${providerName}`,
        ].filter(Boolean).join("\n") }],
        details: {
          provider: providerName,
          api: detectedApi,
          openaiApiMode,
          streamCompatMode,
          supportsOpenAIResponses: testResult.supportsOpenAIResponses,
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
