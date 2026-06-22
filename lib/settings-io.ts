/**
 * settings-io.ts — 全局 settings.json 统一读写单例
 *
 * 解决 model-switch / provider-manager / parallel-agent 三路独立读写
 * settings.json 导致的配置覆盖丢失问题。
 *
 * 核心设计：
 *   1. globalThis.__pi_settings_cache 内存缓存，仅启动时读一次磁盘
 *   2. updateSettings(fn) 原子更新：读缓存 → 修改 → 写回磁盘（同步，无竞态）
 *   3. 写后立即更新缓存，后续读取立即可见
 *   4. 兼容现有所有 callers 的 API 签名
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- 单例缓存键 ----

const CACHE_KEY = "__pi_settings_cache";
const FILE_KEY = "__pi_settings_path";

function settingsPath(): string {
  // 缓存路径减少重复计算
  let p = (globalThis as Record<string, unknown>)[FILE_KEY] as string | undefined;
  if (!p) {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    p = join(home, ".pi", "agent", "settings.json");
    (globalThis as Record<string, unknown>)[FILE_KEY] = p;
  }
  return p;
}

interface CacheEntry {
  data: Record<string, unknown>;
  mtime: number; // 最后同步时间，供未来冲突检测用
}

/** 原子加载缓存 */
function ensureCache(): CacheEntry {
  let entry = (globalThis as Record<string, unknown>)[CACHE_KEY] as CacheEntry | undefined;
  if (!entry) {
    const raw = tryReadDisk();
    entry = { data: raw, mtime: Date.now() };
    (globalThis as Record<string, unknown>)[CACHE_KEY] = entry;
  }
  return entry;
}

function tryReadDisk(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

/** 强制重新从磁盘加载（用于 session_start 等场景检测外部变更） */
export function reloadSettingsFromDisk(): Record<string, unknown> {
  const raw = tryReadDisk();
  const entry = ensureCache();
  entry.data = raw;
  entry.mtime = Date.now();
  return raw;
}

// ---- 公开 API ----

/**
 * 获取完整的 settings 对象（深拷贝副本，防止调用方意外修改缓存）
 */
export function getSettings(): Record<string, unknown> {
  return structuredClone(ensureCache().data);
}

/**
 * 原子更新 settings：传入一个 updater 函数，接收当前 settings 的深拷贝，
 * 返回修改后的 settings。自动写回磁盘并同步缓存。
 *
 * 示例:
 *   updateSettings((s) => {
 *     s.modelTiers = { L0: ... };
 *     return s;
 *   });
 */
export function updateSettings(updater: (settings: Record<string, unknown>) => Record<string, unknown>): void {
  const entry = ensureCache();
  const clone = structuredClone(entry.data);
  const next = updater(clone);
  // 持久化到磁盘
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n", "utf-8");
  // 更新缓存
  entry.data = next;
  entry.mtime = Date.now();
}

/**
 * 读取 settings 中某个子节，不存在时返回默认值
 */
export function getSettingsSection<T>(key: string, defaultValue: T): T {
  const data = ensureCache().data;
  return (data[key] as T) ?? defaultValue;
}

/**
 * 更新 settings 中某个子节，不影响其他字段
 */
export function setSettingsSection(key: string, value: unknown): void {
  updateSettings((s) => {
    s[key] = value;
    return s;
  });
}

/**
 * 删除 settings 中某个子节
 */
export function deleteSettingsSection(key: string): void {
  updateSettings((s) => {
    delete s[key];
    return s;
  });
}

// ================================================================
// 兼容性适配层：为现有模块提供与之前一致的函数签名
// 但所有操作都通过缓存单例执行，不再各自独立读写
// ================================================================

/** @deprecated 使用 getSettings() / updateSettings() 代替 */
export function readSettings(): Record<string, unknown> {
  return getSettings();
}

/** @deprecated 使用 updateSettings() 代替 */
export function writeSettingsRaw(data: Record<string, unknown>): void {
  updateSettings(() => data);
}

/** 包路径（兼容旧代码 import） */
export function settingsPathCompat(): string {
  return settingsPath();
}
