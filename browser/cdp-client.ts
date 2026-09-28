/**
 * extensions/browser/cdp-client.ts — 前台桌面 Chrome CDP 客户端
 *
 * 通过 127.0.0.1:9222 连接用户日常前台 Chrome，共享现有全部登录态与会话。
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { ChromeTabInfo } from "./types.js";

const DEFAULT_CDP_PORT = 9222;

export interface CdpConnectionResult {
  ok: boolean;
  browser?: Browser;
  error?: string;
}

export async function connectActiveChrome(port = DEFAULT_CDP_PORT): Promise<CdpConnectionResult> {
  const browserURL = `http://127.0.0.1:${port}`;
  try {
    const browser = await puppeteer.connect({
      browserURL,
      defaultViewport: null, // 继承桌面窗口真实分辨率
    });
    return { ok: true, browser };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `未能连接到桌面 Chrome (${browserURL})。\n提示: 请确保 Chrome 已携带 '--remote-debugging-port=${port}' 参数启动。\n例如在终端运行: google-chrome-stable --remote-debugging-port=${port} &\n错误详情: ${msg}`,
    };
  }
}

export async function listActiveChromeTabs(browser: Browser): Promise<ChromeTabInfo[]> {
  const pages = await browser.pages();
  const tabs: ChromeTabInfo[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const url = page.url();
    // 忽略内部调试空页面
    if (url.startsWith("devtools://") || url.startsWith("chrome-extension://")) continue;

    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "Untitled";
    }

    tabs.push({
      id: String(i),
      title: title || "Untitled",
      url,
      active: i === 0,
    });
  }

  return tabs;
}

export async function getActivePage(browser: Browser, tabId?: string): Promise<{ page?: Page; error?: string }> {
  const pages = await browser.pages();
  if (pages.length === 0) {
    return { error: "Chrome 当前没有打开任何标签页" };
  }

  if (tabId != null) {
    const idx = parseInt(tabId, 10);
    if (!isNaN(idx) && idx >= 0 && idx < pages.length) {
      return { page: pages[idx] };
    }
  }

  // 默认返回最后一个活跃标签页
  return { page: pages[pages.length - 1] };
}
