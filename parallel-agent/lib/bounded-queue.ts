/**
 * bounded-queue.ts — 有界并发调度（CP5 / G01、G02）
 *
 * 纯调度器：最多同时运行 limit 个 worker；排队项可以在启动前被 shouldSkip
 * 命中而直接跳过（用于取消排队任务，不创建 SDK 会话）。
 */

export interface BoundedQueueOptions<T> {
  /** 最大并发数；小于 1 时按 1 处理。 */
  limit: number;
  /** 返回 true 表示该项在启动前被跳过。 */
  shouldSkip?: (item: T) => boolean;
  /** 跳过项的回调，用于发布取消结果。 */
  onSkip?: (item: T) => void;
  worker: (item: T) => Promise<void> | void;
}

/**
 * 以受限并发依次处理 items，全部完成后 resolve。worker 抛错不会中断队列。
 */
export async function runBounded<T>(
  items: readonly T[],
  options: BoundedQueueOptions<T>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(options.limit));
  const { worker, shouldSkip, onSkip } = options;
  let index = 0;
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (index >= items.length && active === 0) {
        resolve();
        return;
      }
      while (active < limit && index < items.length) {
        const item = items[index++];
        if (shouldSkip?.(item)) {
          onSkip?.(item);
          continue;
        }
        active++;
        void Promise.resolve()
          .then(() => worker(item))
          .catch(() => undefined)
          .finally(() => {
            active--;
            pump();
          });
      }
    };
    pump();
  });
}
