/**
 * extensions/lib/secure-fs.ts — 敏感配置与持久化文件私有权限 (0700/0600) 安全读写封装
 */

import {
  chmodSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 确保目录存在并强制为私有权限 (0700)
 */
export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, {
    recursive: true,
    mode: 0o700,
  });

  if (process.platform !== "win32") {
    try {
      chmodSync(dirPath, 0o700);
    } catch {
      // 忽略无法 chmod 的文件系统错误
    }
  }
}

/**
 * 原子化写入私有文件 (0600)，通过临时文件写入后重命名完成原子替换
 */
export function writePrivateFile(target: string, data: string): void {
  ensurePrivateDir(dirname(target));

  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;

  writeFileSync(temp, data, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });

  if (process.platform !== "win32") {
    try {
      chmodSync(temp, 0o600);
    } catch {
      // 忽略平台兼容异常
    }
  }

  renameSync(temp, target);

  if (process.platform !== "win32") {
    try {
      chmodSync(target, 0o600);
    } catch {
      // 忽略平台兼容异常
    }
  }
}

/**
 * 追加写入私有文件 (0600)
 */
export function appendPrivateFile(target: string, data: string): void {
  ensurePrivateDir(dirname(target));

  const isNew = !existsSync(target);

  appendFileSync(target, data, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a",
  });

  if (isNew && process.platform !== "win32") {
    try {
      chmodSync(target, 0o600);
    } catch {
      // 忽略平台兼容异常
    }
  }
}
