/**
 * cmd-tool extension - provides a `cmd` tool that executes shell commands
 * via cmd.exe (Windows) with real-time streaming output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, execSync } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 跨平台进程树清理（与 pi 内核 shell.ts 的 killProcessTree 等价）*/
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true }); } catch { /* */ }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
  }
}

// Buffer limits — aligned with pi core truncate.ts (50KB / 2000 lines, whichever first)
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
// Truncation marker (matches pi core bash tool style)
const TRUNCATION_MARKER = "\n\n[Output truncated at ~50KB/2000 lines — full output saved to temp file]";
// Preview lines shown when collapsed
const CMD_PREVIEW_LINES = 5;

// 代码页到 TextDecoder encoding label 的映射
const ENCODING_LABELS: Record<number, string> = {
  65001: "utf-8",
  936: "gbk",
  950: "big5",
  932: "shift-jis",
  949: "euc-kr",
  1251: "windows-1251",
  1252: "windows-1252",
  874: "windows-874",
};

// 启动时检测一次系统活动代码页
const SYSTEM_CODEPAGE: number = (() => {
  try {
    const buf = execSync("chcp", { encoding: "buffer", timeout: 3000 });
    const match = buf.toString("utf8").match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 65001;
  } catch {
    return 65001;
  }
})();

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function codepageToEncoding(codepage: number): string {
  return ENCODING_LABELS[codepage] ?? "utf-8";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cmd",
    label: "cmd",
    description:
      "Execute a shell command via cmd.exe on Windows. Returns stdout, stderr, and exit code. " +
      "Use this for directory listing (dir), file search (where, dir /s), pattern search (findstr), " +
      "or any other Windows shell commands. " +
      `Output limited to ~${Math.round(MAX_OUTPUT_BYTES / 1024)}KB / ${MAX_OUTPUT_LINES} lines (whichever first). ` +
      "When truncated, full output saved to a temp file — use read tool to view it. " +
      "Use the timeout parameter (seconds) to adjust timeout; default 30s, no upper cap. " +
      "Use the codepage parameter for encoding: defaults to system code page; use 936 for GBK on Chinese Windows.",

    promptSnippet: "Execute a command via cmd.exe and return its output",

    promptGuidelines: [
      "Use cmd to run Windows shell commands (dir, findstr, where, type, etc.) instead of bash commands (ls, grep, find, cat).",
      "For path listing use 'dir /b' or 'dir' instead of 'ls'.",
      "For text search use 'findstr /s /i pattern *' instead of 'grep -r'.",
      "For file search use 'dir /s /b filename' or 'where /r . filename' instead of 'find'.",
      "When cmd output is truncated, the full output is saved to a temp file. Use the read tool to view the temp file path listed in the output.",
      "Use codepage parameter for encoding: defaults to system code page; use 936 for GBK on Chinese Windows.",
    ],

    parameters: Type.Object({
      command: Type.String({
        description: "The shell command to execute via cmd.exe /c",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, no upper cap; 0/负数自动兜底到 30)",
        })
      ),
      codepage: Type.Optional(
        Type.Number({
          description: "Code page for cmd.exe output encoding (defaults to system code page; use 936 for GBK on Chinese Windows)",
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

      state.endedAt ??= Date.now();

      // Extract text output — strip \r (Windows cmd.exe uses \r\n,
      // and \r causes TUI padding spaces to overwrite line text)
      const rawOutput =
        result.content
          ?.filter((c: { type: string; text?: string }) => c.type === "text")
          .map((c: { type: string; text?: string }) => (c.text ?? "").replace(/\r/g, ""))
          .join("\n")
          .trim() ?? "";

      const exitCode = (result.details as any)?.exitCode;
      const hasError =
        context.isError || (exitCode !== undefined && exitCode !== 0);

      // Format all output as a single string — matches grep/read pattern
      let text = "";

      if (rawOutput) {
        const styledLines = rawOutput
          .split("\n")
          .map((line) => theme.fg("toolOutput", line));

        if (options.expanded || hasError) {
          text += "\n" + styledLines.join("\n");
        } else {
          if (styledLines.length <= CMD_PREVIEW_LINES) {
            text += "\n" + styledLines.join("\n");
          } else {
            const preview = styledLines.slice(-CMD_PREVIEW_LINES);
            const skipped = styledLines.length - CMD_PREVIEW_LINES;
            const hint =
              theme.fg("muted", `... (${skipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")})`;
            text += "\n" + hint + "\n" + preview.join("\n");
          }
        }

        if (hasError && exitCode !== undefined) {
          text += "\n" + theme.fg("error", `Command exited with code ${exitCode}`);
        }
      } else if (hasError) {
        text += "\n" + theme.fg("error", `Command exited with code ${exitCode}`);
      }

      // Truncation warning
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.truncated) {
        const fullPath = details.fullOutputPath as string | undefined;
        text += "\n" + theme.fg("warning",
          fullPath
            ? `[Output truncated. Full output: ${fullPath}]`
            : "[Output truncated]");
      }

      // Duration
      if (state.startedAt !== undefined) {
        const endTime = state.endedAt ?? Date.now();
        text += "\n" + theme.fg("muted", `Took ${formatDuration(endTime - state.startedAt)}`);
      }

      const component = (context.lastComponent as Text) ?? new Text("", 0, 0);
      component.setText(text);
      return component;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return new Promise((resolve) => {
        // 默认 30s 超时；AI 可传正数覆盖，无硬上限。非法值（0/负数/非数字）兜底到 30s
        const timeoutSec = (params.timeout != null && Number.isFinite(params.timeout) && params.timeout > 0)
          ? params.timeout
          : 30;

        // 编码处理：默认跟随系统代码页；用 TextDecoder 按指定编码解码
        const codepage = (params.codepage != null && Number.isFinite(params.codepage) && params.codepage > 0)
          ? params.codepage
          : SYSTEM_CODEPAGE;
        const encodingLabel = codepageToEncoding(codepage);
        const decoder = new TextDecoder(encodingLabel, { fatal: false });

        const child = spawn("cmd.exe", ["/c", params.command], {
          cwd: ctx?.cwd ?? process.cwd(),
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let byteCount = 0;
        let lineCount = 1;
        let truncated = false;
        let savedTempPath: string | undefined;
        let killed = false;
        let settled = false;

        const timer = setTimeout(() => {
          killed = true;
          if (child.pid) killProcessTree(child.pid);
        }, timeoutSec * 1000);

        const finish = (result: Parameters<typeof resolve>[0]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        // === 可打断机制 ===

        // 1) 如果信号已经处于终止状态，直接提前结束
        if (signal?.aborted) {
          if (child.pid) killProcessTree(child.pid);
          finish({
            content: [{ type: "text", text: "Cancelled (signal already aborted before execution)" }],
            details: { command: params.command, exitCode: -1, cancelled: true },
          });
          return;
        }

        // 2) 监听 agent 打断信号（用户按 Ctrl+C / LLM 调用中断）
        const onAbort = () => {
          if (settled) return;
          killed = true;
          clearTimeout(timer);
          // 保存已产生的输出到临时文件，不丢数据
          if (output.length > 0 && !truncated) {
            saveTruncatedOutput(output);
          }
          if (child.pid) killProcessTree(child.pid);
          // ★ 强制摧毁管道：Windows 上 child.kill() 只杀 cmd.exe，
          // 孙进程（如 ping -t, start 的后台进程）可能变成孤儿继续持有 stdout pipe，
          // 导致 close 事件永不触发，agent loop 永久卡死。
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        // 3) 进程退出的兜底清理
        function cleanupAbort() {
          signal?.removeEventListener("abort", onAbort);
        }

        // 保存完整输出到临时文件（pi 内核风格：os.tmpdir()）
        async function saveTruncatedOutput(fullOutput: string): Promise<string | undefined> {
          try {
            const tempDir = join(tmpdir(), "pi-cmd");
            const timestamp = Date.now();
            const rand = Math.random().toString(36).slice(2, 6);
            const tempFile = join(tempDir, `cmd-output-${timestamp}-${rand}.log`);
            await mkdir(tempDir, { recursive: true });
            await writeFile(tempFile, fullOutput, "utf8");
            return tempFile;
          } catch {
            return undefined;
          }
        }

        const onOutputData = (chunk: Buffer) => {
          if (truncated) {
            // 截断后仍追加到完整缓冲（用于保存到文件），但不再流式推
            const text = decoder.decode(chunk, { stream: true });
            output += text;
            lineCount += (text.match(/\n/g) || []).length;
            return;
          }
          byteCount += chunk.length;
          const text = decoder.decode(chunk, { stream: true });
          output += text;
          lineCount += (text.match(/\n/g) || []).length;
          if (byteCount > MAX_OUTPUT_BYTES || lineCount > MAX_OUTPUT_LINES) {
            output += TRUNCATION_MARKER;
            truncated = true;
            // 异步保存完整输出
            const fullSnapshot = output;
            saveTruncatedOutput(fullSnapshot).then((path) => {
              savedTempPath = path;
            });
          }
        };

        child.stdout?.on("data", onOutputData);
        child.stderr?.on("data", onOutputData);

        child.on("error", (err) => {
          cleanupAbort();
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
          cleanupAbort();
          // 刷新 TextDecoder 缓冲中剩余的字节
          output += decoder.decode();

          if (killed) {
            const killedDetails: Record<string, unknown> = {
              command: params.command,
              exitCode: signal?.aborted ? -1 : (code ?? -1),
              cancelled: !!signal?.aborted,
              timedOut: !signal?.aborted,
            };
            // 打断时可能 saveTruncatedOutput 还没写完，等一下
            const finalize = () => {
              if (truncated && savedTempPath) {
                killedDetails.truncated = true;
                killedDetails.fullOutputPath = savedTempPath;
              }
              finish({
                content: [
                  {
                    type: "text",
                    text: output || "(no output)",
                  },
                ],
                details: killedDetails,
              });
            };
            // 如果正在异步保存截断输出，最多等 2s
            if (savedTempPath === undefined && truncated) {
              const poll = setInterval(() => {
                if (savedTempPath !== undefined || settled) {
                  clearInterval(poll);
                  if (!settled) finalize();
                }
              }, 50);
              setTimeout(() => { clearInterval(poll); if (!settled) finalize(); }, 2000);
            } else {
              finalize();
            }
            return;
          }

          if (!output.trim()) {
            output = "(no output)";
          }

          // 截断信息放 details，content 保持完整输出（对齐 bash.ts）
          const details: Record<string, unknown> = {
            command: params.command,
            exitCode: code ?? 0,
          };

          if (truncated && savedTempPath) {
            details.truncated = true;
            details.fullOutputPath = savedTempPath;
          }

          finish({
            content: [{ type: "text", text: output }],
            details,
          });
        });
      });
    },
  });
}
