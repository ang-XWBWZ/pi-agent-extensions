import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type McpServerPolicy = "strict" | "pwiki";

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  /** Skip normal confirmation for locally classified persistent calls in WORK. */
  alwaysAllow: boolean;
  policy: McpServerPolicy;
  timeoutMs: number;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export type McpServerPatch = Partial<McpServerConfig>;

export interface McpServerSummary {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  enabled: boolean;
  alwaysAllow: boolean;
  policy: McpServerPolicy;
  timeoutMs: number;
  envKeys: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new McpConfigError(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim());
}

function asEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new McpConfigError("env must be an object of strings");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || typeof item !== "string") {
      throw new McpConfigError("env must contain non-empty string keys and string values");
    }
    env[key] = item;
  }
  return env;
}

function asPolicy(value: unknown): McpServerPolicy {
  if (value === undefined) return "strict";
  if (value === "strict" || value === "pwiki") return value;
  throw new McpConfigError("policy must be strict or pwiki");
}

function asTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1_000 || value > 600_000) {
    throw new McpConfigError("timeoutMs must be between 1000 and 600000");
  }
  return Math.floor(value);
}

export function assertServerName(name: string): string {
  const normalized = name.trim();
  if (!SERVER_NAME.test(normalized)) {
    throw new McpConfigError("server name must use letters, numbers, _ or -, up to 64 characters");
  }
  return normalized;
}

export function defaultMcpConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const override = env.PI_MCP_CONFIG?.trim();
  if (override) return resolve(override);

  return join(homeDirectory, ".pi", "agent", "mcp-servers.json");
}

export function normalizeServerConfig(value: unknown, name = "server"): McpServerConfig {
  if (!isRecord(value)) throw new McpConfigError(`${name} must be an object`);
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") throw new McpConfigError(`${name}.enabled must be boolean`);
  const alwaysAllow = value.alwaysAllow === undefined ? false : value.alwaysAllow;
  if (typeof alwaysAllow !== "boolean") throw new McpConfigError(`${name}.alwaysAllow must be boolean`);

  const cwd = value.cwd === undefined ? undefined : requireString(value.cwd, `${name}.cwd`);
  return {
    command: requireString(value.command, `${name}.command`),
    args: value.args === undefined ? [] : asStringArray(value.args, `${name}.args`),
    env: value.env === undefined ? {} : asEnvironment(value.env),
    ...(cwd ? { cwd } : {}),
    enabled,
    alwaysAllow,
    policy: asPolicy(value.policy),
    timeoutMs: asTimeout(value.timeoutMs),
  };
}

export function emptyMcpConfig(): McpConfigFile {
  return { mcpServers: {} };
}

export function readMcpConfig(path = defaultMcpConfigPath()): McpConfigFile {
  if (!existsSync(path)) return emptyMcpConfig();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new McpConfigError(`Cannot parse MCP config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
    throw new McpConfigError(`MCP config ${path} must contain an mcpServers object`);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(raw.mcpServers)) {
    mcpServers[assertServerName(name)] = normalizeServerConfig(server, `mcpServers.${name}`);
  }
  return { mcpServers };
}

export function writeMcpConfig(config: McpConfigFile, path = defaultMcpConfigPath()): void {
  const checked: McpConfigFile = { mcpServers: {} };
  for (const [name, server] of Object.entries(config.mcpServers)) {
    checked.mcpServers[assertServerName(name)] = normalizeServerConfig(server, `mcpServers.${name}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(checked, null, 2)}\n`, "utf-8");
}

export function summarizeServer(name: string, server: McpServerConfig): McpServerSummary {
  return {
    name,
    command: server.command,
    args: [...server.args],
    ...(server.cwd ? { cwd: server.cwd } : {}),
    enabled: server.enabled,
    alwaysAllow: server.alwaysAllow,
    policy: server.policy,
    timeoutMs: server.timeoutMs,
    envKeys: Object.keys(server.env).sort(),
  };
}

export function mergeServerConfig(existing: McpServerConfig, patch: McpServerPatch): McpServerConfig {
  const merged: Record<string, unknown> = {
    ...existing,
    ...patch,
  };
  return normalizeServerConfig(merged);
}
