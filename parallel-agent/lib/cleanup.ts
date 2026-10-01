/**
 * cleanup.ts — 有界清理（C05/C06）
 *
 * abort/dispose 等清理操作必须有时间边界：无法确认停止时返回 cleanup_timeout，
 * 而不是让任务永不结算。超时后不再等待，且不会形成未处理的 Promise 拒绝。
 */

export type BoundedCleanupOutcome = "ok" | "error" | "timeout";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * 在限定时间内执行一次清理操作。
 *
 * @param label 操作名，用于结构化错误信息（如 "abort" / "dispose"）。
 * @param operation 清理动作；同步抛错或异步拒绝都会被捕获。
 * @param onFailure 失败/超时时记录结构化信息。
 * @returns ok | error | timeout
 */
export async function runBoundedCleanup(
  label: string,
  operation: () => Promise<unknown> | unknown,
  timeoutMs: number = DEFAULT_CLEANUP_TIMEOUT_MS,
  onFailure: (message: string) => void = () => undefined,
): Promise<BoundedCleanupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMEOUT = "__cleanup_timeout__";
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(operation),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, timeoutMs));
      }),
    ]);
    if (outcome === TIMEOUT) {
      onFailure(`${label}: cleanup_timeout`);
      return "timeout";
    }
    return "ok";
  } catch (error) {
    onFailure(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "error";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
