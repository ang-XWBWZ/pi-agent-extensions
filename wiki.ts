/**
 * wiki.ts — Pi Wiki v3.0
 *
 * 程序负责流程（扫描/索引/搜索），AI 负责内容（读源文件/回答）
 * /wiki-search /wiki-load /wiki-status → 不触发 AI
 * /wiki-ask → 触发 AI 总结
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cmdLoad, cmdUnload, cmdStatus } from "./wiki/commands/repo-cmds.js";
import { cmdSearch, cmdAsk, cmdClose } from "./wiki/commands/query-cmds.js";
import { registerKbSearchTool } from "./wiki/tools/kb-search.js";
import { registerManagementTools } from "./wiki/tools/management.js";

export default function (pi: ExtensionAPI) {
  // AI 管理工具（8 个）
  registerManagementTools(pi);

  // kb_search 只读工具
  registerKbSearchTool(pi);

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

  pi.registerCommand("wiki-search", {
    description: "搜索 wiki 索引（TUI 面板显示结果，不触发 AI）",
    handler: (args, ctx) => {
      const msg = cmdSearch(args, pi, ctx);
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("wiki-ask", {
    description: "搜索并返回匹配源文件的完整内容（前 3 篇），触发 AI 总结",
    handler: (args, ctx) => pi.sendUserMessage(cmdAsk(args)),
  });

  pi.registerCommand("wiki-close", {
    description: "关闭 Wiki 搜索结果面板",
    handler: (args, ctx) => ctx.ui.notify(cmdClose(args, pi, ctx), "info"),
  });

  pi.registerCommand("wiki-status", {
    description: "查看 wiki 状态（不触发 AI）",
    handler: (args, ctx) => ctx.ui.notify(cmdStatus(), "info"),
  });
}
