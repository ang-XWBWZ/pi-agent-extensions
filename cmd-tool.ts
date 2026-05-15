/**
 * cmd-tool extension - provides a `cmd` tool that executes shell commands
 * via cmd.exe (Windows) with real-time streaming output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";

// Buffer limit in bytes (~1MB)
const MAX_OUTPUT_BYTES = 1_000_000;
// Collapse threshold in characters
const COLLAPSE_THRESHOLD = 2000;
// Truncation marker
const TRUNCATION_MARKER = "\n... [output truncated]";
// Preview lines shown when collapsed
const CMD_PREVIEW_LINES = 5;

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cmd",
    label: "cmd",
    description:
      "Execute a shell command via cmd.exe on Windows. Returns stdout, stderr, and exit code. " +
      "Use this for directory listing (dir), file search (where, dir /s), pattern search (findstr), " +
      "or any other Windows shell commands. " +
      `Output limited to ~${Math.round(MAX_OUTPUT_BYTES / 1024)}KB. ` +
      "Long-running commands can be cancelled with the timeout parameter (seconds).",

    promptSnippet: "Execute a command via cmd.exe and return its output",

    promptGuidelines: [
      "Use cmd to run Windows shell commands (dir, findstr, where, type, etc.) instead of bash commands (ls, grep, find, cat).",
      "For path listing use 'dir /b' or 'dir' instead of 'ls'.",
      "For text search use 'findstr /s /i pattern *' instead of 'grep -r'.",
      "For file search use 'dir /s /b filename' or 'where /r . filename' instead of 'find'.",
    ],

    parameters: Type.Object({
      command: Type.String({
        description: "The shell command to execute via cmd.exe /c",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120)",
        })
      ),
    }),

    renderCall(args, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const command =
        typeof args.command === "string" ? args.command : "";
      const timeout = args.timeout;
      const timeoutSuffix = timeout
        ? theme.fg("muted", ` (timeout ${timeout}s)`)
        : "";
      text.setText(
        theme.fg("toolTitle", theme.bold(`> ${command}`)) + timeoutSuffix
      );
      return text;
    },

    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };

      // Track elapsed time
      if (
        state.startedAt !== undefined &&
        options.isPartial &&
        !state.interval
      ) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      // Extract text output
      const rawOutput =
        result.content
          ?.filter((c: { type: string; text?: string }) => c.type === "text")
          .map((c: { type: string; text?: string }) => c.text ?? "")
          .join("\n")
          .trim() ?? "";

      const exitCode = (result.details as any)?.exitCode;
      const hasError =
        context.isError || (exitCode !== undefined && exitCode !== 0);

      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      let displayText = "";

      if (rawOutput) {
        const styledOutput = rawOutput
          .split("\n")
          .map((line) => theme.fg("toolOutput", line))
          .join("\n");

        if (options.expanded || hasError) {
          displayText = `\n${styledOutput}`;
        } else {
          const lines = styledOutput.split("\n");
          if (lines.length <= CMD_PREVIEW_LINES) {
            displayText = `\n${styledOutput}`;
          } else {
            const preview = lines.slice(-CMD_PREVIEW_LINES).join("\n");
            const skipped = lines.length - CMD_PREVIEW_LINES;
            const hint =
              theme.fg("muted", `... (${skipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")})`;
            displayText = `\n${hint}\n${preview}`;
          }
        }

        // Show exit code on error
        if (hasError && exitCode !== undefined) {
          displayText += `\n${theme.fg("error", `Command exited with code ${exitCode}`)}`;
        }
      } else if (hasError) {
        displayText = `\n${theme.fg("error", `Command exited with code ${exitCode}`)}`;
      }

      // Add duration
      if (state.startedAt !== undefined) {
        const label = options.isPartial ? "Elapsed" : "Took";
        const endTime = state.endedAt ?? Date.now();
        displayText += `\n${theme.fg("muted", `${label} ${formatDuration(endTime - state.startedAt)}`)}`;
      }

      text.setText(displayText);
      return text;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return new Promise((resolve) => {
        const effectiveTimeout = Math.min(
          (params.timeout ?? 30) * 1000,
          120_000
        );

        const child = spawn("cmd.exe", ["/c", params.command], {
          cwd: ctx?.cwd ?? process.cwd(),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let byteCount = 0;
        let truncated = false;
        let killed = false;
        let settled = false;

        const timeout = setTimeout(() => {
          killed = true;
          child.kill();
        }, effectiveTimeout);

        const finish = (result: Parameters<typeof resolve>[0]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        };

        // Abort signal
        const onAbort = () => {
          killed = true;
          child.kill();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        // stdout 流式推送，超阈值后折叠
        child.stdout?.on("data", (chunk: Buffer) => {
          if (truncated) return;
          byteCount += chunk.length;
          if (byteCount > MAX_OUTPUT_BYTES) {
            output += TRUNCATION_MARKER;
            truncated = true;
          } else {
            output += chunk.toString("utf8");
          }
          const view =
            output.length > COLLAPSE_THRESHOLD
              ? output.slice(0, COLLAPSE_THRESHOLD) +
                "\n... [running, collapsed]"
              : output;
          onUpdate?.({ content: [{ type: "text", text: view }] });
        });

        // stderr 也流式推送
        child.stderr?.on("data", (chunk: Buffer) => {
          if (truncated) return;
          byteCount += chunk.length;
          if (byteCount > MAX_OUTPUT_BYTES) {
            output += TRUNCATION_MARKER;
            truncated = true;
          } else {
            output += chunk.toString("utf8");
          }
          const view =
            output.length > COLLAPSE_THRESHOLD
              ? output.slice(0, COLLAPSE_THRESHOLD) +
                "\n... [running, collapsed]"
              : output;
          onUpdate?.({ content: [{ type: "text", text: view }] });
        });

        child.on("error", (err) => {
          finish({
            content: [
              {
                type: "text",
                text: `Failed to spawn: ${err.message}`,
              },
            ],
            details: {
              command: params.command,
              exitCode: -1,
              error: err.message,
            },
          });
        });

        child.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);

          if (killed) {
            const isLong = output.length > COLLAPSE_THRESHOLD;
            const reason = signal?.aborted ? "Cancelled" : "Timed out";
            finish({
              content: [
                {
                  type: "text",
                  text: isLong
                    ? `${reason}.\n${output.slice(0, COLLAPSE_THRESHOLD)}\n... [collapsed]`
                    : `${reason}.\n${output || "(no output)"}`,
                },
              ],
              details: {
                command: params.command,
                exitCode: signal?.aborted ? -1 : (code ?? -1),
                cancelled: !!signal?.aborted,
                timedOut: !signal?.aborted,
                fullOutput: isLong ? output : undefined,
              },
            });
            return;
          }

          if (!output.trim()) {
            output = "(no output)";
          }

          const isLong = output.length > COLLAPSE_THRESHOLD;
          finish({
            content: [
              {
                type: "text",
                text: isLong
                  ? output.slice(0, COLLAPSE_THRESHOLD) +
                    "\n... [collapsed — use details to see full output]"
                  : output,
              },
            ],
            details: {
              command: params.command,
              exitCode: code ?? 0,
              truncated,
              fullOutput: isLong ? output : undefined,
            },
          });
        });
      });
    },
  });
}
