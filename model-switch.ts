/**
 * model-switch.ts — 模型切换 + 默认模型管理  (v2.0)
 *
 * 命令:
 *   /set-default <provider> <model>  设置默认模型（写入 settings.json，启动自动加载）
 *   /reset-default                   清除默认模型
 *   /model-info                      查看当前/默认模型
 *
 * 工具:
 *   switch_model                     列出可用模型（标注当前/默认）/ 切换模型
 *
 * 启动时若 settings.json 有 defaultProvider/defaultModel 则自动加载。
 * 手动切换过模型的 session 不会被默认覆盖。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const KEY_PROVIDER = "defaultProvider";
const KEY_MODEL = "defaultModel";

function readSettings(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return {}; }
}

function writeSettings(p: string, provider: string | null, model: string | null) {
  const s = readSettings(p);
  if (provider && model) { s[KEY_PROVIDER] = provider; s[KEY_MODEL] = model; }
  else { delete s[KEY_PROVIDER]; delete s[KEY_MODEL]; }
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

function settingsPath(): string {
  return path.join(process.env.USERPROFILE ?? ".", ".pi", "agent", "settings.json");
}

export default function (pi: ExtensionAPI) {
  let defaultRef: { provider: string; model: string } | null = null;

  // ---- session_start: 自动加载默认模型 ----
  pi.on("session_start", async (_event, ctx) => {
    const switched = ctx.sessionManager.getBranch().some((e) => e.type === "model_change");
    if (switched) return; // session 中已手动切换过，不覆盖

    const s = readSettings(settingsPath());
    const provider = s[KEY_PROVIDER] as string | undefined;
    const modelId = s[KEY_MODEL] as string | undefined;
    if (!provider || !modelId) return;

    const target = ctx.modelRegistry.find(provider, modelId);
    if (!target) return;

    defaultRef = { provider, model: modelId };
    const ok = await pi.setModel(target);
    if (ok) ctx.ui.setStatus("default-model", ctx.ui.theme.fg("muted", `🔹 ${provider}/${modelId}`));
  });

  // ---- /set-default ----
  pi.registerCommand("set-default", {
    description: "设置默认模型: /set-default <provider> <model>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) { ctx.ui.notify("用法: /set-default <provider> <model>", "error"); return; }
      const provider = parts[0];
      const modelId = parts.slice(1).join(" ");
      const target = ctx.modelRegistry.find(provider, modelId);
      if (!target) { ctx.ui.notify(`模型不存在: ${provider}/${modelId}`, "error"); return; }
      writeSettings(settingsPath(), provider, modelId);
      defaultRef = { provider, model: modelId };
      const ok = await pi.setModel(target);
      ctx.ui.notify(ok ? `✅ 默认: ${provider}/${modelId}` : `⚠️ 已记录但切换失败`, ok ? "info" : "warning");
      ctx.ui.setStatus("default-model", ctx.ui.theme.fg("accent", `🔹 ${provider}/${modelId}`));
    },
  });

  // ---- /reset-default ----
  pi.registerCommand("reset-default", {
    description: "清除默认模型设置",
    handler: async (_a, ctx) => {
      writeSettings(settingsPath(), null, null);
      defaultRef = null;
      ctx.ui.setStatus("default-model", undefined);
      ctx.ui.notify("✅ 默认模型已清除", "info");
    },
  });

  // ---- /model-info ----
  pi.registerCommand("model-info", {
    description: "查看当前模型和默认模型",
    handler: async (_a, ctx) => {
      const cur = ctx.model;
      const def = defaultRef;
      const match = def && cur?.provider === def.provider && cur?.id === def.model;
      ctx.ui.notify(
        `当前: ${cur?.provider}/${cur?.id}` +
        (def ? ` | 默认: ${def.provider}/${def.model}` + (match ? " ✅" : "") : " | 默认: 无"),
        "info",
      );
    },
  });

  // ---- switch_model 工具 ----
  pi.registerTool({
    name: "switch_model",
    label: "Switch Model",
    description: "切换当前模型。列出可用模型时不传参数; 切换时传 provider + model。",
    promptSnippet: "List or switch between available models",
    promptGuidelines: [
      "Use switch_model without arguments to list available models. Use switch_model with provider and model to switch.",
    ],
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.provider || !params.model) {
        const all = await ctx.modelRegistry.getAvailable();
        const cur = ctx.model;
        const lines = all.map((m) => {
          const id = `${m.provider}/${m.id}`;
          const isCur = cur?.provider === m.provider && cur?.id === m.id;
          const isDef = defaultRef?.provider === m.provider && defaultRef?.model === m.id;
          const tags = [];
          if (isCur) tags.push("current");
          if (isDef) tags.push("default");
          if (m.reasoning) tags.push("thinking");
          return `  - ${id}${tags.length ? " [" + tags.join(" ") + "]" : ""}`;
        });
        return {
          content: [{ type: "text", text: `Available:\n${lines.join("\n")}\n\nCurrent: ${cur?.provider}/${cur?.id}` }],
          details: {},
        };
      }

      const target = ctx.modelRegistry.find(params.provider, params.model);
      if (!target) {
        return { content: [{ type: "text", text: `Model not found: ${params.provider}/${params.model}` }], details: {} };
      }

      const ok = await pi.setModel(target);
      return {
        content: [{ type: "text", text: ok ? `Switched to ${params.provider}/${params.model}` : `Failed: ${params.provider}/${params.model}` }],
        details: {},
      };
    },
  });
}
