/**
 * AUTO_FLASH: model-backed review for AUTO command approval boundaries.
 *
 * The command only configures a model. Authorization still comes from the
 * execution profile; a model response can deny an AUTO command but cannot
 * promote guarded work or grant AUTO_ALL.
 */

import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsSection, updateSettings } from "../lib/settings-io.js";
import { redactAuditText } from "../lib/audit-sanitize.js";

export const AUTO_FLASH_SETTINGS_KEY = "autoFlashModel";

export interface AutoFlashModelRef {
  provider: string;
  model: string;
}

export interface AutoFlashReviewRequest {
  command: string;
  toolName?: string;
  purpose?: string;
  cwd: string;
  effect: string;
}

export interface AutoFlashReviewResult {
  allow: boolean;
  reason: string;
  modelRef?: string;
  skipped?: boolean;
}

function normalizeRef(value: unknown): AutoFlashModelRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return provider && model ? { provider, model } : undefined;
}

export function getAutoFlashModel(): AutoFlashModelRef | undefined {
  return normalizeRef(getSettingsSection(AUTO_FLASH_SETTINGS_KEY, undefined));
}

function modelLabel(ref: AutoFlashModelRef | undefined): string {
  return ref ? `${ref.provider}/${ref.model}` : "未配置";
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function parseAutoFlashDecision(text: string): { allow: boolean; reason: string } | undefined {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>;
    if (typeof value.allow !== "boolean") return undefined;
    const reason = typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim().slice(0, 600)
      : value.allow ? "AUTO_FLASH 审查通过" : "AUTO_FLASH 审查拒绝，但未给出原因";
    return { allow: value.allow, reason };
  } catch {
    return undefined;
  }
}

export async function reviewWithAutoFlash(
  ctx: ExtensionContext,
  request: AutoFlashReviewRequest,
): Promise<AutoFlashReviewResult> {
  const ref = getAutoFlashModel();
  if (!ref) {
    return {
      allow: false,
      reason: "未配置 AUTO_FLASH 模型；请先执行 /auto_flash <provider>/<model>",
    };
  }

  const model = ctx.modelRegistry.find(ref.provider, ref.model) as Model<any> | undefined;
  const modelRef = modelLabel(ref);
  if (!model) {
    return {
      allow: false,
      modelRef,
      reason: `AUTO_FLASH 模型不可用：${modelRef}；请执行 /auto_flash 重新配置`,
    };
  }
  const provider = ctx.modelRegistry.getProvider(ref.provider);
  if (!provider) {
    return {
      allow: false,
      modelRef,
      reason: `AUTO_FLASH 供应商运行时未注册：${ref.provider}；请先恢复 provider-manager 或执行 /reload`,
    };
  }

  let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try {
    auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      allow: false,
      modelRef,
      reason: `AUTO_FLASH 认证解析失败，已拒绝：${detail.slice(0, 300)}`,
    };
  }
  if (!auth.ok) {
    return {
      allow: false,
      modelRef,
      reason: `AUTO_FLASH 认证不可用，已拒绝：${auth.error.slice(0, 300)}`,
    };
  }

  const safeCommand = redactAuditText(request.command).slice(0, 6_000);
  const safePurpose = redactAuditText(request.purpose ?? "未提供").slice(0, 600);
  const prompt = [
    "审查下面这条即将执行的命令或工具调用。你是安全审批器，不负责执行调用。",
    "只返回 JSON，不要 Markdown：{\"allow\":true|false,\"reason\":\"简短中文原因\"}。",
    "拒绝受保护路径、明显破坏性且缺少回滚依据、凭证外泄、目录越界、全局不可控副作用或用途与命令不一致的请求。",
    `工作目录: ${redactAuditText(request.cwd).slice(0, 500)}`,
    `命令风险分类: ${request.effect}`,
    `调用工具: ${request.toolName ?? "shell"}`,
    `调用用途: ${safePurpose}`,
    `调用目标: ${safeCommand}`,
  ].join("\n");

  try {
    const response = await provider.streamSimple(
      model,
      {
        systemPrompt: "你是严格、简洁、保守的安全审批器。输出必须是 JSON。",
        messages: [{ role: "user", content: prompt, timestamp: 0 }],
        tools: [],
      },
      {
        reasoning: "low",
        maxTokens: 512,
        signal: ctx.signal,
        timeoutMs: 30_000,
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
      },
    ).result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const detail = response.errorMessage || `provider stopReason=${response.stopReason}`;
      return {
        allow: false,
        modelRef,
        reason: `AUTO_FLASH 调用失败，已拒绝：${detail.slice(0, 300)}`,
      };
    }
    const decision = parseAutoFlashDecision(assistantText(response));
    if (!decision) {
      return {
        allow: false,
        modelRef,
        reason: `AUTO_FLASH 返回格式无法验证，已拒绝：${modelRef}`,
      };
    }
    return { ...decision, modelRef };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      allow: false,
      modelRef,
      reason: `AUTO_FLASH 调用失败，已拒绝：${detail.slice(0, 300)}`,
    };
  }
}

function parseModelRef(args: string): AutoFlashModelRef | undefined {
  const value = args.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) return undefined;
  const provider = value.slice(0, slash).trim();
  const model = value.slice(slash + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

export function registerAutoFlashCommand(pi: ExtensionAPI): void {
  pi.registerCommand("auto_flash", {
    description: "配置 AUTO 的 AI 安全审批模型: /auto_flash <provider>/<model> | off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value.toLowerCase() === "off" || value.toLowerCase() === "disable") {
        updateSettings((settings) => {
          delete settings[AUTO_FLASH_SETTINGS_KEY];
          return settings;
        });
        ctx.ui.notify("AUTO_FLASH 已关闭；/auto 将拒绝需要 AI 审批的命令，/auto_all 仍是全同意模式", "warning");
        return;
      }

      let ref = parseModelRef(value);
      if (!ref) {
        const available = await ctx.modelRegistry.getAvailable();
        if (available.length === 0) {
          ctx.ui.notify("没有可用模型。用法: /auto_flash <provider>/<model> 或 /auto_flash off", "error");
          return;
        }
        const selected = await ctx.ui.select(
          "选择 AUTO_FLASH 安全审批模型",
          available.map((model) => `${model.provider}/${model.id}`),
        );
        ref = selected ? parseModelRef(selected) : undefined;
      }
      if (!ref) return;
      if (!ctx.modelRegistry.find(ref.provider, ref.model)) {
        ctx.ui.notify(`模型不存在或不可用: ${modelLabel(ref)}`, "error");
        return;
      }
      updateSettings((settings) => {
        settings[AUTO_FLASH_SETTINGS_KEY] = ref;
        return settings;
      });
      ctx.ui.notify(`AUTO_FLASH 已配置: ${modelLabel(ref)}`, "info");
    },
  });
}
