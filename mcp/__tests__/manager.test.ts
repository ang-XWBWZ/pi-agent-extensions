import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpManager, type McpConnection } from "../lib/manager.ts";
import { defaultMcpConfigPath, readMcpConfig } from "../lib/config.ts";

function temporaryConfig(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
  return {
    path: join(dir, "servers.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("default MCP config stays under the Pi agent home on Windows and Linux", () => {
  const homeDirectory = join(tmpdir(), "pi-home");
  const path = defaultMcpConfigPath({
    APPDATA: "C:\\Users\\pi\\AppData\\Roaming",
    XDG_CONFIG_HOME: "/home/pi/.config",
    HOME: "/home/pi",
  }, homeDirectory);
  assert.equal(path, join(homeDirectory, ".pi", "agent", "mcp-servers.json"));
  assert.equal(
    defaultMcpConfigPath({ PI_MCP_CONFIG: "custom-mcp.json" }, homeDirectory),
    resolve("custom-mcp.json"),
  );
});

test("McpManager persists safe server definitions and preserves no environment values in summaries", () => {
  const temp = temporaryConfig();
  try {
    const manager = new McpManager({ configPath: temp.path, connect: async () => { throw new Error("not used"); } });
    const added = manager.addServer("pwiki", {
      command: "node",
      args: ["pwiki-mcp.js"],
      env: { WIKI_HOME: "D:\\private\\wiki", API_TOKEN: "secret-value" },
      alias: "wiki",
      policy: "pwiki",
    });
    assert.equal(added.name, "pwiki");
    assert.equal(added.alias, "wiki");
    assert.equal(added.alwaysAllow, false);
    assert.deepEqual(added.envKeys, ["API_TOKEN", "WIKI_HOME"]);
    assert.deepEqual(readMcpConfig(temp.path).mcpServers.pwiki?.args, ["pwiki-mcp.js"]);
    assert.deepEqual(manager.listAliases(), [{ alias: "wiki", server: "pwiki" }]);
    assert.equal(manager.resolveAlias("wiki"), "pwiki");

    const alwaysAllowed = manager.setAlwaysAllowed("pwiki", true);
    assert.equal(alwaysAllowed.alwaysAllow, true);
    assert.equal(manager.isAlwaysAllowed("pwiki"), true);

    const updated = manager.updateServer("pwiki", { enabled: false, timeoutMs: 30_000 });
    assert.equal(updated.enabled, false);
    assert.equal(updated.timeoutMs, 30_000);
    assert.equal(updated.alwaysAllow, true);
    assert.equal(manager.isAlwaysAllowed("pwiki"), false);
    assert.deepEqual(manager.listAliases(), []);
    assert.equal(manager.classifyCall("pwiki", "wiki_search", {}), "read");
    assert.equal(manager.classifyCall("pwiki", "wiki_modify_entry", {}), "persistent");
    assert.equal(manager.classifyCall("pwiki", "wiki_unload", { path: "D:\\notes" }), "destructive");
    assert.equal(manager.classifyCall("pwiki", "unrecognized", {}), "unknown");
  } finally {
    temp.cleanup();
  }
});

test("McpManager lists and calls only tools advertised by the configured server", async () => {
  const temp = temporaryConfig();
  let closed = 0;
  const calls: Array<{ tool: string; argumentsValue: Record<string, unknown> }> = [];
  const fakeConnection: McpConnection = {
    pid: 4321,
    listTools: async () => [{ name: "wiki_status", description: "status", inputSchema: {} }],
    callTool: async (tool, argumentsValue) => {
      calls.push({ tool, argumentsValue });
      return { text: "ready", isError: false };
    },
    close: async () => { closed++; },
  };
  try {
    const manager = new McpManager({ configPath: temp.path, connect: async () => fakeConnection });
    manager.addServer("pwiki", { command: "node", policy: "pwiki" });
    assert.deepEqual(await manager.listTools("pwiki"), [{ name: "wiki_status", description: "status", inputSchema: {} }]);
    assert.deepEqual(await manager.callTool("pwiki", "wiki_status", {}), { text: "ready", isError: false });
    assert.deepEqual(calls, [{ tool: "wiki_status", argumentsValue: {} }]);
    await assert.rejects(() => manager.callTool("pwiki", "missing", {}), /not exposed/);
    assert.equal((manager.status("pwiki")[0] ?? {}).connected, true);
    assert.equal(await manager.disconnect("pwiki"), 1);
    assert.equal(closed, 1);
  } finally {
    temp.cleanup();
  }
});

test("McpManager discovers server instructions, prompts, and only listed resources", async () => {
  const temp = temporaryConfig();
  const promptCalls: Array<{ name: string; argumentsValue: Record<string, string> }> = [];
  const resourceCalls: string[] = [];
  const fakeConnection: McpConnection = {
    serverInfo: () => ({
      implementationName: "documentation-server",
      implementationVersion: "1.2.3",
      instructions: "Read the catalog before selecting an operation.",
      capabilities: { tools: true, prompts: true, resources: true },
    }),
    listTools: async () => [{
      name: "lookup",
      title: "Lookup documentation",
      description: "Find an entry",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    }],
    callTool: async () => ({ text: "unused", isError: false }),
    listPrompts: async () => [{
      name: "onboard",
      description: "Explain the safe workflow",
      arguments: [{ name: "topic", required: true }],
    }],
    getPrompt: async (name, argumentsValue) => {
      promptCalls.push({ name, argumentsValue });
      return {
        description: "Onboarding instructions",
        messages: [{ role: "user", content: { type: "text", text: "Use the documented workflow." } }],
      };
    },
    listResources: async () => [{
      uri: "docs://usage",
      name: "Usage guide",
      mimeType: "text/markdown",
      size: 42,
    }],
    listResourceTemplates: async () => [{
      uriTemplate: "docs://topics/{name}",
      name: "Topic guide",
      mimeType: "text/markdown",
    }],
    readResource: async (uri) => {
      resourceCalls.push(uri);
      return { contents: [{ uri, mimeType: "text/markdown", text: "# Usage" }] };
    },
    close: async () => undefined,
  };
  try {
    const manager = new McpManager({ configPath: temp.path, connect: async () => fakeConnection });
    manager.addServer("docs", { command: "node" });

    const catalog = await manager.catalog("docs");
    assert.equal(catalog.server.instructions, "Read the catalog before selecting an operation.");
    assert.deepEqual(catalog.tools[0]?.outputSchema, { type: "object" });
    assert.deepEqual(catalog.prompts.map((prompt) => prompt.name), ["onboard"]);
    assert.deepEqual(catalog.resources.map((resource) => resource.uri), ["docs://usage"]);
    assert.deepEqual(catalog.resourceTemplates.map((template) => template.uriTemplate), ["docs://topics/{name}"]);

    assert.deepEqual(
      await manager.getPrompt("docs", "onboard", { topic: "MCP" }),
      {
        description: "Onboarding instructions",
        messages: [{ role: "user", content: { type: "text", text: "Use the documented workflow." } }],
      },
    );
    assert.deepEqual(promptCalls, [{ name: "onboard", argumentsValue: { topic: "MCP" } }]);

    assert.deepEqual(
      await manager.readResource("docs", "docs://usage"),
      { contents: [{ uri: "docs://usage", mimeType: "text/markdown", text: "# Usage" }] },
    );
    assert.deepEqual(resourceCalls, ["docs://usage"]);
    await assert.rejects(() => manager.readResource("docs", "docs://topics/private"), /not listed/);
    assert.deepEqual(resourceCalls, ["docs://usage"]);
  } finally {
    temp.cleanup();
  }
});
