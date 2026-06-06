/**
 * manage-skills.ts — manage_skills 工具注册
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { settingsPath } from "../lib/tier-resolver.js";

export function registerManageSkills(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "manage_skills",
    label: "Manage Skills",
    description:
      "管理 skill 黑名单。黑名单中的 skill 完全不会注入子进程。" +
      "支持添加/移除/列出/覆盖黑名单。修改立即生效，无需 /reload。",
    promptSnippet: "Manage skill blacklist (add/remove/list/set)",
    promptGuidelines: [
      "Use manage_skills to control which skills are banned from sub-agent injection.",
      "Blacklisted skills are completely hidden — no content injected, not even description.",
      "Changes take effect immediately, no /reload needed.",
      "Use 'list' to see current blacklist. Use 'add'/'remove' for incremental changes.",
      "Use 'set' to replace the entire blacklist at once.",
      "Prefer 'add'/'remove' for individual changes. Use 'set' only when redefining from a known baseline.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "操作: blacklist_add | blacklist_remove | blacklist_list | blacklist_set",
      }),
      skills: Type.Optional(Type.Array(Type.String(), {
        description: "skill 名称列表（blacklist_add/remove/set 时必填）",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("操作已取消");

      const { action, skills } = params;

      const settingsPath_ = settingsPath();
      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(readFileSync(settingsPath_, "utf-8"));
      } catch { /* 空对象兜底 */ }

      const section = (raw.skills || {}) as Record<string, unknown>;
      const currentList: string[] = Array.isArray(section.blacklist)
        ? (section.blacklist as string[]).filter((s): s is string => typeof s === "string")
        : [];

      switch (action) {
        case "blacklist_list": {
          if (currentList.length === 0) {
            ctx.ui.notify("📋 黑名单为空，所有 skill 可正常注入", "info");
            return {
              content: [{ type: "text", text: "📋 当前 blacklist 为空。" }],
              details: { action, blacklist: [] },
            };
          }
          const lines = currentList.map((s) => `  🔴 ${s}`);
          ctx.ui.notify(`📋 黑名单共 ${currentList.length} 条`, "info");
          return {
            content: [{ type: "text", text: `📋 当前 blacklist (${currentList.length}):\n${lines.join("\n")}` }],
            details: { action, blacklist: currentList },
          };
        }

        case "blacklist_add": {
          if (!skills || skills.length === 0) {
            return { content: [{ type: "text", text: "blacklist_add 需要 skills 参数" }], details: { error: "missing_skills" } };
          }
          const toAdd = skills.filter((s) => typeof s === "string" && !currentList.includes(s));
          if (toAdd.length === 0) {
            ctx.ui.notify("⚠️ 所有 skill 已在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 skill 已在黑名单中，无需重复添加。" }],
              details: { action, added: [], blacklist: currentList },
            };
          }
          const newList = [...currentList, ...toAdd];
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🔴 已添加 ${toAdd.length} 个 skill 到黑名单`, "warn");
          return {
            content: [{
              type: "text",
              text: `🔴 已添加 ${toAdd.length} 个 skill 到黑名单:\n${toAdd.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.map((s) => `  🔴 ${s}`).join("\n")}`,
            }],
            details: { action, added: toAdd, blacklist: newList },
          };
        }

        case "blacklist_remove": {
          if (!skills || skills.length === 0) {
            return { content: [{ type: "text", text: "blacklist_remove 需要 skills 参数" }], details: { error: "missing_skills" } };
          }
          const toRemove = skills.filter((s) => currentList.includes(s));
          if (toRemove.length === 0) {
            ctx.ui.notify("⚠️ 指定 skill 不在黑名单中", "warning");
            return {
              content: [{ type: "text", text: "⚠️ 指定 skill 不在黑名单中，无需移除。" }],
              details: { action, removed: [], blacklist: currentList },
            };
          }
          const newList = currentList.filter((s) => !toRemove.includes(s));
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`🟢 已从黑名单移除 ${toRemove.length} 个 skill`, "info");
          return {
            content: [{
              type: "text",
              text: `🟢 已从黑名单移除 ${toRemove.length} 个 skill:\n${toRemove.map((s) => `  • ${s}`).join("\n")}\n\n当前 blacklist (${newList.length}):\n${newList.length > 0 ? newList.map((s) => `  🔴 ${s}`).join("\n") : "  (空)"}`,
            }],
            details: { action, removed: toRemove, blacklist: newList },
          };
        }

        case "blacklist_set": {
          if (!skills) {
            return { content: [{ type: "text", text: "blacklist_set 需要 skills 参数（传空数组 = 清空）" }], details: { error: "missing_skills" } };
          }
          const newList = skills.filter((s) => typeof s === "string");
          raw.skills = { blacklist: newList };
          writeFileSync(settingsPath_, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          ctx.ui.notify(newList.length > 0 ? `🔴 已覆盖黑名单: ${newList.length} 条` : "🟢 已清空黑名单", newList.length > 0 ? "warn" : "info");
          return {
            content: [{
              type: "text",
              text: newList.length > 0
                ? `🔴 已覆盖黑名单 (${newList.length}):\n${newList.map((s) => `  • ${s}`).join("\n")}`
                : "🟢 黑名单已清空，所有 skill 可正常注入。",
            }],
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
