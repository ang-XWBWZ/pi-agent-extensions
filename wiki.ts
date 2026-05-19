/**
 * wiki.ts — Pi Wiki v3.0
 *
 * 程序负责流程（扫描/索引/搜索），AI 负责内容（读源文件/回答）
 * 5 个独立命令 + kb_search 工具
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmdLoad, cmdUnload, cmdStatus } from "./wiki/commands/repo-cmds.js";
import { cmdSearch, cmdAsk } from "./wiki/commands/query-cmds.js";
import { registerKbSearchTool } from "./wiki/tools/kb-search.js";

export default function (pi: ExtensionAPI) {
  registerKbSearchTool(pi);

  pi.registerCommand("wiki-load", {
    description: "加载数据源目录，自动递归扫描 .md 文件并建立搜索索引",
    handler: (args, ctx) => pi.sendUserMessage(cmdLoad(args, ctx)),
  });

  pi.registerCommand("wiki-unload", {
    description: "卸载数据源（无参数时列出已加载的数据源）",
    handler: (args, ctx) => pi.sendUserMessage(cmdUnload(args, ctx)),
  });

  pi.registerCommand("wiki-search", {
    description: "搜索 wiki 索引：匹配标题、路径、标签和全文内容",
    handler: (args, ctx) => pi.sendUserMessage(cmdSearch(args)),
  });

  pi.registerCommand("wiki-ask", {
    description: "搜索并返回匹配源文件的完整内容（前 3 篇）",
    handler: (args, ctx) => pi.sendUserMessage(cmdAsk(args)),
  });

  pi.registerCommand("wiki-status", {
    description: "查看 wiki 状态：数据源数量、已索引文件数、最后扫描时间",
    handler: (args, ctx) => pi.sendUserMessage(cmdStatus()),
  });
}
