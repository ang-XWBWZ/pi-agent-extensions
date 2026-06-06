/**
 * manage-tools.ts — manage_tools 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { settingsPath } from "../lib/tier-resolver.js";

export function registerManageTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "manage_tools",
    label: "Manage Tools",
    description:
      "管理 tool 黑名单。黑名单中的 tool 不会注册到子进程会话，" +
      "子进程完全不知道该 tool 的存在（无注册指令、无说明内容）。" +
      "修改立即生效，无需 /reload。\n\n",
    promptSnippet: "Manage tool blacklist for sub-agents (add/remove/list/set)",
    promptGuidelines: [
      "Use manage_tools to control which tools are banned from sub-agent sessions.",
      "Blacklisted tools are completely hidden from sub-agents:",
      "  1) Not registered in sub-agent session → cannot be called",
      "  2) No description/promptGuidelines injected → agent doesn't know it exists",
      "Changes take effect immediately, no /reload needed.",
      "Use 'list' to see current config blacklist. Use 'add'/'remove' for incremental changes.",
      "Recommended defaults: switch_model, manage_plan, manage_skills, manage_tools",
      "These are management tools that sub-agents should not have access to.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "操作: blacklist_add | blacklist_remove | blacklist_list | blacklist_set",
      }),
      tools: Type.Optional(Type.Array(Type.String(), {
        description: "tool 名称列表（blacklist_add/remove/set 时必填）",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");

      const { action, tools } = params;

      const settingsPath_ = settingsPath();
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(readFileSync(settingsPath_, "utf-8"));
      } catch { /* 空对象兜底 */ }

      const section = (raw.tools || {}) as Record<string, unknown>;
      const currentList: string[] = Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [];

      switch (action) {
        case "blacklist_list": {
          if (currentList.length === 0) {
            ctx.ui.notify("📋 tool 黑名单为空（安全网仍生效）", "info");
            return {
              content: [{ type: "text", text: "📋 当前 tool blacklist 为空。\n安全网（始终阻塞）: spawn_agent, check_agent_results, control_agent" }],
              details: { action, blacklist: [], safetyNet: ["spawn_agent", "check_agent_results", "control_agent"] },
            };
          }
          const lines = currentList.map((s) => `  🔴 ${s}`);
          ctx.ui.notify(`📋 tool 黑名单共 ${currentList.length} 条`, "info");
          return {
            content: [{ type: "text", text: `📋 当前 tool blacklist (${currentList.length}):\n${lines.join("\n")}\n\n安全网（始终阻塞）: spawn_agent, check_agent_results, control_agent` }],
            details: { action, blacklist: currentList, safetyNet: ["spawn_agent", "check_agent_results", "control_agent"] },
          };
        }

        case "blacklist_add": {
          if (!tools || tools.length === 0) {
            return { content: [{ type: "text", text: "blacklist_add 需要 tools 参数" }], details: { error: "missing_tools" } };
          }
          const toAdd = tools.filter((s) => typeof s === "string" && !currentList.includes(s));
          if (toAdd.length === 0) {
            ctx.ui.notify("⚠️ 所有 tool 已在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 tool 已在黑名单中，无需重复添加。" }],
              details: { action, added: [], blacklist: currentList },
            };
          }
          const newList = [...currentList, ...toAdd];
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🔴 已添加 ${toAdd.length} 个 tool 到黑名单`, "warn");
          return {
            content: [{ type: "text", text: `🔴 已添加 ${toAdd.length} 个 tool 到黑名单:\n${toAdd.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.map((s) => `  🔴 ${s}`).join("\n")}` }],
            details: { action, added: toAdd, blacklist: newList },
          };
        }

        case "blacklist_remove": {
          if (!tools || tools.length === 0) {
            return { content: [{ type: "text", text: "blacklist_remove 需要 tools 参数" }], details: { error: "missing_tools" } };
          }
          const toRemove = tools.filter((s) => currentList.includes(s));
          if (toRemove.length === 0) {
            ctx.ui.notify("⚠️ 指定 tool 不在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 tool 不在黑名单中，无需移除。" }],
              details: { action, removed: [], blacklist: currentList },
            };
          }
          const newList = currentList.filter((s) => !toRemove.includes(s));
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🟢 已从黑名单移除 ${toRemove.length} 个 tool`, "info");
          return {
            content: [{ type: "text", text: `🟢 已从黑名单移除 ${toRemove.length} 个 tool:\n${toRemove.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.length > 0 ? newList.map((s) => `  🔴 ${s}`).join("\n") : "  (空)"}` }],
            details: { action, removed: toRemove, blacklist: newList },
          };
        }

        case "blacklist_set": {
          if (!tools) {
            return { content: [{ type: "text", text: "blacklist_set 需要 tools 参数（传空数组 = 清空）" }], details: { error: "missing_tools" } };
          }
          const newList = tools.filter((s) => typeof s === "string");
          raw.tools = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(newList.length > 0 ? `🔴 已覆盖 tool 黑名单: ${newList.length} 条` : "🟢 已清空 tool 黑名单", newList.length > 0 ? "warn" : "info");
          return {
            content: [{ type: "text", text: newList.length > 0
              ? `🔴 已覆盖 tool 黑名单 (${newList.length}):\n${newList.map((s) => `  • ${s}`).join("\n")}`
              : "🟢 tool 黑名单已清空（安全网仍生效）。" }],
            details: { action, blacklist: newList },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `未知操作: ${action}\n支持: blacklist_add | blacklist_remove | blacklist_list | blacklist_set` }],
            details: { error: "unknown_action" },
          };
      }
    },
  });
}
