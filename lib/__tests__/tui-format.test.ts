import assert from "node:assert/strict";
import test from "node:test";
import {
  compactToolValue,
  getToolTextOutput,
  normalizeToolText,
} from "../tui-format.ts";

test("tool text normalization removes carriage returns and terminal control sequences", () => {
  assert.equal(normalizeToolText("one\r\ntwo\u001b[31m!\u001b[0m\u0007"), "one\ntwo!");
});

test("tool result extraction joins textual blocks and excludes non-text content", () => {
  assert.equal(
    getToolTextOutput({
      content: [
        { type: "text", text: "first\r" },
        { type: "image", data: "ignored" },
        { type: "text", text: "second" },
      ],
    }),
    "first\nsecond",
  );
});

test("tool argument previews are single-line, Unicode-safe, and bounded", () => {
  assert.equal(compactToolValue("line one\nline two", 40), "line one ↵ line two");
  assert.equal(compactToolValue("😀😀😀😀", 3), "😀😀…");
  assert.equal(compactToolValue({ action: "status", ids: [1, 2] }, 80), '{"action":"status","ids":[1,2]}');
});
