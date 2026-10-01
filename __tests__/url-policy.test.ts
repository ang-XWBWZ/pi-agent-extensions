import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicHttpUrl,
  isForbiddenBrowserScheme,
  isPrivateIp,
} from "../browser/url-policy.js";

test("isPrivateIp correctly flags private and loopback addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.1.5"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);

  // 公网 IP
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("93.184.216.34"), false);
});

test("assertPublicHttpUrl rejects dangerous protocols and credentials", async () => {
  await assert.rejects(
    assertPublicHttpUrl("file:///etc/passwd"),
    /安全阻断: 浏览器工具仅允许 HTTP\/HTTPS 协议/,
  );
  await assert.rejects(
    assertPublicHttpUrl("javascript:alert(1)"),
    /安全阻断: 浏览器工具仅允许 HTTP\/HTTPS 协议/,
  );
  await assert.rejects(
    assertPublicHttpUrl("chrome://settings"),
    /安全阻断: 浏览器工具仅允许 HTTP\/HTTPS 协议/,
  );
  await assert.rejects(
    assertPublicHttpUrl("https://user:pass@example.com"),
    /安全阻断: 禁止携带认证凭据/,
  );
});

test("assertPublicHttpUrl rejects localhost and metadata addresses directly", async () => {
  await assert.rejects(
    assertPublicHttpUrl("http://localhost:8080"),
    /安全阻断: 禁止访问本地环回与元数据地址/,
  );
  await assert.rejects(
    assertPublicHttpUrl("http://service.localhost/api"),
    /安全阻断: 禁止访问本地环回与元数据地址/,
  );
  await assert.rejects(
    assertPublicHttpUrl("http://127.0.0.1:3000"),
    /安全阻断: 禁止访问本地环回与元数据地址/,
  );
  await assert.rejects(
    assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
    /安全阻断: 禁止访问本地环回与元数据地址/,
  );
});

test("assertPublicHttpUrl rejects domain names resolving to private IPs (SSRF protection)", async () => {
  const mockDnsResolver = async (host: string) => {
    if (host === "internal.corp.com") return ["10.0.0.1"];
    if (host === "cloud-meta.internal") return ["169.254.169.254"];
    if (host === "my-router.lan") return ["192.168.1.1"];
    return ["93.184.216.34"];
  };

  await assert.rejects(
    assertPublicHttpUrl("http://internal.corp.com/secret", mockDnsResolver),
    /解析到私网或受限 IP 地址 \(10\.0\.0\.1\)/,
  );
  await assert.rejects(
    assertPublicHttpUrl("http://cloud-meta.internal/", mockDnsResolver),
    /解析到私网或受限 IP 地址 \(169\.254\.169\.254\)/,
  );
  await assert.rejects(
    assertPublicHttpUrl("http://my-router.lan/admin", mockDnsResolver),
    /解析到私网或受限 IP 地址 \(192\.168\.1\.1\)/,
  );
});

test("assertPublicHttpUrl allows valid public destinations", async () => {
  const mockDnsResolver = async (_host: string) => ["93.184.216.34"];
  const url = await assertPublicHttpUrl("https://example.com/docs", mockDnsResolver);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "example.com");
  assert.equal(url.pathname, "/docs");
});

test("isForbiddenBrowserScheme correctly detects privileged browser schemes", () => {
  assert.equal(isForbiddenBrowserScheme("file:///home/user/doc"), true);
  assert.equal(isForbiddenBrowserScheme("chrome://version"), true);
  assert.equal(isForbiddenBrowserScheme("chrome-extension://xyz/popup.html"), true);
  assert.equal(isForbiddenBrowserScheme("javascript:void(0)"), true);
  assert.equal(isForbiddenBrowserScheme("data:text/html,<h1>hi</h1>"), true);
  assert.equal(isForbiddenBrowserScheme("about:blank"), true);
  assert.equal(isForbiddenBrowserScheme("view-source:https://example.com"), true);

  assert.equal(isForbiddenBrowserScheme("https://example.com"), false);
  assert.equal(isForbiddenBrowserScheme("http://example.com"), false);
});
