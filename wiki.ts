/**
 * wiki.ts — Pi Wiki v4.2
 *
 * 程序负责流程（扫描/索引/搜索），AI 负责内容（读源文件/回答）
 *
 * 用户命令（不触发 AI）:
 *   /wiki-search[-keyword|-semantic|-hybrid]   TUI 面板搜索
 *   /wiki-load /wiki-unload /wiki-status       数据源管理
 *   /wiki-close                                 关闭面板
 *
 * AI 命令（触发 AI）:
 *   /wiki-ask                                   让 AI 基于 wiki 回答
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmdLoad, cmdUnload, cmdStatus } from "./wiki/commands/repo-cmds.js";
import {
  cmdSearch, cmdSearchKeyword, cmdSearchSemantic, cmdSearchHybrid,
  cmdAsk, cmdClose,
} from "./wiki/commands/query-cmds.js";
import { registerKbSearchTool } from "./wiki/tools/kb-search.js";
import { registerManagementTools } from "./wiki/tools/management.js";

export default function (pi: ExtensionAPI) {
  // AI 管理工具（11 个，含语义）
  registerManagementTools(pi);

  // kb_search 只读工具
  registerKbSearchTool(pi);

  // ---- 数据源 ----

  pi.registerCommand("wiki-load", {
    description: "加载数据源目录，自动递归扫描 .md 文件并建立搜索索引",
    handler: (args, ctx) => {
      const msg = cmdLoad(args, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-unload", {
    description: "卸载数据源（无参数时列出已加载的数据源）",
    handler: (args, ctx) => pi.sendUserMessage(cmdUnload(args, ctx)),
  });

  pi.registerCommand("wiki-status", {
    description: "查看 wiki 状态（数据源、索引、语义搜索）",
    handler: (args, ctx) => ctx.ui.notify(cmdStatus(), "info"),
  });

  // ---- 搜索（默认混合模式） ----

  pi.registerCommand("wiki-search", {
    description: "搜索 wiki（默认混合模式，语义未启用时回退关键词）",
    handler: (args, ctx) => {
      const msg = cmdSearch(args, pi, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-search-keyword", {
    description: "搜索 wiki — 纯关键词匹配",
    handler: (args, ctx) => {
      const msg = cmdSearchKeyword(args, pi, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-search-semantic", {
    description: "搜索 wiki — 纯语义理解（需先启用语义搜索）",
    handler: (args, ctx) => {
      const msg = cmdSearchSemantic(args, pi, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-search-hybrid", {
    description: "搜索 wiki — 关键词 + 语义混合排序",
    handler: (args, ctx) => {
      const msg = cmdSearchHybrid(args, pi, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-close", {
    description: "关闭 Wiki 搜索结果面板",
    handler: (args, ctx) => ctx.ui.notify(cmdClose(args, pi, ctx), "info"),
  });

  // ---- AI 问答 ----

  pi.registerCommand("wiki-ask", {
    description: "基于 wiki 知识库中的匹配文档，让 AI 回答你的问题",
    handler: (args, ctx) => pi.sendUserMessage(cmdAsk(args)),
  });
}
