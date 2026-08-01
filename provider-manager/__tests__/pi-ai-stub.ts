type StreamEvent = Record<string, unknown>;

export function calculateCost(): void {
  // The provider stream tests only verify control-flow; they do not need pricing.
}

export function createAssistantMessageEventStream() {
  const events: StreamEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;

  const notify = () => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  return {
    push(event: StreamEvent) {
      events.push(event);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = events.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
