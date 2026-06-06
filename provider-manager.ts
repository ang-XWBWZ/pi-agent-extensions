/**
 * provider-manager.ts — 自定义供应商管理
 *
 * 独立负责自定义供应商的注册、持久化、启动恢复。
 * Openai 兼容流全部复用 pi-main 内置 provider，只通过 tolerant wrapper
 * 处理供应商缺少 finish_reason 的兼容问题。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { restoreCustomProviders } from "./provider-manager/lib/register.js";
import { registerManageProviders } from "./provider-manager/tools/manage-providers.js";

export default function (pi: ExtensionAPI) {
  restoreCustomProviders(pi);

  pi.on("session_start", async () => {
    restoreCustomProviders(pi);
  });

  registerManageProviders(pi);
}
