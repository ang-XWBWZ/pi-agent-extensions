/**
 * extensions/browser/url-policy.ts — 浏览器网络边界与 SSRF 防护策略
 */

import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const PRIVATE_BLOCKLIST = new BlockList();

// IPv4 私网与受限地址段
PRIVATE_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4"); // 包含云元数据 169.254.169.254
PRIVATE_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_BLOCKLIST.addSubnet("224.0.0.0", 4, "ipv4");

// IPv6 私网与本地回环
PRIVATE_BLOCKLIST.addAddress("::1", "ipv6");
PRIVATE_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
PRIVATE_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");

export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host: string) => {
  if (isIP(host)) return [host];

  const result = await lookup(host, {
    all: true,
    verbatim: true,
  });

  return result.map((item) => item.address);
};

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_BLOCKLIST.check(ip, "ipv4");
  if (family === 6) return PRIVATE_BLOCKLIST.check(ip, "ipv6");
  return false;
}

/**
 * 校验目标 URL 是否为合法的公共网络 HTTP/HTTPS 目标
 * 阻断本地私网、环回接口、Link-local、云厂商元数据及非 HTTP 协议
 */
export async function assertPublicHttpUrl(
  value: string,
  resolveHost: HostResolver = defaultResolver,
): Promise<URL> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`非法的网页目标 URL: "${value}"`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`安全阻断: 浏览器工具仅允许 HTTP/HTTPS 协议，已拦截协议 "${url.protocol}"`);
  }

  if (url.username || url.password) {
    throw new Error("安全阻断: 禁止携带认证凭据 (username/password) 的 URL");
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "169.254.169.254"
  ) {
    throw new Error(`安全阻断: 禁止访问本地环回与元数据地址 (${host})`);
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    throw new Error(`DNS 解析失败: 无法解析域名 "${host}" (${err instanceof Error ? err.message : String(err)})`);
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS 解析失败: 域名 "${host}" 未返回有效 IP 地址`);
  }

  for (const address of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`安全阻断: 目标域名 "${host}" 解析到私网或受限 IP 地址 (${address})，已阻断访问`);
    }
  }

  return url;
}

const FORBIDDEN_SCHEMES = [
  "file:",
  "javascript:",
  "data:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "about:",
  "view-source:",
];

export function isForbiddenBrowserScheme(urlStr: string): boolean {
  const lower = urlStr.trim().toLowerCase();
  return FORBIDDEN_SCHEMES.some((scheme) => lower.startsWith(scheme));
}
