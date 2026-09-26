/**
 * stream-compat.ts — 双轨流兼容独立扩展
 *
 * 专职负责模型与流式运行时的兼容性配置、能力协商（Compat Flags）与双轨流调度：
 * - 主轨 (Track 1 / builtin): Pi 原生高性能标准流，配合声明式 compat flags
 * - 副轨 (Track 2 / tolerant): 直连容错流，解决第三方中转站丢终止标记、丢帧、字段变异等问题
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompatCommands } from "./stream-compat/commands/compat-cmds.js";
export { resolveStreamStrategy } from "./stream-compat/lib/strategy-resolver.js";
export { createOpenAITolerantStream } from "./stream-compat/lib/tolerant-stream.js";
export { createAnthropicStream } from "./stream-compat/lib/anthropic-stream.js";
export type * from "./stream-compat/types.js";

/**
 * 针对第三方工具或渠道添加的模型进行运行时终态保护：
 * 如果模型属于 OpenAI Completions 接口且并非官方 api.openai.com，
 * 只要未显式声明 supportsFinishReason，一律自适应注入 false 保护。
 *
 * 收益：
 * 1. 彻底修复第三方中转或外部工具添加模型时缺失 finish_reason 导致 "Stream ended without finish_reason" 崩溃的 bug。
 * 2. 当上游正常返回 finish_reason 时，hasFinishReason 为 true，原生逻辑不受任何影响。
 * 3. 官方 OpenAI (api.openai.com) 保持严格校验，不受任何影响。
 */
export function patchModelFinishReasonCompat(model: any): boolean {
  if (!model || typeof model !== "object") return false;
  const api = model.api;
  if (api && api !== "openai-completions" && api !== "openai-responses") return false;

  const baseUrl: string | undefined = model.baseUrl;
  const isOfficialOpenAI = !baseUrl || baseUrl.includes("api.openai.com");
  if (!isOfficialOpenAI) {
    if (!model.compat) {
      model.compat = { supportsFinishReason: false };
      return true;
    } else if (model.compat.supportsFinishReason === undefined) {
      if (Object.isFrozen(model.compat)) {
        model.compat = { ...model.compat, supportsFinishReason: false };
      } else {
        model.compat.supportsFinishReason = false;
      }
      return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  registerCompatCommands(pi);

  // 1. 模型被选中时（无论通过 /model、switch_model、还是其它第三方工具修改）
  pi.on("model_select", (event) => {
    if (event.model) patchModelFinishReasonCompat(event.model);
  });

  // 2. 会话启动与恢复时（加载默认或持久化模型）
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model) patchModelFinishReasonCompat(ctx.model);
    for (const sm of (ctx.scopedModels || []) as any[]) {
      if (sm?.model) patchModelFinishReasonCompat(sm.model);
    }
  });

  // 3. 用户发起回合执行前（防御第三方工具在回合前动态注入新模型）
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model) patchModelFinishReasonCompat(ctx.model);
  });

  // 4. 每个交互 turn 开始时
  pi.on("turn_start", (_event, ctx) => {
    if (ctx.model) patchModelFinishReasonCompat(ctx.model);
  });
}
