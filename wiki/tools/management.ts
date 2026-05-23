// management.ts — Wiki 管理工具注册入口 (v5.5 barrel)
//
// 聚合所有子模块。13 个工具分布在 4 个文件中，按职责分离。
// 命名: wiki_read_* (🟢只读) / wiki_edit_* (🟡改内容) / wiki_DANGER_* (🔴危险)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSourceTools } from "./management-sources.js";
import { registerEntryTools } from "./management-entries.js";
import { registerSemanticTools } from "./management-semantic.js";
import { registerCompileTools } from "./management-compile.js";

export function registerManagementTools(pi: ExtensionAPI): void {
  registerSourceTools(pi);    // wiki_load / unload / list_sources / refresh
  registerEntryTools(pi);     // wiki_create / get / rename / move
  registerSemanticTools(pi);  // wiki_semantic (status/on/off/model)
  registerCompileTools(pi);   // wiki_get_chunks_raw / compile_file / store_file_compiled
}
