/**
 * wiki.ts — Pi Wiki 插件 v2.3
 *
 * 单一 wiki 仓库 (wiki/repo/) + 多数据源 (sources[])
 * 13 个命令 + kb_search 工具
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cmdLoad, cmdUnload, cmdSources, cmdStatus } from "./wiki/commands/repo-cmds.js";
import { cmdAdd, cmdDelete } from "./wiki/commands/entry-cmds.js";
import { cmdSearch, cmdAsk, cmdIndex } from "./wiki/commands/query-cmds.js";
import { cmdRecycle, cmdRules, cmdModel } from "./wiki/commands/misc-cmds.js";
import { cmdGenerate } from "./wiki/commands/generate-cmds.js";
import { registerKbSearchTool } from "./wiki/tools/kb-search.js";

export default function (pi: ExtensionAPI) {

  registerKbSearchTool(pi);

  pi.registerCommand("wiki", {
    description: "Wiki: load|unload|sources|add|delete|generate|recycle|index|search|ask|rules|status|model",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "load")     return pi.sendUserMessage(cmdLoad(parts, ctx, pi));
      if (sub === "unload")   return pi.sendUserMessage(cmdUnload(parts, ctx, pi));
      if (sub === "sources")  return pi.sendUserMessage(cmdSources(parts, ctx, pi));
      if (sub === "add")      return pi.sendUserMessage(await cmdAdd(parts, ctx, pi));
      if (sub === "delete")   return pi.sendUserMessage(await cmdDelete(parts, ctx, pi));
      if (sub === "generate") return pi.sendUserMessage(await cmdGenerate(parts, ctx, pi));
      if (sub === "search")   return pi.sendUserMessage(await cmdSearch(parts, ctx, pi));
      if (sub === "ask")      return pi.sendUserMessage(await cmdAsk(parts, ctx, pi));
      if (sub === "index")    return pi.sendUserMessage(await cmdIndex(parts, ctx, pi));
      if (sub === "recycle")  return pi.sendUserMessage(await cmdRecycle(parts, ctx, pi));
      if (sub === "rules")    return pi.sendUserMessage(await cmdRules(parts, ctx, pi));
      if (sub === "model")    return pi.sendUserMessage(cmdModel(parts, ctx, pi));
      if (sub === "status")   return pi.sendUserMessage(await cmdStatus(parts, ctx, pi));

      pi.sendUserMessage(
        "**Wiki 命令**\n\n" +
        "`load <dir>`              加载数据源\n" +
        "`unload <N|path>`        卸载数据源\n" +
        "`sources`                 列出数据源\n" +
        "`add <file> <title> [--parent <cat>]`  创建条目\n" +
        "`delete <id>`             条目→回收站\n" +
        "`generate <id>`           条目填充指引\n" +
        "`recycle [--list|--restore <id>|--clean]`  回收站\n" +
        "`index`                   索引导航\n" +
        "`search <kw>`             内容搜索\n" +
        "`ask <q>`                 增强搜索+全文\n" +
        "`rules`                   写作规范\n" +
        "`status`                  仓库统计\n" +
        "`model [p/m]`             查看/切换 wiki 模型"
      );
    },
  });
}
