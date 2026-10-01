/**
 * extensions/__tests__/browser-capability.test.ts — 浏览器自动化能力单元测试
 */

import test from "node:test";
import assert from "node:assert/strict";
import { purifyHtmlToMarkdown } from "../browser/page-purifier.js";
import { connectActiveChrome } from "../browser/cdp-client.js";
import { headlessPool } from "../browser/headless-pool.js";
import { getCapability } from "../lib/capability-router.js";
import browserExtension from "../browser.js";

test("purifyHtmlToMarkdown cleans noisy HTML and extracts structured markdown", () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
        <style>body { color: red; }</style>
        <script>console.log("noisy tracking script");</script>
      </head>
      <body>
        <h1>Main Heading</h1>
        <p>This is a paragraph with <a href="https://example.com">a link</a> and a <button>Submit</button> button.</p>
        <pre><code>const a = 1;</code></pre>
        <ul>
          <li>First item</li>
          <li>Second item</li>
        </ul>
        <svg><path d="M0 0"/></svg>
      </body>
    </html>
  `;

  const result = purifyHtmlToMarkdown(sampleHtml, 500, 0);

  // 1. 噪音过滤
  assert.doesNotMatch(result.markdown, /noisy tracking script/);
  assert.doesNotMatch(result.markdown, /color: red/);
  assert.doesNotMatch(result.markdown, /<svg>/);

  // 2. 语义提取
  assert.match(result.markdown, /# Main Heading/);
  assert.match(result.markdown, /\[a link\]\(https:\/\/example\.com\)/);
  assert.match(result.markdown, /\[Button: Submit\]/);
  assert.match(result.markdown, /const a = 1;/);
  assert.match(result.markdown, /- First item/);

  // 3. 截断验证
  const truncated = purifyHtmlToMarkdown(sampleHtml, 20, 0);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.markdown.length, 20);
  assert.equal(truncated.nextOffset, 20);
});

test("connectActiveChrome returns graceful diagnostic message when CDP port is closed", async () => {
  // 连接一个绝不可能开放的临时端口
  const result = await connectActiveChrome(59999);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /未能连接到桌面 Chrome/);
  assert.match(result.error, /--remote-debugging-port=59999/);
});

test("browser capability registers properly into PCS capability router", () => {
  const toolsRegistered: string[] = [];
  const mockPi = {
    on: () => {},
    registerTool: (def: any) => toolsRegistered.push(def.name),
  };

  browserExtension(mockPi as any);
  assert.deepEqual(toolsRegistered, [], "browser operations must not become native tools");

  const manifest = getCapability("browser");
  assert.ok(manifest, "Browser capability should be registered");
  assert.equal(manifest.name, "Browser Automation");
  assert.deepEqual(manifest.phases, ["plan", "work"]);
  assert.ok(manifest.tools.includes("browser_read"));
  assert.ok(manifest.tools.includes("chrome_tabs"));
  assert.ok(manifest.tools.includes("chrome_act"));
  assert.ok(manifest.tools.includes("chrome_screenshot"));

  assert.ok(manifest.toolDescriptions?.browser_read);
  assert.ok(manifest.toolDescriptions?.chrome_act);
  assert.ok(manifest.usageDoc.includes("Active Mode"));
  assert.ok(manifest.usageDoc.includes("Headless Mode"));
});

test("isInternalPageUrl identifies internal and extension URLs", async () => {
  const { isInternalPageUrl } = await import("../browser/cdp-client.js");
  assert.equal(isInternalPageUrl("devtools://devtools/bundled/inspector.html"), true);
  assert.equal(isInternalPageUrl("chrome://settings"), true);
  assert.equal(isInternalPageUrl("chrome-extension://abcdef/popup.html"), true);
  assert.equal(isInternalPageUrl("about:blank"), true);
  assert.equal(isInternalPageUrl("view-source:https://example.com"), true);
  assert.equal(isInternalPageUrl("https://example.com"), false);
  assert.equal(isInternalPageUrl("http://localhost:3000"), false);
});

test("headless pool preserves sandbox arguments for non-root environments", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const poolSource = readFileSync(join(currentDir, "..", "browser", "headless-pool.ts"), "utf8");

  // 确保没有无条件直接开启 --no-sandbox
  assert.doesNotMatch(poolSource, /args:\s*\[\s*"--no-sandbox"/);
  assert.match(poolSource, /process\.getuid/);
  assert.match(poolSource, /CHROME_NO_SANDBOX/);
});

test("browser_read active mode forbids implicit navigation", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const toolsSource = readFileSync(join(currentDir, "..", "browser", "browser-tools.ts"), "utf8");

  assert.match(toolsSource, /navigation_forbidden_in_read_mode/);
  assert.match(toolsSource, /chrome_act\(.*navigate/);
});
