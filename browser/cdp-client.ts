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

export function isInternalPageUrl(url: string): boolean {
  return /^(devtools|chrome|chrome-extension|view-source|about):/i.test(url);
}

async function isPageVisible(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => document.visibilityState === "visible");
  } catch {
    return false;
  }
}

export async function listActiveChromeTabs(browser: Browser): Promise<ChromeTabInfo[]> {
  const pages = await browser.pages();
  const tabs: ChromeTabInfo[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const url = page.url();
    // 忽略内部调试与扩展页面
    if (isInternalPageUrl(url)) continue;

    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "Untitled";
    }

    const active = await isPageVisible(page);

    tabs.push({
      id: String(i),
      title: title || "Untitled",
      url,
      active,
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
      const targetPage = pages[idx];
      if (isInternalPageUrl(targetPage.url())) {
        return { error: `安全限制: 禁止操作浏览器内部系统页面 (${targetPage.url()})` };
      }
      return { page: targetPage };
    }
    return { error: `标签页 ID ${tabId} 不存在或已关闭` };
  }

  // 默认模式：优先寻找当前桌面可见（visible）的非内部标签页
  const eligible = pages.filter((p) => !isInternalPageUrl(p.url()));
  if (eligible.length === 0) {
    return { error: "Chrome 当前没有打开任何常规网页标签（全部为内部或扩展页面）" };
  }

  for (let i = eligible.length - 1; i >= 0; i--) {
    if (await isPageVisible(eligible[i])) {
      return { page: eligible[i] };
    }
  }

  // 若无前台可见页面（如窗口最小化），返回最后一个非内部标签页
  return { page: eligible[eligible.length - 1] };
}
