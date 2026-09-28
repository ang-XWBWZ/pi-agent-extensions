/**
 * extensions/browser/headless-pool.ts — 后台备用无头浏览器实例管理器
 *
 * 核心特性：
 * 1. 自动复用 Arch Linux 系统已有的 Chrome/Chromium 二进制；
 * 2. 懒启动（首次使用才拉起进程）；
 * 3. 5 分钟空闲自动回收释放内存。
 */

import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";

const POSSIBLE_CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/google-chrome",
  "/usr/bin/brave-browser",
];

function detectSystemChromePath(): string | undefined {
  for (const p of POSSIBLE_CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

class HeadlessPool {
  private browser: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟无任务自动关闭

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
    }, this.IDLE_TIMEOUT_MS);
  }

  async getBrowser(): Promise<{ browser?: Browser; error?: string }> {
    this.resetIdleTimer();

    if (this.browser && this.browser.connected) {
      return { browser: this.browser };
    }

    const execPath = detectSystemChromePath();
    if (!execPath) {
      return {
        error: "系统未检测到 Chrome/Chromium 可执行文件（已检查 /usr/bin/google-chrome-stable 等常用路径）。请安装 google-chrome 或 chromium。",
      };
    }

    try {
      const args = [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
      ];

      // 仅在 root 用户环境或显式配置环境变量时才启用 --no-sandbox，普通用户完整保留 Chrome 原生沙箱隔离
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (isRoot || process.env.CHROME_NO_SANDBOX === "1") {
        args.unshift("--no-sandbox", "--disable-setuid-sandbox");
      }

      this.browser = await puppeteer.launch({
        executablePath: execPath,
        headless: true,
        args,
      });
      return { browser: this.browser };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `启动无头浏览器失败: ${msg}` };
    }
  }

  async close() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // 忽略关闭异常
      }
      this.browser = null;
    }
  }
}

export const headlessPool = new HeadlessPool();
