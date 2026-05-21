/**
 * wiki.ts — Pi Wiki v5.0
 *
 * 程序负责流程（扫描/索引/搜索），AI 负责内容（读源文件/回答）
 * 模型通过 model-registry 中间层解耦，支持 bge-base-zh-v1.5 / paraphrase-multilingual
 *
 * 用户命令（不触发 AI）:
 *   /wiki-search[-keyword|-semantic|-hybrid]   TUI 面板搜索
 *   /wiki-load /wiki-unload /wiki-status       数据源管理
 *   /wiki-models                               查看可用模型
 *   /wiki-close                                 关闭面板
 *
 * AI 命令（触发 AI）:
 *   /wiki-ask                                   让 AI 基于 wiki 回答
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmdLoad, cmdUnload, cmdStatus } from "./wiki/commands/repo-cmds.js";
import {
  cmdSearch, cmdSearchKeyword, cmdSearchSemantic,
  cmdAsk, cmdClose,
} from "./wiki/commands/query-cmds.js";
import { registerKbSearchTool } from "./wiki/tools/kb-search.js";
import { registerManagementTools } from "./wiki/tools/management.js";

export default function (pi: ExtensionAPI) {
  // AI 管理工具
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

  // ---- 搜索（默认混合模式，-k 关键词，-s 语义） ----

  pi.registerCommand("wiki-search", {
    description: "搜索 wiki。默认混合模式；加 -k 关键词 / -s 语义。",
    handler: (args, ctx) => {
      // 解析 -k / -s 标志
      const parts = args.trim().split(/\s+/);
      let mode: "keyword" | "semantic" | "hybrid" | undefined;
      let query = "";
      for (const p of parts) {
        if (p === "-k") { mode = "keyword"; continue; }
        if (p === "-s") { mode = "semantic"; continue; }
        query += (query ? " " : "") + p;
      }
      if (mode === "keyword") {
        ctx.ui.notify(cmdSearchKeyword(query, pi, ctx), "info");
      } else if (mode === "semantic") {
        ctx.ui.notify(cmdSearchSemantic(query, pi, ctx), "info");
      } else {
        ctx.ui.notify(cmdSearch(query, pi, ctx), "info");
      }
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
