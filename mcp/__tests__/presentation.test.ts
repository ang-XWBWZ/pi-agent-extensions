import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMcpCallCommand,
  previewMcpCallResult,
} from "../lib/presentation.ts";

test("MCP call presentation includes the server, tool, JSON arguments, and a tail preview", () => {
  assert.equal(
    formatMcpCallCommand("pwiki", "wiki_search", { query: "CORS" }),
    'mcp call pwiki wiki_search {"query":"CORS"}',
  );
  assert.deepEqual(
    previewMcpCallResult("1\n2\n3\n4\n5\n6\n7", 3),
    { lines: ["5", "6", "7"], hiddenLineCount: 4 },
  );
});
