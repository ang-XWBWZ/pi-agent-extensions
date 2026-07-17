import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCustomProviders } from "../lib/config.js";
import { detectContextWindow } from "../lib/discovery.js";
import { updateCustomModelLimits } from "../lib/model-limits.js";

function parseTokenLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return Number.NaN;
  const value = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(value)) return Number.NaN;
  if (unit === "m") return Math.round(value * 1000000);
  if (unit === "k") return Math.round(value * 1000);
  return Math.round(value);
}

function formatTokenLimit(value: number): string {
  if (value >= 1000000 && value % 1000000 === 0) return `${value / 1000000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}

function listProviderContexts(): string {
  const customProviders = readCustomProviders();
  const names = Object.keys(customProviders);
  if (names.length === 0) {
    return "No custom providers registered. Use manage_providers action=register first.";
  }

  const lines: string[] = ["Custom provider context windows:"];
  for (const name of names) {
    const cfg = customProviders[name];
    lines.push(`- ${name}:`);
    for (const model of cfg.models) {
      const cw = model.contextWindow ?? detectContextWindow(model.id);
      const max = model.maxTokens;
      lines.push(`  ${model.id}: context=${formatTokenLimit(cw)}${max ? `, max=${formatTokenLimit(max)}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function registerProviderContextCommand(pi: ExtensionAPI): void {
  pi.registerCommand("provider-context", {
    description: "Adjust custom provider model context window: /provider-context <provider> <model> <contextWindow> [maxTokens]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(listProviderContexts(), "info");
        return;
      }
      if (parts.length < 3) {
        ctx.ui.notify(
          "Usage: /provider-context <provider> <model> <contextWindow> [maxTokens]\nExample: /provider-context openai-openai gpt-5.4 272K",
          "error",
        );
        return;
      }

      const provider = parts[0];
      const model = parts[1];
      const contextWindow = parseTokenLimit(parts[2]);
      const maxTokens = parseTokenLimit(parts[3]);
      if (!contextWindow || contextWindow <= 0) {
        ctx.ui.notify("contextWindow must be a positive number, for example 272K, 400K, or 1000000.", "error");
        return;
      }
      if (parts[3] !== undefined && (!maxTokens || maxTokens <= 0)) {
        ctx.ui.notify("maxTokens must be a positive number.", "error");
        return;
      }

      try {
        const updated = updateCustomModelLimits(pi, provider, model, contextWindow, maxTokens);
        if (ctx.model?.provider === provider && ctx.model?.id === model) {
          const refreshed = ctx.modelRegistry.find(provider, model);
          if (refreshed) await pi.setModel(refreshed);
        }
        ctx.ui.notify(
          `Updated ${updated.provider}/${updated.model}: contextWindow=${updated.contextWindow}, maxTokens=${updated.maxTokens}`,
          "info",
        );
      } catch (e: unknown) {
        ctx.ui.notify((e as Error).message, "error");
      }
    },
  });
}
