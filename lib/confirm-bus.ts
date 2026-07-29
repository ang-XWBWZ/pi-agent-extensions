/**
 * confirm-bus.ts — 全局确认信号总线
 *
 * 解耦确认弹窗与 tool_call 拦截。
 * 任何 session 发出 confirm-request → 主 session UI 监听 → 弹窗 → 回传结果。
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { enqueueFrontend, registerFrontendProcessor } from "./agent-bus.js";

// ---- 全局单例 ----

const globalBus: EventEmitter = ((globalThis as Record<string, unknown>).__pi_confirm_bus as EventEmitter) ||
  (() => {
    const bus = new EventEmitter();
    bus.setMaxListeners(50);
    (globalThis as Record<string, unknown>).__pi_confirm_bus = bus;
    return bus;
  })();

// ---- types ----

export interface ConfirmRequest {
  reqId: string;
  type: "path" | "bash";
  label: string;
  target: string;
  options: string[];
  sessionId: string;
}

export interface ConfirmResponse {
  reqId: string;
  choice: string | undefined;
}

// ---- 发射请求 ----

export function requestConfirm(
  type: "path" | "bash",
  label: string,
  target: string,
  options: string[],
  timeoutMs: number = 60_000,
): Promise<string | undefined> {
  const reqId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      globalBus.emit("confirm-response", { reqId, choice: undefined } satisfies ConfirmResponse);
    }, timeoutMs);

    const handler = (resp: ConfirmResponse) => {
      if (resp.reqId !== reqId) return;
      clearTimeout(timer);
      globalBus.off("confirm-response", handler);
      resolve(resp.choice);
    };

    globalBus.on("confirm-response", handler);
    globalBus.emit("confirm-request", {
      reqId, type, label, target, options, sessionId: "sub",
    } satisfies ConfirmRequest);
  });
}

// ---- 主进程注册 ----

export interface BusUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder: string): Promise<string | undefined>;
  editor(title: string, prefill: string): Promise<string | undefined>;
  notify(msg: string, type: string): void;
}

export function registerBusUI(ui: BusUI): () => void {
  // 注册 confirm 处理器：队列游标到时才调 ui.select
  registerFrontendProcessor("confirm", async (data) => {
    const req = data as ConfirmRequest;
    try {
      return await ui.select(req.label, req.options);
    } catch {
      return undefined;
    }
  });

  // confirm-request 事件 → 入队（不直接调 ui.select）
  const handler = (req: ConfirmRequest) => {
    enqueueFrontend("confirm", 0, req, 60_000)
      .then((choice) => {
        globalBus.emit("confirm-response", { reqId: req.reqId, choice: choice as string | undefined } satisfies ConfirmResponse);
      })
      .catch((err) => {
        console.warn("[confirm-bus] enqueue failed:", err.message);
        globalBus.emit("confirm-response", { reqId: req.reqId, choice: undefined } satisfies ConfirmResponse);
      });
  };
  globalBus.on("confirm-request", handler);
  return () => globalBus.off("confirm-request", handler);
}

export function requestInput(
  prompt: string,
  placeholder: string,
  timeoutMs: number = 60_000,
): Promise<string | undefined> {
  const reqId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      globalBus.emit("input-response", { reqId, text: undefined });
    }, timeoutMs);
    const handler = (resp: { reqId: string; text: string | undefined }) => {
      if (resp.reqId !== reqId) return;
      clearTimeout(timer);
      globalBus.off("input-response", handler);
      resolve(resp.text);
    };
    globalBus.on("input-response", handler);
    globalBus.emit("input-request", { reqId, prompt, placeholder });
  });
}

export function registerBusInput(ui: BusUI): () => void {
  const handler = async (req: { reqId: string; prompt: string; placeholder: string }) => {
    try {
      const text = await ui.input(req.prompt, req.placeholder);
      globalBus.emit("input-response", { reqId: req.reqId, text });
    } catch {
      globalBus.emit("input-response", { reqId: req.reqId, text: undefined });
    }
  };
  globalBus.on("input-request", handler);
  return () => globalBus.off("input-request", handler);
}
