/**
 * Ensure an in-flight fetch/body operation settles when its AbortSignal fires.
 *
 * A few fetch implementations and proxies can leave a pending promise behind
 * after aborting a half-open response.  Racing the operation with the signal
 * lets the provider stream emit its terminal error event instead of leaving
 * the Agent in Working state forever.
 */
export function createRequestAbortError(message = "Request was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function awaitWithAbort<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal,
  message = "Request was aborted",
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createRequestAbortError(message));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: (() => void) | undefined;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal.removeEventListener("abort", onAbort);
      callback();
    };

    onAbort = () => {
      settle(() => reject(createRequestAbortError(message)));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      Promise.resolve(operation()).then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

export function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
  if (!reader) return;
  void reader.cancel().catch(() => undefined);
}
