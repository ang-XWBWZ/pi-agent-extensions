import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertServerName,
  defaultMcpConfigPath,
  mergeServerConfig,
  normalizeServerConfig,
  readMcpConfig,
  summarizeServer,
  writeMcpConfig,
  type McpConfigFile,
  type McpServerConfig,
  type McpServerPatch,
  type McpServerSummary,
} from "./config.js";
import { classifyMcpToolEffect, type McpToolEffect } from "./policy.js";

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpServerInfo {
  implementationName?: string;
  implementationVersion?: string;
  instructions?: string;
  capabilities: {
    tools: boolean;
    prompts: boolean;
    resources: boolean;
  };
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments: McpPromptArgument[];
}

export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string; binary?: true }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string; size?: number }
  | { type: "unknown" };

export interface McpPromptResult {
  description?: string;
  messages: Array<{ role: "user" | "assistant"; content: McpPromptContent }>;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceCatalog {
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
}

export interface McpResourceResult {
  contents: Array<{ uri: string; mimeType?: string; text?: string; binary?: true }>;
}

export interface McpCatalog {
  server: McpServerInfo;
  tools: McpToolInfo[];
  prompts: McpPromptInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  structuredContent?: unknown;
}

export interface McpConnection {
  listTools(signal?: AbortSignal): Promise<McpToolInfo[]>;
  callTool(tool: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
  readonly pid?: number | null;
  serverInfo?(): McpServerInfo;
  listPrompts?(signal?: AbortSignal): Promise<McpPromptInfo[]>;
  getPrompt?(name: string, argumentsValue: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult>;
  listResources?(signal?: AbortSignal): Promise<McpResourceInfo[]>;
  listResourceTemplates?(signal?: AbortSignal): Promise<McpResourceTemplateInfo[]>;
  readResource?(uri: string, signal?: AbortSignal): Promise<McpResourceResult>;
}

export interface McpManagerOptions {
  configPath?: string;
  connect?: (server: McpServerConfig) => Promise<McpConnection>;
}

interface ActiveConnection {
  fingerprint: string;
  connection: McpConnection;
  queue: Promise<void>;
}

interface PendingConnection {
  fingerprint: string;
  promise: Promise<ActiveConnection>;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncate(value: string, max = 16_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… output truncated`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeTool(rawTool: unknown): McpToolInfo | undefined {
  const tool = toRecord(rawTool);
  const name = tool && optionalString(tool.name);
  if (!tool || !name) return undefined;
  const title = optionalString(tool.title);
  const description = optionalString(tool.description);
  const inputSchema = toRecord(tool.inputSchema);
  const outputSchema = toRecord(tool.outputSchema);
  const annotations = toRecord(tool.annotations);
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

function normalizePrompt(rawPrompt: unknown): McpPromptInfo | undefined {
  const prompt = toRecord(rawPrompt);
  const name = prompt && optionalString(prompt.name);
  if (!prompt || !name) return undefined;
  const argumentsValue = Array.isArray(prompt.arguments) ? prompt.arguments : [];
  const argumentsList = argumentsValue.flatMap((rawArgument) => {
    const argument = toRecord(rawArgument);
    const argumentName = argument && optionalString(argument.name);
    if (!argument || !argumentName) return [];
    const description = optionalString(argument.description);
    return [{
      name: argumentName,
      ...(description ? { description } : {}),
      required: argument.required === true,
    }];
  });
  const title = optionalString(prompt.title);
  const description = optionalString(prompt.description);
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    arguments: argumentsList,
  };
}

function normalizeResource(rawResource: unknown): McpResourceInfo | undefined {
  const resource = toRecord(rawResource);
  const uri = resource && optionalString(resource.uri);
  const name = resource && optionalString(resource.name);
  if (!resource || !uri || !name) return undefined;
  const title = optionalString(resource.title);
  const description = optionalString(resource.description);
  const mimeType = optionalString(resource.mimeType);
  const size = optionalSize(resource.size);
  return {
    uri,
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size === undefined ? {} : { size }),
  };
}

function normalizeResourceTemplate(rawTemplate: unknown): McpResourceTemplateInfo | undefined {
  const template = toRecord(rawTemplate);
  const uriTemplate = template && optionalString(template.uriTemplate);
  const name = template && optionalString(template.name);
  if (!template || !uriTemplate || !name) return undefined;
  const title = optionalString(template.title);
  const description = optionalString(template.description);
  const mimeType = optionalString(template.mimeType);
  return {
    uriTemplate,
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizePromptContent(rawContent: unknown): McpPromptContent {
  const content = toRecord(rawContent);
  const type = content && optionalString(content.type);
  if (!content || !type) return { type: "unknown" };
  if (type === "text" && typeof content.text === "string") {
    return { type: "text", text: truncate(content.text) };
  }
  if (type === "image" || type === "audio") {
    const mimeType = optionalString(content.mimeType);
    return { type, ...(mimeType ? { mimeType } : {}) };
  }
  if (type === "resource") {
    const resource = toRecord(content.resource);
    const uri = resource && optionalString(resource.uri);
    if (!resource || !uri) return { type: "unknown" };
    const mimeType = optionalString(resource.mimeType);
    if (typeof resource.text === "string") {
      return { type: "resource", uri, ...(mimeType ? { mimeType } : {}), text: truncate(resource.text) };
    }
    return { type: "resource", uri, ...(mimeType ? { mimeType } : {}), binary: true };
  }
  if (type === "resource_link") {
    const uri = optionalString(content.uri);
    if (!uri) return { type: "unknown" };
    const name = optionalString(content.name);
    const description = optionalString(content.description);
    const mimeType = optionalString(content.mimeType);
    const size = optionalSize(content.size);
    return {
      type: "resource_link",
      uri,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(size === undefined ? {} : { size }),
    };
  }
  return { type: "unknown" };
}

function normalizePromptResult(rawResult: unknown): McpPromptResult {
  const result = toRecord(rawResult);
  const messagesValue = result && Array.isArray(result.messages) ? result.messages : [];
  const messages: McpPromptResult["messages"] = [];
  for (const rawMessage of messagesValue) {
    const message = toRecord(rawMessage);
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    messages.push({
      role: message.role as "user" | "assistant",
      content: normalizePromptContent(message.content),
    });
  }
  const description = result && optionalString(result.description);
  return { ...(description ? { description } : {}), messages };
}

function normalizeResourceResult(rawResult: unknown): McpResourceResult {
  const result = toRecord(rawResult);
  const contentsValue = result && Array.isArray(result.contents) ? result.contents : [];
  const contents: McpResourceResult["contents"] = [];
  for (const rawContent of contentsValue) {
    const content = toRecord(rawContent);
    const uri = content && optionalString(content.uri);
    if (!content || !uri) continue;
    const mimeType = optionalString(content.mimeType);
    if (typeof content.text === "string") {
      contents.push({ uri, ...(mimeType ? { mimeType } : {}), text: truncate(content.text) });
      continue;
    }
    contents.push({ uri, ...(mimeType ? { mimeType } : {}), binary: true });
  }
  return { contents };
}

async function collectPages<T>(
  field: string,
  request: (cursor?: string) => Promise<Record<string, unknown>>,
  normalize: (value: unknown) => T | undefined,
): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await request(cursor);
    const entries = Array.isArray(page[field]) ? page[field] : [];
    for (const entry of entries) {
      const normalized = normalize(entry);
      if (normalized) values.push(normalized);
    }
    cursor = optionalString(page.nextCursor);
  } while (cursor);
  return values;
}

function fallbackServerInfo(connection: McpConnection): McpServerInfo {
  return {
    capabilities: {
      tools: true,
      prompts: !!connection.listPrompts,
      resources: !!connection.listResources,
    },
  };
}

function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    const item = toRecord(block);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "image") {
      parts.push(`[MCP returned image${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`);
      continue;
    }
    if (item.type === "audio") {
      parts.push(`[MCP returned audio${typeof item.mimeType === "string" ? `: ${item.mimeType}` : ""}]`);
      continue;
    }
    parts.push(`[MCP returned ${typeof item.type === "string" ? item.type : "content"}]`);
  }

  const structured = result.structuredContent;
  if (structured !== undefined) {
    try {
      parts.push(`Structured result:\n${truncate(JSON.stringify(structured, null, 2), 8_000)}`);
    } catch {
      parts.push("Structured result was returned but could not be serialized.");
    }
  }
  return truncate(parts.join("\n\n") || "MCP tool returned no content.");
}

async function connectStdio(server: McpServerConfig): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    ...(server.cwd ? { cwd: server.cwd } : {}),
    stderr: "pipe",
  });
  // Consume stderr so a noisy server cannot block on a full pipe. Error text is
  // deliberately not surfaced because it can contain server-side secrets.
  transport.stderr?.on("data", () => undefined);

  const client = new Client({ name: "pi-mcp-bridge", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: server.timeoutMs });
  } catch (error) {
    try { await transport.close(); } catch { /* best effort */ }
    throw error;
  }

  const capabilities = client.getServerCapabilities();
  const implementation = client.getServerVersion();
  const instructions = client.getInstructions();
  const serverInfo: McpServerInfo = {
    ...(optionalString(implementation?.name) ? { implementationName: implementation!.name } : {}),
    ...(optionalString(implementation?.version) ? { implementationVersion: implementation!.version } : {}),
    ...(instructions ? { instructions: truncate(instructions) } : {}),
    capabilities: {
      tools: capabilities?.tools !== undefined,
      prompts: capabilities?.prompts !== undefined,
      resources: capabilities?.resources !== undefined,
    },
  };

  return {
    get pid() { return transport.pid; },
    serverInfo: () => serverInfo,
    async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
      return collectPages(
        "tools",
        async (cursor) => client.listTools(
          cursor ? { cursor } : undefined,
          { signal, timeout: server.timeoutMs },
        ) as unknown as Record<string, unknown>,
        normalizeTool,
      );
    },
    async listPrompts(signal?: AbortSignal): Promise<McpPromptInfo[]> {
      if (!serverInfo.capabilities.prompts) throw new Error("MCP server does not expose prompt templates.");
      return collectPages(
        "prompts",
        async (cursor) => client.listPrompts(
          cursor ? { cursor } : undefined,
          { signal, timeout: server.timeoutMs },
        ) as unknown as Record<string, unknown>,
        normalizePrompt,
      );
    },
    async getPrompt(name, argumentsValue, signal): Promise<McpPromptResult> {
      if (!serverInfo.capabilities.prompts) throw new Error("MCP server does not expose prompt templates.");
      const result = await client.getPrompt(
        { name, ...(Object.keys(argumentsValue).length > 0 ? { arguments: argumentsValue } : {}) },
        { signal, timeout: server.timeoutMs },
      );
      return normalizePromptResult(result);
    },
    async listResources(signal?: AbortSignal): Promise<McpResourceInfo[]> {
      if (!serverInfo.capabilities.resources) throw new Error("MCP server does not expose resources.");
      return collectPages(
        "resources",
        async (cursor) => client.listResources(
          cursor ? { cursor } : undefined,
          { signal, timeout: server.timeoutMs },
        ) as unknown as Record<string, unknown>,
        normalizeResource,
      );
    },
    async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateInfo[]> {
      if (!serverInfo.capabilities.resources) throw new Error("MCP server does not expose resources.");
      return collectPages(
        "resourceTemplates",
        async (cursor) => client.listResourceTemplates(
          cursor ? { cursor } : undefined,
          { signal, timeout: server.timeoutMs },
        ) as unknown as Record<string, unknown>,
        normalizeResourceTemplate,
      );
    },
    async readResource(uri, signal): Promise<McpResourceResult> {
      if (!serverInfo.capabilities.resources) throw new Error("MCP server does not expose resources.");
      const result = await client.readResource({ uri }, { signal, timeout: server.timeoutMs });
      return normalizeResourceResult(result);
    },
    async callTool(tool, argumentsValue, signal): Promise<McpCallResult> {
      const raw = await client.callTool(
        { name: tool, arguments: argumentsValue },
        undefined,
        { signal, timeout: server.timeoutMs },
      ) as unknown as Record<string, unknown>;
      return {
        text: resultText(raw),
        isError: raw.isError === true,
        ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
      };
    },
    close: () => client.close(),
  };
}

export class McpManager {
  readonly configPath: string;
  private readonly connect: (server: McpServerConfig) => Promise<McpConnection>;
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly pending = new Map<string, PendingConnection>();

  constructor(options: McpManagerOptions = {}) {
    this.configPath = options.configPath ?? defaultMcpConfigPath();
    this.connect = options.connect ?? connectStdio;
  }

  readConfig(): McpConfigFile {
    return readMcpConfig(this.configPath);
  }

  listServers(): McpServerSummary[] {
    return Object.entries(this.readConfig().mcpServers)
      .map(([name, server]) => summarizeServer(name, server))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  status(name?: string): Array<McpServerSummary & { connected: boolean; pid?: number | null }> {
    const summaries = this.listServers();
    const filtered = name ? summaries.filter((item) => item.name === assertServerName(name)) : summaries;
    return filtered.map((summary) => {
      const active = this.connections.get(summary.name);
      return {
        ...summary,
        connected: !!active,
        ...(active ? { pid: active.connection.pid ?? null } : {}),
      };
    });
  }

  addServer(name: string, server: McpServerConfig | McpServerPatch): McpServerSummary {
    const normalizedName = assertServerName(name);
    const config = this.readConfig();
    if (config.mcpServers[normalizedName]) {
      throw new Error(`MCP server already exists: ${normalizedName}. Use update instead.`);
    }
    const normalized = normalizeServerConfig(server, `mcpServers.${normalizedName}`);
    config.mcpServers[normalizedName] = normalized;
    writeMcpConfig(config, this.configPath);
    return summarizeServer(normalizedName, normalized);
  }

  updateServer(name: string, patch: McpServerPatch): McpServerSummary {
    const normalizedName = assertServerName(name);
    const config = this.readConfig();
    const existing = config.mcpServers[normalizedName];
    if (!existing) throw new Error(`Unknown MCP server: ${normalizedName}`);
    const updated = mergeServerConfig(existing, patch);
    config.mcpServers[normalizedName] = updated;
    writeMcpConfig(config, this.configPath);
    void this.disconnect(normalizedName);
    return summarizeServer(normalizedName, updated);
  }

  removeServer(name: string): McpServerSummary {
    const normalizedName = assertServerName(name);
    const config = this.readConfig();
    const existing = config.mcpServers[normalizedName];
    if (!existing) throw new Error(`Unknown MCP server: ${normalizedName}`);
    delete config.mcpServers[normalizedName];
    writeMcpConfig(config, this.configPath);
    void this.disconnect(normalizedName);
    return summarizeServer(normalizedName, existing);
  }

  setEnabled(name: string, enabled: boolean): McpServerSummary {
    return this.updateServer(name, { enabled });
  }

  setAlwaysAllowed(name: string, alwaysAllow: boolean): McpServerSummary {
    return this.updateServer(name, { alwaysAllow });
  }

  isAlwaysAllowed(name: string): boolean {
    try {
      return this.serverConfig(name).alwaysAllow;
    } catch {
      return false;
    }
  }

  async disconnect(name?: string): Promise<number> {
    const targets = name ? [assertServerName(name)] : [...this.connections.keys()];
    let closed = 0;
    for (const target of targets) {
      const active = this.connections.get(target);
      this.connections.delete(target);
      if (!active) continue;
      try { await active.connection.close(); } catch { /* best effort */ }
      closed++;
    }
    return closed;
  }

  async closeAll(): Promise<void> {
    await this.disconnect();
  }

  classifyCall(serverName: string, tool: string, argumentsValue: unknown): McpToolEffect {
    try {
      const normalized = assertServerName(serverName);
      const server = this.readConfig().mcpServers[normalized];
      if (!server) return "unknown";
      return classifyMcpToolEffect(server.policy, tool, argumentsValue);
    } catch {
      return "unknown";
    }
  }

  async listTools(serverName: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
    return this.run(serverName, signal, (connection) => connection.listTools(signal));
  }

  async getServerInfo(serverName: string, signal?: AbortSignal): Promise<McpServerInfo> {
    return this.run(serverName, signal, async (connection) => connection.serverInfo?.() ?? fallbackServerInfo(connection));
  }

  async describeTool(serverName: string, toolName: string, signal?: AbortSignal): Promise<McpToolInfo> {
    const tools = await this.listTools(serverName, signal);
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`MCP tool ${toolName} is not exposed by server ${serverName}. Use mcp_discover action=tools first.`);
    }
    return tool;
  }

  async listPrompts(serverName: string, signal?: AbortSignal): Promise<McpPromptInfo[]> {
    return this.run(serverName, signal, (connection) => {
      const info = connection.serverInfo?.() ?? fallbackServerInfo(connection);
      if (!info.capabilities.prompts || !connection.listPrompts) {
        throw new Error(`MCP server ${serverName} does not expose prompt templates.`);
      }
      return connection.listPrompts(signal);
    });
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    argumentsValue: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    const prompts = await this.listPrompts(serverName, signal);
    if (!prompts.some((item) => item.name === promptName)) {
      throw new Error(`MCP prompt ${promptName} is not exposed by server ${serverName}. Use mcp_discover action=prompts first.`);
    }
    return this.run(serverName, signal, (connection) => {
      if (!connection.getPrompt) throw new Error(`MCP server ${serverName} does not expose prompt templates.`);
      return connection.getPrompt(promptName, argumentsValue, signal);
    });
  }

  async listResources(serverName: string, signal?: AbortSignal): Promise<McpResourceCatalog> {
    return this.run(serverName, signal, async (connection) => {
      const info = connection.serverInfo?.() ?? fallbackServerInfo(connection);
      if (!info.capabilities.resources || !connection.listResources) {
        throw new Error(`MCP server ${serverName} does not expose resources.`);
      }
      const resources = await connection.listResources(signal);
      const resourceTemplates = connection.listResourceTemplates
        ? await connection.listResourceTemplates(signal)
        : [];
      return { resources, resourceTemplates };
    });
  }

  async readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<McpResourceResult> {
    const catalog = await this.listResources(serverName, signal);
    if (!catalog.resources.some((item) => item.uri === uri)) {
      throw new Error(`MCP resource ${uri} is not listed by server ${serverName}. Read only an exact URI returned by mcp_discover action=resources.`);
    }
    return this.run(serverName, signal, (connection) => {
      if (!connection.readResource) throw new Error(`MCP server ${serverName} does not expose resources.`);
      return connection.readResource(uri, signal);
    });
  }

  async catalog(serverName: string, signal?: AbortSignal): Promise<McpCatalog> {
    const server = await this.getServerInfo(serverName, signal);
    const [tools, prompts, resourceCatalog] = await Promise.all([
      server.capabilities.tools ? this.listTools(serverName, signal) : Promise.resolve([]),
      server.capabilities.prompts ? this.listPrompts(serverName, signal) : Promise.resolve([]),
      server.capabilities.resources ? this.listResources(serverName, signal) : Promise.resolve({ resources: [], resourceTemplates: [] }),
    ]);
    return {
      server,
      tools,
      prompts,
      resources: resourceCatalog.resources,
      resourceTemplates: resourceCatalog.resourceTemplates,
    };
  }

  async callTool(
    serverName: string,
    tool: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const tools = await this.listTools(serverName, signal);
    if (!tools.some((item) => item.name === tool)) {
      throw new Error(`MCP tool ${tool} is not exposed by server ${serverName}. Use mcp_manage action=tools first.`);
    }
    return this.run(serverName, signal, (connection) => connection.callTool(tool, argumentsValue, signal));
  }

  safeError(serverName: string | undefined, error: unknown): string {
    let text = error instanceof Error ? error.message : String(error);
    if (serverName) {
      try {
        for (const value of Object.values(this.serverConfig(serverName).env)) {
          if (value.length >= 4) text = text.split(value).join("[redacted]");
        }
      } catch { /* config may be malformed */ }
    }
    return truncate(text, 2_000);
  }

  private serverConfig(name: string): McpServerConfig {
    const normalized = assertServerName(name);
    const server = this.readConfig().mcpServers[normalized];
    if (!server) throw new Error(`Unknown MCP server: ${normalized}`);
    if (!server.enabled) throw new Error(`MCP server is disabled: ${normalized}`);
    return server;
  }

  private async connectionFor(name: string): Promise<ActiveConnection> {
    const normalized = assertServerName(name);
    const server = this.serverConfig(normalized);
    const fingerprint = JSON.stringify(server);
    const active = this.connections.get(normalized);
    if (active?.fingerprint === fingerprint) return active;
    if (active) {
      this.connections.delete(normalized);
      try { await active.connection.close(); } catch { /* best effort */ }
    }

    const pending = this.pending.get(normalized);
    if (pending?.fingerprint === fingerprint) return pending.promise;

    const promise = this.connect(server).then((connection) => {
      const created: ActiveConnection = { fingerprint, connection, queue: Promise.resolve() };
      this.connections.set(normalized, created);
      return created;
    });
    this.pending.set(normalized, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.pending.get(normalized)?.promise === promise) this.pending.delete(normalized);
    }
  }

  private async run<T>(
    serverName: string,
    signal: AbortSignal | undefined,
    operation: (connection: McpConnection) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("MCP operation aborted");
    const active = await this.connectionFor(serverName);
    const previous = active.queue;
    let release: (() => void) | undefined;
    active.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw new Error("MCP operation aborted");
      return await operation(active.connection);
    } finally {
      release?.();
    }
  }
}
