/**
 * stream-compat/commands/compat-cmds.ts — /compat 诊断与切换命令 (支持 Auto 默认自适应)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveStreamStrategy, normalizeStreamTrack } from "../lib/strategy-resolver.js";
import { probeProviderStream } from "../lib/stream-probe.js";
import { updateSettings, getSettings } from "../../lib/settings-io.js";
import type { StreamTrack } from "../types.js";

export function registerCompatCommands(pi: ExtensionAPI): void {
  pi.registerCommand("compat", {
    description: "查看或配置模型的流兼容双轨策略 (/compat status|switch|probe)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";
      const currentModel = ctx.model;

      if (!currentModel) {
        ctx.ui.notify("当前未选择任何活动模型", "warning");
        return;
      }

      const settings = getSettings();
      const customProviders = (settings.customProviders as Record<string, any>) || {};
      const providerConfig = customProviders[currentModel.provider];

      if (sub === "status") {
        const strategy = resolveStreamStrategy(
          currentModel.provider,
          providerConfig?.baseUrl || currentModel.baseUrl,
          currentModel.id,
          providerConfig?.streamCompatMode,
        );

        const configLabel = strategy.configuredTrack === "auto"
          ? "\x1b[36m[自动自适应模式 (Auto)]\x1b[0m"
          : `\x1b[35m[手动锁定: ${strategy.configuredTrack}]\x1b[0m`;

        const physicalTrackLabel = strategy.track === "builtin"
          ? "\x1b[32mBuiltin (主轨原生流)\x1b[0m"
          : "\x1b[33mTolerant (副轨容错流)\x1b[0m";

        const termProtectionLabel = !strategy.flags.supportsFinishReason
          ? "\x1b[32m已启用 (中转不返回终止符号时自适应平稳终结，防止崩溃)\x1b[0m"
          : "标准校验 (严格等待终止符号)";

        const text = [
          `📊 **流兼容双轨运行状态 (Stream Compat Status)**`,
          `- 活动模型: \`${currentModel.provider}/${currentModel.id}\``,
          `- 轨道模式: ${configLabel} -> **实际解析为**: ${physicalTrackLabel}`,
          `- 命中规则: \`${strategy.matchedRule}\``,
          `- 终止符号防崩保护: ${termProtectionLabel}`,
          `- 关键配置标志 (Flags):`,
          `  • supportsFinishReason: \`${strategy.flags.supportsFinishReason}\``,
          `  • supportsUsageInStreaming: \`${strategy.flags.supportsUsageInStreaming}\``,
          `  • supportsDeveloperRole: \`${strategy.flags.supportsDeveloperRole}\``,
          `  • requiresReasoningContent: \`${strategy.flags.requiresReasoningContent}\``,
          ``,
          `*提示: 使用 \`/compat switch auto\`（推荐）、\`builtin\` 或 \`tolerant\` 切换。*`,
        ].join("\n");

        ctx.ui.notify(text, "info");
        return;
      }

      if (sub === "switch") {
        const rawTarget = parts[1]?.toLowerCase();
        if (rawTarget !== "auto" && rawTarget !== "builtin" && rawTarget !== "tolerant") {
          ctx.ui.notify("用法: /compat switch <auto | builtin | tolerant>", "warning");
          return;
        }

        const targetTrack: StreamTrack = rawTarget as StreamTrack;

        if (!providerConfig) {
          ctx.ui.notify(`供应商 ${currentModel.provider} 为系统内置，不可切换配置`, "warning");
          return;
        }

        updateSettings((s) => {
          const cp = (s.customProviders as Record<string, any>) || {};
          if (cp[currentModel.provider]) {
            if (targetTrack === "auto") {
              delete cp[currentModel.provider].streamCompatMode; // 删掉显式配置，恢复默认 auto
            } else if (targetTrack === "tolerant") {
              cp[currentModel.provider].streamCompatMode = "finish-reason-fallback";
            } else {
              cp[currentModel.provider].streamCompatMode = "builtin";
            }
          }
          return s;
        });

        const label = targetTrack === "auto" ? "auto (自动自适应)" : targetTrack;
        ctx.ui.notify(
          `✅ 已将供应商 \`${currentModel.provider}\` 的流式轨道设定为: **${label}** (已持久化保存)`,
          "info",
        );
        return;
      }

      if (sub === "probe") {
        if (!providerConfig?.baseUrl || !providerConfig?.apiKey) {
          ctx.ui.notify("仅支持对配置了 baseUrl 和 apiKey 的自定义供应商执行探测", "warning");
          return;
        }

        ctx.ui.notify(`正在向 ${currentModel.provider} 发起流式协议探测...`, "info");
        const result = await probeProviderStream(
          providerConfig.baseUrl,
          providerConfig.apiKey,
          currentModel.id,
        );

        const statusIcon = result.ok ? "✅" : "❌";
        const text = [
          `🔍 **探测结果: ${currentModel.provider}**`,
          `- 状态: ${statusIcon} ${result.diagnosis}`,
          `- 支持 stream_options: \`${result.supportsStreamOptions}\``,
          `- 具备 tool_calls: \`${result.returnedToolCalls}\``,
          `- 具备 finish_reason 终止符: \`${result.returnedFinishReason}\``,
          `- **建议轨道**: \`${result.recommendedTrack}\``,
        ].join("\n");

        ctx.ui.notify(text, result.ok ? "info" : "warning");
        return;
      }

      ctx.ui.notify(`未知子命令: ${sub}。支持: /compat status, /compat switch, /compat probe`, "warning");
    },
  });
}
