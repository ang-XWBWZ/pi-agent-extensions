type StreamEvent = Record<string, unknown>;

export function calculateCost(model: any, usage: any): any {
  if (!model?.cost || !usage?.cost) return usage?.cost;
  const rates = model.cost;
  usage.cost.input = ((rates.input || 0) / 1000000) * (usage.input || 0);
  usage.cost.output = ((rates.output || 0) / 1000000) * (usage.output || 0);
  usage.cost.cacheRead = ((rates.cacheRead || 0) / 1000000) * (usage.cacheRead || 0);
  usage.cost.cacheWrite = ((rates.cacheWrite || 0) / 1000000) * (usage.cacheWrite || 0);
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

export function getCurrentTools(messages: any[]): any[] {
  const tools = new Map<string, any>();
  for (const message of messages || []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

export function getCurrentSystemPrompt(messages: any[]): string {
  const content: string[] = [];
  for (const message of messages || []) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string" && message.content.length > 0) {
      content.push(message.content);
    }
  }
  return content.join("\n\n");
}

export function createAssistantMessageEventStream() {
  const events: StreamEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  let resolveResult!: (val: any) => void;
  let rejectResult!: (err: any) => void;
  const resultPromise = new Promise<any>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const notify = () => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };

  return {
    push(event: StreamEvent) {
      if (event.type === "done") {
        resolveResult(event.message);
      } else if (event.type === "error") {
        rejectResult(new Error((event as any).error?.errorMessage || "Stream error"));
      }
      events.push(event);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    result() {
      return resultPromise;
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

export function StringEnum<T extends readonly string[]>(values: T) {
  return {
    type: "string",
    enum: [...values],
  };
}
