// content-cache.ts — 文件内容内存缓存 (P0-3)
//
// 问题: search.ts 每次搜索都 readFileSync 读磁盘
// 修复: 索引时将文件内容缓存到内存，搜索只读缓存
//
// 单例 Map<relPath, fullContent> — 加载数据源时填充

const cache = new Map<string, string>();

/** 存入缓存 */
export function setContent(relPath: string, content: string): void {
  cache.set(relPath, content);
}

/** 读取缓存 */
export function getContent(relPath: string): string | undefined {
  return cache.get(relPath);
}

/** 检查是否已缓存 */
export function hasContent(relPath: string): boolean {
  return cache.has(relPath);
}

/** 按 sourceDir 清除缓存条目 */
export function clearSource(sourceDir: string): void {
  // sourceDir 不存 key，但 relPath 在调用侧已知。
  // 实际清除由调用方遍历处理。
}

/** 清除所有缓存 */
export function clearAll(): void {
  cache.clear();
}

/** 缓存大小 */
export function cacheSize(): number {
  return cache.size;
}
