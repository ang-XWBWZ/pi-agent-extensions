/**
 * Pi-style extension tool rendering.
 *
 * The public Pi APIs provide the current expanded state and key hint. This
 * helper intentionally uses those APIs instead of hard-coded Ctrl+O text or
 * physical-line slicing so custom tools behave like built-in tool rows.
 */

import { Container, getKeybindings, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { compactToolValue, getToolTextOutput, hasDisplayValue } from "./tui-format.js";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

function formatKey(key: string): string {
  return key
    .split("/")
    .map((part) =>
      part
        .split("+")
        .map((piece) => {
          const display =
            typeof process !== "undefined" &&
            process.platform === "darwin" &&
            piece.toLowerCase() === "alt"
              ? "option"
              : piece;
          return display.charAt(0).toUpperCase() + display.slice(1);
        })
        .join("+"),
    )
    .join("/");
}

/** Render the active Pi tool-expansion key without importing Pi private UI modules. */
export function toolExpandHint(theme: ThemeLike, description = "to expand"): string {
  let key = "Ctrl+O";
  try {
    const keys = getKeybindings().getKeys("app.tools.expand");
    if (keys.length > 0) key = formatKey(keys.join("/"));
  } catch {
    // The fallback retains the documented default if a non-interactive host has no keymap.
  }
  return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}


type ToolExpansionApi = {
  getToolsExpanded?: (() => boolean) | boolean;
  setToolsExpanded?: (expanded: boolean) => void;
};

const LEGACY_TOOLS_EXPANDED_KEY = "__pi_extension_tools_expanded";

function legacyToolsExpanded(): boolean {
  return (globalThis as Record<string, unknown>)[LEGACY_TOOLS_EXPANDED_KEY] === true;
}

/**
 * Read Pi's global tool-expansion state when the host exposes it.
 * Older hosts do not include this extension API yet, so retain a shared
 * extension-side value instead of throwing from a Widget render callback.
 */
export function getToolsExpandedState(pi: unknown): boolean {
  const api = pi as ToolExpansionApi | undefined;
  try {
    if (typeof api?.getToolsExpanded === "function") {
      return api.getToolsExpanded.call(api) === true;
    }
    if (typeof api?.getToolsExpanded === "boolean") return api.getToolsExpanded;
  } catch {
    // A partially compatible host should use the safe extension fallback.
  }
  return legacyToolsExpanded();
}

/**
 * Set the native state when available and always remember a safe fallback for
 * older Pi hosts. The return value signals whether the native API was used.
 */
export function setToolsExpandedState(pi: unknown, expanded: boolean): boolean {
  const api = pi as ToolExpansionApi | undefined;
  let usedNativeApi = false;
  try {
    if (typeof api?.setToolsExpanded === "function") {
      api.setToolsExpanded.call(api, expanded);
      usedNativeApi = true;
    }
  } catch {
    // Preserve the fallback state even if a compatibility bridge rejects it.
  }
  (globalThis as Record<string, unknown>)[LEGACY_TOOLS_EXPANDED_KEY] = expanded;
  return usedNativeApi;
}

type RenderContextLike = {
  lastComponent?: unknown;
  expanded?: boolean;
  isError?: boolean;
};

type ResultOptionsLike = {
  expanded?: boolean;
};

export type ToolCallField = {
  name: string;
  value: unknown;
  tone?: "accent" | "toolOutput" | "muted" | "warning" | "error";
  /** Never render the actual value (for example API keys). */
  sensitive?: boolean;
  /** Maximum display length while the tool row is collapsed. */
  maxLength?: number;
};

export type ToolResultAnnotation = {
  text: string;
  tone?: "muted" | "warning" | "error" | "success";
};

export type ToolResultRenderConfig = {
  /** Number of visual output lines visible before global tool expansion. */
  previewLines?: number;
  /** Override textual output when a tool has an unusual result shape. */
  output?: string;
  /** Errors should retain their complete diagnostic output by default. */
  isError?: boolean;
  emptyText?: string;
  annotations?: ToolResultAnnotation[];
};

function renderField(theme: ThemeLike, field: ToolCallField, expanded: boolean): string {
  if (!hasDisplayValue(field.value)) return "";
  const collapsedMax = field.maxLength ?? 96;
  const value = field.sensitive
    ? "[redacted]"
    : compactToolValue(field.value, expanded ? Math.max(collapsedMax, 420) : collapsedMax);
  const tone = field.sensitive ? "warning" : field.tone ?? "toolOutput";
  return `${theme.fg("muted", `${field.name}=`)}${theme.fg(tone, value)}`;
}

/** Build a compact, field-aware call line for structured tools. */
export function formatStructuredToolCall(
  theme: ThemeLike,
  toolName: string,
  fields: ToolCallField[],
  expanded = false,
): string {
  const parts = fields
    .map((field) => renderField(theme, field, expanded))
    .filter(Boolean);
  const title = theme.fg("toolTitle", theme.bold(toolName));
  return parts.length > 0 ? `${title} ${parts.join(" ")}` : title;
}

/** Reuse Pi's tool-row component lifecycle for a structured call line. */
export function renderStructuredToolCall(
  theme: ThemeLike,
  context: RenderContextLike,
  toolName: string,
  fields: ToolCallField[],
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(formatStructuredToolCall(theme, toolName, fields, context.expanded === true));
  return text;
}

/** A Pi-style shell command line with the command and optional metadata separated by color. */
export function renderCommandToolCall(
  theme: ThemeLike,
  context: RenderContextLike,
  prefix: string,
  command: unknown,
  fields: ToolCallField[] = [],
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const commandValue = compactToolValue(command, context.expanded ? 800 : 220) || "…";
  const metadata = fields
    .map((field) => renderField(theme, field, context.expanded === true))
    .filter(Boolean)
    .join(" ");
  const call =
    theme.fg("toolTitle", theme.bold(`${prefix} `)) +
    theme.fg("accent", commandValue) +
    (metadata ? ` ${metadata}` : "");
  text.setText(call);
  return text;
}

/** Detect conventional extension result errors that do not set isError directly. */
export function isToolResultError(result: unknown, context: RenderContextLike): boolean {
  if (context.isError === true) return true;
  const details = (result as { details?: unknown })?.details;
  if (!details || typeof details !== "object") return false;
  const record = details as Record<string, unknown>;
  return record.isError === true || record.error === true || typeof record.error === "string";
}

function buildResultLines(
  output: string,
  width: number,
  expanded: boolean,
  isError: boolean,
  previewLines: number,
  annotations: ToolResultAnnotation[],
  emptyText: string | undefined,
  theme: ThemeLike,
): string[] {
  const safeWidth = Math.max(1, width);
  const styledOutput = output
    ? output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")
    : "";
  const visualLines = styledOutput ? new Text(styledOutput, 0, 0).render(safeWidth) : [];
  const resultLines: string[] = [];

  if (visualLines.length > 0) {
    resultLines.push("");
    if (expanded || isError || visualLines.length <= previewLines) {
      resultLines.push(...visualLines);
    } else {
      const hidden = visualLines.length - previewLines;
      const hint =
        theme.fg("muted", `... (${hidden} earlier lines,`) +
        ` ${toolExpandHint(theme)}${theme.fg("muted", ")")}`;
      resultLines.push(truncateToWidth(hint, safeWidth, "..."));
      resultLines.push(...visualLines.slice(-previewLines));
    }
  } else if (emptyText) {
    resultLines.push("", theme.fg(isError ? "error" : "muted", emptyText));
  }

  for (const annotation of annotations) {
    resultLines.push("", theme.fg(annotation.tone ?? "muted", annotation.text));
  }
  return resultLines;
}

/**
 * Render a result using visual-line tail previews and the global Pi expansion
 * state. It deliberately keeps errors fully visible for diagnosis.
 */
export function renderToolResult(
  result: unknown,
  options: ResultOptionsLike,
  theme: ThemeLike,
  context: RenderContextLike,
  config: ToolResultRenderConfig = {},
): Container {
  const container = context.lastComponent instanceof Container
    ? context.lastComponent
    : new Container();
  const output = config.output === undefined ? getToolTextOutput(result) : config.output;
  const previewLines = Math.max(1, Math.floor(config.previewLines ?? 8));
  const isError = config.isError ?? isToolResultError(result, context);
  const annotations = config.annotations ?? [];

  container.clear();
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  container.addChild({
    render(width: number) {
      if (cachedWidth !== width) {
        cachedWidth = width;
        cachedLines = buildResultLines(
          output,
          width,
          options.expanded === true,
          isError,
          previewLines,
          annotations,
          config.emptyText,
          theme,
        );
      }
      return cachedLines;
    },
    invalidate() {
      cachedWidth = -1;
      cachedLines = [];
    },
  });
  return container;
}
