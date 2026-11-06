/**
 * isolated-settings-env.ts — 测试环境隔离
 *
 * settings-io 在首次调用时把路径缓存到 globalThis；测试里通过 updateSettings
 * 持久化的用例会直接改写真实的 ~/.pi/agent/settings.json。
 * 这里在首次调用前把 settings 重定向到临时目录，使测试永不触碰用户配置。
 *
 * 必须作为第一个 import 引入（ESM 按顺序求值依赖）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-model-switch-test-"));
}

export {};
