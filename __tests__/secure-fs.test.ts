import test from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ensurePrivateDir,
  writePrivateFile,
  appendPrivateFile,
} from "../lib/secure-fs.js";
import { writeMcpConfig, readMcpConfig } from "../mcp/lib/config.js";

const testDir = join(tmpdir(), `test-secure-fs-${randomUUID()}`);

test("ensurePrivateDir creates directory with 0700 permissions", () => {
  const dir = join(testDir, "private-sub-dir");
  ensurePrivateDir(dir);
  assert.equal(existsSync(dir), true);

  if (process.platform !== "win32") {
    const mode = statSync(dir).mode & 0o777;
    assert.equal(mode, 0o700, "Directory must have 0700 mode on POSIX");
  }
});

test("writePrivateFile writes atomic file with 0600 permissions", () => {
  const file = join(testDir, "secrets.json");
  const data = JSON.stringify({ token: "my-secret-key-123" });
  writePrivateFile(file, data);

  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, "utf8"), data);

  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "File must have 0600 mode on POSIX");
  }
});

test("appendPrivateFile appends text and maintains private mode", () => {
  const logFile = join(testDir, "agent-output.log");
  appendPrivateFile(logFile, "line 1\n");
  appendPrivateFile(logFile, "line 2\n");

  assert.equal(readFileSync(logFile, "utf8"), "line 1\nline 2\n");

  if (process.platform !== "win32") {
    const mode = statSync(logFile).mode & 0o777;
    assert.equal(mode, 0o600, "Log file must have 0600 mode on POSIX");
  }
});

test("writeMcpConfig writes mcp-servers.json with 0600 permissions", () => {
  const mcpConfigFile = join(testDir, "mcp-servers.json");
  writeMcpConfig(
    {
      mcpServers: {
        demoServer: {
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret-abc" },
          enabled: true,
          alwaysAllow: false,
          policy: "strict",
          timeoutMs: 30000,
        },
      },
    },
    mcpConfigFile,
  );

  const loaded = readMcpConfig(mcpConfigFile);
  assert.equal(loaded.mcpServers.demoServer.env.API_KEY, "secret-abc");

  if (process.platform !== "win32") {
    const mode = statSync(mcpConfigFile).mode & 0o777;
    assert.equal(mode, 0o600, "MCP config must be 0600 on POSIX");
  }

  // Cleanup
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});
