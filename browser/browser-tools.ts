/**
 * extensions/browser/browser-tools.ts — 浏览器自动化核心工具集定义
 *
 * 工具清单：
 * 1. browser_read: 提取网页纯净 Markdown (默认后台 headless，也可读前台 active tab)
 * 2. chrome_tabs: 查看前台桌面 Chrome 打开的所有标签页
 * 3. chrome_act: 在前台 Chrome 执行点击、输入、按键等交互
 * 4. chrome_screenshot: 截取目标网页渲染图像用于视觉复核
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isToolResultError, renderStructuredToolCall, renderToolResult } from "../lib/tui-render.js";
import { connectActiveChrome, getActivePage, listActiveChromeTabs } from "./cdp-client.js";
import { headlessPool } from "./headless-pool.js";
import { purifyHtmlToMarkdown } from "./page-purifier.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function registerBrowserTools(pi: ExtensionAPI) {
  // 1. browser_read
  pi.registerTool({
    name: "browser_read",
    label: "Browser Read",
    description:
      "Read webpage content converted to clean markdown. Defaults to silent background headless mode (fetches url); set mode='active' to read from currently active desktop Chrome tab without navigation.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Target URL to read (required for headless mode)" })),
      tabId: Type.Optional(Type.String({ description: "Tab ID for active mode (defaults to current tab)" })),
      mode: Type.Optional(Type.String({ description: "headless (default, silent) | active (read from active desktop Chrome)" })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return (default 16000)" })),
      offset: Type.Optional(Type.Number({ description: "Character offset for reading next page (default 0)" })),
    }),
    renderCall(args, theme, context) {
      return renderStructuredToolCall(theme, context, "browser_read", [
        { name: "url", value: args.url, maxLength: 60 },
        { name: "mode", value: args.mode || "headless", tone: "accent" },
        { name: "tabId", value: args.tabId },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 4,
        isError: isToolResultError(result),
      });
    },
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const mode = params.mode === "active" ? "active" : "headless";
      const maxChars = params.maxChars || 16_000;
      const offset = params.offset || 0;

      if (mode === "active") {
        const cdp = await connectActiveChrome();
        if (!cdp.ok || !cdp.browser) {
          return {
            content: [{ type: "text", text: cdp.error || "未能连接前台 Chrome" }],
            details: { error: "cdp_connect_failed" },
          };
        }
        try {
          const { page, error } = await getActivePage(cdp.browser, params.tabId);
          if (!page) {
            return {
              content: [{ type: "text", text: error || "未找到可用标签页" }],
              details: { error: "page_not_found" },
            };
          }
          if (params.url) {
            const currentUrl = page.url();
            const normalize = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
            if (normalize(currentUrl) !== normalize(params.url)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `安全限制: browser_read 在 active 模式下是纯只读工具，禁止隐式跳转导航现有标签页（当前页面: ${currentUrl}）。\n- 如需抓取目标 URL，请使用默认的 headless 模式: browser_read({ url: "${params.url}" })\n- 如需在前台导航现有标签页，请调用受控审批工具: chrome_act({ action: "navigate", url: "${params.url}" })`,
                  },
                ],
                details: { error: "navigation_forbidden_in_read_mode", currentUrl, requestedUrl: params.url },
              };
            }
          }
          if (signal?.aborted) throw new Error("操作已被用户中止");
          const html = await page.content();
          const title = await page.title();
          const url = page.url();
          const purified = purifyHtmlToMarkdown(html, maxChars, offset);
          return {
            content: [
              {
                type: "text",
                text: [
                  `# ${title}`,
                  `URL: ${url}`,
                  `字符总数: ${purified.totalChars}${purified.truncated ? ` (已截断显示前 ${maxChars} 字，下次续读请传 offset=${purified.nextOffset})` : ""}`,
                  "---",
                  purified.markdown,
                ].join("\n"),
              },
            ],
            details: { title, url, ...purified },
          };
        } finally {
          cdp.browser.disconnect();
        }
      } else {
        // 后台 headless 模式
        if (!params.url) {
          return {
            content: [{ type: "text", text: "错误: 后台无头抓取模式必须提供 url 参数" }],
            details: { error: "missing_url" },
          };
        }
        const { browser, error } = await headlessPool.getBrowser();
        if (!browser) {
          return {
            content: [{ type: "text", text: error || "启动无头浏览器失败" }],
            details: { error: "headless_launch_failed" },
          };
        }
        const page = await browser.newPage();
        try {
          await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (signal?.aborted) throw new Error("操作已被用户中止");
          const html = await page.content();
          const title = await page.title();
          const purified = purifyHtmlToMarkdown(html, maxChars, offset);
          return {
            content: [
              {
                type: "text",
                text: [
                  `# ${title}`,
                  `URL: ${params.url}`,
                  `字符总数: ${purified.totalChars}${purified.truncated ? ` (已截断显示前 ${maxChars} 字，下次续读请传 offset=${purified.nextOffset})` : ""}`,
                  "---",
                  purified.markdown,
                ].join("\n"),
              },
            ],
            details: { title, url: params.url, ...purified },
          };
        } finally {
          await page.close();
        }
      }
    },
  });

  // 2. chrome_tabs
  pi.registerTool({
    name: "chrome_tabs",
    label: "Chrome Tabs",
    description: "List all currently open tabs in your active desktop Chrome browser (via CDP @ 9222).",
    parameters: Type.Object({}),
    renderCall(_args, theme, context) {
      return renderStructuredToolCall(theme, context, "chrome_tabs", []);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 4,
        isError: isToolResultError(result),
      });
    },
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const cdp = await connectActiveChrome();
      if (!cdp.ok || !cdp.browser) {
        return {
          content: [{ type: "text", text: cdp.error || "未能连接前台 Chrome" }],
          details: { error: "cdp_connect_failed" },
        };
      }
      try {
        const tabs = await listActiveChromeTabs(cdp.browser);
        const text = tabs.length === 0
          ? "当前 Chrome 没有打开任何常规网页标签"
          : tabs.map((t) => `[Tab ${t.id}] ${t.title}\n   ${t.url}`).join("\n\n");
        return {
          content: [{ type: "text", text: `前台 Chrome 标签页清单 (共 ${tabs.length} 个):\n\n${text}` }],
          details: { tabs },
        };
      } finally {
        cdp.browser.disconnect();
      }
    },
  });

  // 3. chrome_act
  pi.registerTool({
    name: "chrome_act",
    label: "Chrome Act",
    description: "Perform interactions (click, type, press_key, scroll, navigate) in your active desktop Chrome tab.",
    parameters: Type.Object({
      action: Type.String({ description: "click | type | press_key | scroll | navigate | wait" }),
      tabId: Type.Optional(Type.String({ description: "Target tab ID (defaults to current active tab)" })),
      selector: Type.Optional(Type.String({ description: "CSS selector of target element" })),
      text: Type.Optional(Type.String({ description: "Text to type" })),
      key: Type.Optional(Type.String({ description: "Key name to press (e.g. Enter, Escape, ArrowDown)" })),
      url: Type.Optional(Type.String({ description: "Target URL for navigate action" })),
      scrollDelta: Type.Optional(Type.Number({ description: "Vertical scroll distance in pixels (default 500)" })),
    }),
    renderCall(args, theme, context) {
      const isSensitive = /password|token|secret|key|auth|credential/i.test(args.selector || "");
      return renderStructuredToolCall(theme, context, "chrome_act", [
        { name: "action", value: args.action, tone: "accent" },
        { name: "selector", value: args.selector, maxLength: 40 },
        { name: "text", value: isSensitive ? "******" : (args.text ? `"${args.text}"` : undefined) },
        { name: "url", value: args.url, maxLength: 50 },
      ]);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 3,
        isError: isToolResultError(result),
      });
    },
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const cdp = await connectActiveChrome();
      if (!cdp.ok || !cdp.browser) {
        return {
          content: [{ type: "text", text: cdp.error || "未能连接前台 Chrome" }],
          details: { error: "cdp_connect_failed" },
        };
      }
      try {
        const { page, error } = await getActivePage(cdp.browser, params.tabId);
        if (!page) {
          return {
            content: [{ type: "text", text: error || "未找到可用标签页" }],
            details: { error: "page_not_found" },
          };
        }
        if (signal?.aborted) throw new Error("操作已被用户中止");

        switch (params.action) {
          case "navigate": {
            if (!params.url) {
              return { content: [{ type: "text", text: "错误: navigate 需要提供 url" }], details: { error: "missing_url" } };
            }
            await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            return {
              content: [{ type: "text", text: `已导航至: ${params.url} (页面标题: ${await page.title()})` }],
              details: { action: "navigate", url: params.url },
            };
          }

          case "click": {
            if (!params.selector) {
              return { content: [{ type: "text", text: "错误: click 需要提供 selector" }], details: { error: "missing_selector" } };
            }
            await page.waitForSelector(params.selector, { timeout: 10_000 });
            await page.click(params.selector);
            return {
              content: [{ type: "text", text: `已成功点击元素: ${params.selector}` }],
              details: { action: "click", selector: params.selector },
            };
          }

          case "type": {
            if (!params.selector || params.text == null) {
              return { content: [{ type: "text", text: "错误: type 需要提供 selector 和 text" }], details: { error: "missing_params" } };
            }
            await page.waitForSelector(params.selector, { timeout: 10_000 });
            await page.type(params.selector, params.text);

            const isSensitiveElement = await page.$eval(params.selector, (el) => {
              if (el instanceof HTMLInputElement) {
                const type = (el.type || "").toLowerCase();
                const name = (el.name || el.id || el.getAttribute("autocomplete") || "").toLowerCase();
                return type === "password" || name.includes("password") || name.includes("token") || name.includes("secret") || name.includes("apikey");
              }
              return false;
            }).catch(() => false);

            const isSensitive = isSensitiveElement || /password|token|secret|key|auth|credential/i.test(params.selector);
            const displayText = isSensitive ? "****** (敏感内容已脱敏)" : params.text;

            return {
              content: [{ type: "text", text: `已向元素 ${params.selector} 输入内容: ${displayText}` }],
              details: { action: "type", selector: params.selector, text: isSensitive ? "******" : params.text },
            };
          }

          case "press_key": {
            if (!params.key) {
              return { content: [{ type: "text", text: "错误: press_key 需要提供 key 名称" }], details: { error: "missing_key" } };
            }
            await page.keyboard.press(params.key as any);
            return {
              content: [{ type: "text", text: `已按下按键: ${params.key}` }],
              details: { action: "press_key", key: params.key },
            };
          }

          case "scroll": {
            const delta = params.scrollDelta || 500;
            await page.evaluate((d) => window.scrollBy(0, d), delta);
            return {
              content: [{ type: "text", text: `已垂直滚动 ${delta} 像素` }],
              details: { action: "scroll", delta },
            };
          }

          case "wait": {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return {
              content: [{ type: "text", text: "等待 2 秒完成" }],
              details: { action: "wait" },
            };
          }

          default:
            return {
              content: [{ type: "text", text: `未知浏览器动作: ${params.action}` }],
              details: { error: "unknown_action" },
            };
        }
      } finally {
        cdp.browser.disconnect();
      }
    },
  });

  // 4. chrome_screenshot
  pi.registerTool({
    name: "chrome_screenshot",
    label: "Chrome Screenshot",
    description: "Capture visual screenshot of current active desktop Chrome webpage. Only captures webpage rendering area, preserving OS desktop privacy.",
    parameters: Type.Object({
      tabId: Type.Optional(Type.String({ description: "Target tab ID (defaults to current tab)" })),
    }),
    renderCall(_args, theme, context) {
      return renderStructuredToolCall(theme, context, "chrome_screenshot", []);
    },
    renderResult(result, options, theme, context) {
      return renderToolResult(result, options, theme, context, {
        previewLines: 2,
        isError: isToolResultError(result),
      });
    },
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const cdp = await connectActiveChrome();
      if (!cdp.ok || !cdp.browser) {
        return {
          content: [{ type: "text", text: cdp.error || "未能连接前台 Chrome" }],
          details: { error: "cdp_connect_failed" },
        };
      }
      try {
        const { page, error } = await getActivePage(cdp.browser, params.tabId);
        if (!page) {
          return {
            content: [{ type: "text", text: error || "未找到可用标签页" }],
            details: { error: "page_not_found" },
          };
        }
        const dir = join(tmpdir(), "pi-browser-screenshots");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const filePath = join(dir, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: filePath, fullPage: false });
        const title = await page.title();
        const url = page.url();
        return {
          content: [
            {
              type: "text",
              text: `已截取网页图像 [${title}]: ${filePath}`,
            },
          ],
          details: { filePath, title, url },
        };
      } finally {
        cdp.browser.disconnect();
      }
    },
  });
}
