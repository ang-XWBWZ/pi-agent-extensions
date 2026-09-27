/**
 * provider-manager.ts — 自定义供应商管理
 *
 * 独立负责自定义供应商的注册、持久化、启动恢复。
 * Openai 兼容流全部复用 pi-main 内置 provider，只通过 tolerant wrapper
 * 处理供应商缺少 finish_reason 的兼容问题。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviderContextCommand } from "./provider-manager/commands/provider-context.js";
import { restoreCustomProviders } from "./provider-manager/lib/register.js";
import { registerManageProviders } from "./provider-manager/tools/manage-providers.js";
import { registerCapability } from "./lib/capability-router.js";

export default function (pi: ExtensionAPI) {
  registerCapability({
    id: "provider_manager",
    name: "Custom Provider Manager",
    summary: "Register, inspect, and configure custom LLM API providers (OpenAI/Anthropic compatible).",
    keywords: ["provider", "api_key", "base_url", "manage_providers", "custom model", "endpoint"],
    phases: ["work", "plan"],
    tools: ["manage_providers"],
    toolDescriptions: {
      manage_providers: "注册、删除、列出及配置自定义 API Provider (包括 baseUrl, apiKey, apiStyle, contextWindow, reasoningModels 等)",
    },
    usageDoc: `# Custom Provider Manager Subsystem (provider_manager)

### Available Tool:
- \`manage_providers\`: Register, remove, list, and configure custom model providers.

### Usage Guidelines:
1. Use manage_providers only for explicit provider inspection or persistent registration, repair, refresh, and removal.
2. Use manage_providers list before mutation; use switch_model for active model selection after registration succeeds.
3. If manage_providers connection tests fail, report the capability diagnostics instead of cycling through random compatibility modes.

### Common Actions:
- \`manage_providers({ action: "list" })\`: List all registered custom providers.
- \`manage_providers({ action: "register", provider: "...", baseUrl: "...", apiKey: "...", apiStyle?: "auto"|"openai"|"anthropic", testModel?: "..." })\`: Register a new custom provider.
- \`manage_providers({ action: "remove", provider: "..." })\`: Remove a registered custom provider.
- \`manage_providers({ action: "refresh_models", provider: "..." })\`: Discover and refresh model list from the provider endpoint.
- \`manage_providers({ action: "set_reasoning_models", provider: "...", reasoningModels: ["..."] })\`: Configure thinking/reasoning support for specific models.
- \`manage_providers({ action: "set_context_window", provider: "...", model: "...", contextWindow: 128000 })\`: Override context window size.
- \`manage_providers({ action: "set_stream_compat_mode", provider: "...", streamCompatMode: "auto"|"builtin"|"finish-reason-fallback" })\`: Configure streaming compatibility mode.`,
  });

  restoreCustomProviders(pi);

  pi.on("session_start", async () => {
    restoreCustomProviders(pi);
  });

  registerManageProviders(pi);
  registerProviderContextCommand(pi);
}
