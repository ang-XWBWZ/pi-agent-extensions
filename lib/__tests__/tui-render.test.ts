import assert from "node:assert/strict";
import test from "node:test";
import {
  formatStructuredToolCall,
  renderToolResult,
  getToolsExpandedState,
  setToolsExpandedState,
} from "../tui-render.ts";

const theme = {
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

test("structured calls preserve field names and redact sensitive values", () => {
  const text = formatStructuredToolCall(theme, "manage_providers", [
    { name: "action", value: "register", tone: "warning" },
    { name: "provider", value: "demo", tone: "accent" },
    { name: "apiKey", value: "secret-value", sensitive: true },
  ]);

  assert.equal(
    text,
    "manage_providers action=register provider=demo apiKey=[redacted]",
  );
  assert.equal(text.includes("secret-value"), false);
});


test("tool expansion state falls back safely when a host omits the API", () => {
  const legacyHost = {};

  assert.equal(setToolsExpandedState(legacyHost, true), false);
  assert.equal(getToolsExpandedState(legacyHost), true);
  assert.equal(setToolsExpandedState(legacyHost, false), false);
  assert.equal(getToolsExpandedState(legacyHost), false);

  let nativeValue = true;
  const nativeHost = {
    getToolsExpanded() {
      return nativeValue;
    },
    setToolsExpanded(expanded: boolean) {
      nativeValue = expanded;
    },
  };
  assert.equal(getToolsExpandedState(nativeHost), true);
  assert.equal(setToolsExpandedState(nativeHost, false), true);
  assert.equal(getToolsExpandedState(nativeHost), false);
});

test("collapsed result rows keep only visual-line tail with Pi expansion hint", () => {
  const result = {
    content: [{ type: "text", text: "first\nsecond\nthird\nfourth" }],
  };
  const collapsed = renderToolResult(result, { expanded: false }, theme, {}, {
    previewLines: 2,
  });

  assert.deepEqual(collapsed.render(80), [
    "",
    "... (2 earlier lines, Ctrl+O to expand)",
    "third",
    "fourth",
  ]);

  const expanded = renderToolResult(
    result,
    { expanded: true },
    theme,
    { lastComponent: collapsed },
    { previewLines: 2 },
  );
  assert.deepEqual(expanded.render(80), ["", "first", "second", "third", "fourth"]);
});

test("structured error flags automatically preserve full diagnostics", () => {
  const result = {
    content: [{ type: "text", text: "first\nsecond\nthird" }],
    details: { error: "upstream disconnected" },
  };
  const rendered = renderToolResult(result, { expanded: false }, theme, {}, {
    previewLines: 1,
  });

  assert.deepEqual(rendered.render(80), ["", "first", "second", "third"]);
});

test("error results do not hide earlier diagnostics", () => {
  const result = {
    content: [{ type: "text", text: "first\nsecond\nthird" }],
  };
  const rendered = renderToolResult(result, { expanded: false }, theme, {}, {
    previewLines: 1,
    isError: true,
  });

  assert.deepEqual(rendered.render(80), ["", "first", "second", "third"]);
});
