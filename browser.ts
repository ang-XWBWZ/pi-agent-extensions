/**
 * extensions/browser.ts — 浏览器自动化渐进式能力入口 (PCS Cache-Safe)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCapability } from "./lib/capability-router.js";
import { registerBrowserTools } from "./browser/browser-tools.js";

export default function (pi: ExtensionAPI) {
  registerBrowserTools(pi);

  registerCapability({
    id: "browser",
    name: "Browser Automation",
    summary: "Interact with active desktop Chrome via CDP or scrape via headless.",
    keywords: ["browser", "chrome", "web", "webpage", "headless", "scrape", "cdp", "tab"],
    phases: ["plan", "work"],
    tools: ["browser_read", "chrome_tabs", "chrome_act", "chrome_screenshot"],
    toolDescriptions: {
      browser_read: "读取并提纯网页内容为 Clean Markdown（支持无头后台静默抓取或前台当前 Tab）",
      chrome_tabs: "查看前台桌面日常 Chrome 打开的所有标签页列表（标题与 URL）",
      chrome_act: "在前台 Chrome 活跃标签页中执行点击、输入、按键、滚动或导航交互",
      chrome_screenshot: "截取前台 Chrome 网页内容渲染图像进行视觉核验（保护桌面隐私）",
    },
    usageDoc: `# Browser Automation (browser)

提供双轨浏览器操作与资讯抓取能力：
1. **前台日常 Chrome（Active Mode）**：通过 CDP (@ 9222) 直连桌面已运行的 Chrome，保留已有全部登录态、Cookie 及 Session。
2. **后台备用无头（Headless Mode）**：静默抓取/阅读公开文档与网页，不弹窗、不抢夺前台焦点。

### Available Tools:
- \`browser_read\`: 提取网页正文并提纯为 Markdown。传 \`mode="headless"\`（默认）在后台静默抓取；传 \`mode="active"\` 读取前台 Chrome 当前 Tab。
- \`chrome_tabs\`: 列出前台 Chrome 当前打开的标签页列表（查看你当前在浏览什么）。
- \`chrome_act\`: 在前台 Chrome 中执行点击 (\`click\`)、打字 (\`type\`)、按键 (\`press_key\`)、滚动 (\`scroll\`)、跳转 (\`navigate\`)。
- \`chrome_screenshot\`: 仅截取前台 Chrome 网页渲染视窗，保存图像用于视觉确认。

### 前台 Chrome 启动方式:
在桌面终端运行:
\`\`\`bash
google-chrome-stable --remote-debugging-port=9222 &
\`\`\`
`,
  });
}
