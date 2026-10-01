import test from "node:test";
import assert from "node:assert/strict";
import registerLongAttentionPs from "../long-attention-ps.js";

interface Notice {
  message: string;
  level: string;
}

/**
 * 命令 handler 的契约是 `handler(args: string, ctx)`——内核只把命令名之后的
 * 原始字符串传进来（agent-session 的 _tryExecuteExtensionCommand）。这个测试
 * 用真实字符串驱动 handler，钉住「/ps 的子命令必须真的被分派」。
 *
 * 回归背景：该 handler 一度把 args 当成已解析对象使用（args._ / args.text），
 * 于是 args._ 恒为 undefined，sub 恒为 "list"，/ps add|clear|config 全部静默失效——
 * 敲 `/ps add X` 只会得到一份列表，且没有任何报错。
 */
function harness() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notifications: Notice[] = [];
  const mockPi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def);
    },
    appendEntry: () => {},
  };
  const mockCtx = {
    cwd: "/workspace",
    sessionManager: {},
    ui: {
      setStatus: () => {},
      notify: (message: string, level = "info") => notifications.push({ message, level }),
    },
  };

  registerLongAttentionPs(mockPi as never);
  const ps = commands.get("ps");
  assert.ok(ps, "the /ps command must be registered");
  return { ps: ps!, mockCtx, notifications };
}

test("/ps add parses the raw command string into positionals and --flags", async () => {
  const { ps, mockCtx, notifications } = harness();
  await ps.handler("clear", mockCtx);
  notifications.length = 0;

  await ps.handler("add 发布前必须跑 pnpm test --priority=high --type=prior_decision", mockCtx);

  assert.equal(notifications.length, 1, "adding must report exactly one notice");
  assert.equal(notifications[0].level, "info");
  assert.match(notifications[0].message, /已添加/);
  assert.match(notifications[0].message, /\[high\]/, "--priority must reach parsePriority");
  assert.match(notifications[0].message, /\[prior_decision\]/, "--type must reach parseType");

  notifications.length = 0;
  await ps.handler("list", mockCtx);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /发布前必须跑 pnpm test/, "the item must be retrievable via list");
  assert.match(notifications[0].message, /high/);
});

test("/ps add without content reports usage instead of silently listing", async () => {
  const { ps, mockCtx, notifications } = harness();
  notifications.length = 0;

  await ps.handler("add", mockCtx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /用法/);
});

test("/ps clear empties the store and list reports it empty", async () => {
  const { ps, mockCtx, notifications } = harness();
  await ps.handler("add 临时项", mockCtx);
  notifications.length = 0;

  await ps.handler("clear", mockCtx);
  assert.match(notifications[0].message, /已清理/);

  notifications.length = 0;
  await ps.handler("list", mockCtx);
  assert.match(notifications[0].message, /长程 PS 为空/);
});

test("/ps config reports the configuration", async () => {
  const { ps, mockCtx, notifications } = harness();
  notifications.length = 0;

  await ps.handler("config", mockCtx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /PS 配置/);
});

test("/ps falls back to list when no subcommand is given", async () => {
  const { ps, mockCtx, notifications } = harness();
  await ps.handler("clear", mockCtx);
  notifications.length = 0;

  await ps.handler("", mockCtx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /长程 PS/);
});

test("/ps rejects an unknown subcommand with usage guidance", async () => {
  const { ps, mockCtx, notifications } = harness();
  notifications.length = 0;

  await ps.handler("bogus", mockCtx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /用法: \/ps add\|list\|clear\|config/);
});
