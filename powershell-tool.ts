/**
 * powershell-tool extension — provides a `powershell` tool that executes
 * PowerShell commands with native UTF-8 output, Unicode-safe command encoding,
 * and full abort/termination lifecycle management.
 *
 * Key advantages over cmd-tool:
 *   - Native UTF-8 output (no chcp / codepage headaches)
 *   - -EncodedCommand Base64(UTF-16LE) bypasses Node.js spawn ANSI conversion
 *   - Select-String handles mixed-encoding content search
 *   - Full abort state machine: 3-phase check + pipe destroy + PS process cleanup
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================
// 进程树清理 — 与 pi 内核 shell.ts 的 killProcessTree 等价
// ============================================================

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
  }
}

/** PowerShell 进程可能残留（Start-Process 等场景），兜底清理 */
function killResidualPowerShell(): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/IM", "powershell.exe"], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      /* best-effort */
    }
  }
}

// ============================================================
// 输出限制 — 对齐 pi 内核 truncate.ts (50KB / 2000 lines)
// ============================================================

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const TRUNCATION_MARKER =
  "\n\n[Output truncated at ~50KB/2000 lines — full output saved to temp file]";
const PS_PREVIEW_LINES = 5;

/** 预览行内最大字符数（收起状态下行内截断，防止 PowerShell 表格列宽过大） */
const PS_MAX_LINE_CHARS = 100;

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return line.slice(0, maxChars) + "...";
}

// ============================================================
// 工具函数
// ============================================================

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 将 PowerShell 命令编码为 Base64(UTF-16LE)。
 *
 * PowerShell 的 -EncodedCommand 参数接受 UTF-16LE → Base64 编码的命令字符串，
 * 完全绕过 Node.js spawn 在 Windows 上的 ANSI 代码页转换。
 * 这意味着命令中的中文字符、路径、搜索字符串零损伤。
 */
function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

/**
 * 构建带 UTF-8 强制设置和错误处理的完整 PowerShell 命令。
 *
 * 包装策略：
 *   1. $OutputEncoding / [Console]::OutputEncoding → UTF-8
 *   2. $ErrorActionPreference = "Continue" → 不因非终止错误中断
 *   3. 用户命令
 *
 * 注意：格式化字符串（如 "hello"）在 $OutputEncoding=UTF8 下正常输出；
 *       但由外部程序（如 git、node）产生的输出由它们自己控制编码。
 */
function wrapPowerShellCommand(userCommand: string): string {
  return [
    "$OutputEncoding = [System.Text.Encoding]::UTF8;",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "$ErrorActionPreference = 'Continue';",
    "$ProgressPreference = 'SilentlyContinue';",
    `& { ${userCommand} } 2>&1 | Out-String -Width 200`,
  ].join(" ");
}

// ============================================================
// 主扩展
// ============================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "powershell",
    label: "powershell",

    description:
      "Execute a PowerShell command with native UTF-8 output. " +
      "Use this for: reading files with explicit encoding (Get-Content -Encoding), " +
      "searching mixed-encoding content (Select-String), JSON/CSV processing, " +
      "or when cmd-tool produces garbled Chinese output. " +
      `Output limited to ~${Math.round(MAX_OUTPUT_BYTES / 1024)}KB / ${MAX_OUTPUT_LINES} lines (whichever first). ` +
      "When truncated, full output saved to a temp file — use read tool to view it. " +
      "Use the timeout parameter (seconds) to adjust timeout; default 60s (PowerShell startup is slower than cmd), no upper cap.",

    promptSnippet:
      "Execute a PowerShell command with native UTF-8 output",

    promptGuidelines: [
      "Use powershell for: reading files with explicit encoding (Get-Content -Encoding UTF8), searching mixed-encoding files (Select-String), JSON/CSV processing, or when cmd-tool produces garbled Chinese text.",
      "Prefer powershell over cmd for complex pipelines involving non-ASCII text.",
      "Use 'ls' or 'Get-ChildItem' instead of 'dir'. Use 'Select-String' instead of 'findstr'. Use 'gc' or 'Get-Content' instead of 'type'.",
      "For recursive text search: Get-ChildItem -Recurse -File | Select-String -Pattern 'search term'",
      "For reading a file with specific encoding: Get-Content -Path file.txt -Encoding UTF8",
      "For reading a GBK file: Get-Content -Path file.txt -Encoding Default  (uses system ANSI code page, which is GBK on Chinese Windows)",
      "When powershell output is truncated, the full output is saved to a temp file. Use the read tool to view the temp file path listed in the output.",
      // ── 体验 ──
      "Use powershell when cmd garbles output or for structured data (JSON, CSV, objects). It handles UTF-8 natively.",
      "FORBIDDEN: Do NOT use powershell for trivial dir/type/cd commands — cmd is faster for those. PowerShell startup adds ~2s overhead.",
    ],

    parameters: Type.Object({
      command: Type.String({
        description:
          "PowerShell command/script to execute. Outputs UTF-8 natively. No codepage parameter needed.",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Timeout in seconds (default: 60, no upper cap; 0/负数自动兜底到 60)",
        }),
      ),
    }),

    // ============================================================
    // TUI: renderCall — 显示命令调用行
    // ============================================================

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
      const timeout = args.timeout as number | undefined;
      const timeoutSuffix = timeout
        ? theme.fg("muted", ` (timeout ${timeout}s)`)
        : "";
      text.setText(
        theme.fg("toolTitle", theme.bold(`PS> ${command}`)) + timeoutSuffix,
      );
      return text;
    },

    // ============================================================
    // TUI: renderResult — 模式 A (纯 Text)，对齐 cmd-tool / grep
    // ============================================================

    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
        interval?: ReturnType<typeof setInterval>;
      };

      state.endedAt ??= Date.now();

      // 提取文本输出 — PowerShell 也可能产生 \r\n
      const rawOutput =
        result.content
          ?.filter((c: { type: string; text?: string }) => c.type === "text")
          .map((c: { type: string; text?: string }) =>
            (c.text ?? "").replace(/\r/g, ""),
          )
          .join("\n")
          .trim() ?? "";

      const exitCode = (result.details as Record<string, unknown> | undefined)
        ?.exitCode as number | undefined;
      const cancelled = (result.details as Record<string, unknown> | undefined)
        ?.cancelled as boolean | undefined;
      const timedOut = (result.details as Record<string, unknown> | undefined)
        ?.timedOut as boolean | undefined;
      const hasError =
        context.isError ||
        (exitCode !== undefined && exitCode !== 0) ||
        cancelled ||
        timedOut;

      let text = "";

      if (rawOutput) {
        const styledLines = rawOutput
          .split("\n")
          .map((line) => theme.fg("toolOutput", line));

        if (options.expanded || hasError) {
          // 展开模式或错误：全量展示（不截断行内）
          text += "\n" + styledLines.join("\n");
        } else {
          // 折叠模式：限制行数 + 行内截断
          const truncLines = styledLines.map((l) => truncateLine(l, PS_MAX_LINE_CHARS));
          if (truncLines.length <= PS_PREVIEW_LINES) {
            text += "\n" + truncLines.join("\n");
          } else {
            const preview = truncLines.slice(-PS_PREVIEW_LINES);
            const skipped = truncLines.length - PS_PREVIEW_LINES;
            const hint =
              theme.fg("muted", `... (${skipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")})`;
            text += "\n" + hint + "\n" + preview.join("\n");
          }
        }

        // 终止原因（比 exit code 更优先）
        if (cancelled) {
          text +=
            "\n" + theme.fg("warning", "[Command cancelled by user]");
        } else if (timedOut) {
          text +=
            "\n" + theme.fg("warning", "[Command timed out]");
        } else if (hasError && exitCode !== undefined) {
          text +=
            "\n" +
            theme.fg("error", `Command exited with code ${exitCode}`);
        }
      } else if (cancelled) {
        text +=
          "\n" + theme.fg("warning", "[Command cancelled by user]");
      } else if (timedOut) {
        text +=
          "\n" + theme.fg("warning", "[Command timed out — no output produced]");
      } else if (hasError && exitCode !== undefined) {
        text +=
          "\n" +
          theme.fg("error", `Command exited with code ${exitCode} (no output)`);
      } else if (hasError) {
        text += "\n" + theme.fg("error", "[Command failed — no output]");
      }

      // 截断警告
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.truncated) {
        const fullPath = details.fullOutputPath as string | undefined;
        text +=
          "\n" +
          theme.fg(
            "warning",
            fullPath
              ? `[Output truncated. Full output: ${fullPath}]`
              : "[Output truncated]",
          );
      }

      // 耗时
      if (state.startedAt !== undefined) {
        const endTime = state.endedAt ?? Date.now();
        text +=
          "\n" +
          theme.fg("muted", `Took ${formatDuration(endTime - state.startedAt)}`);
      }

      const component = (context.lastComponent as Text) ?? new Text("", 0, 0);
      component.setText(text);
      return component;
    },

    // ============================================================
    // execute — 完整终止状态机
    // ============================================================

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return new Promise((resolve) => {
        // ── 超时处理 ──
        // 默认 60s（PowerShell 启动比 cmd 慢）；AI 可传正数覆盖，无硬上限
        const timeoutSec =
          params.timeout != null &&
          Number.isFinite(params.timeout) &&
          params.timeout > 0
            ? params.timeout
            : 60;

        // ── 命令编码：Base64(UTF-16LE) 绕过 spawn ANSI 转换 ──
        const wrappedCommand = wrapPowerShellCommand(params.command as string);
        const encodedCommand = encodePowerShellCommand(wrappedCommand);

        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-EncodedCommand",
            encodedCommand,
          ],
          {
            cwd: ctx?.cwd ?? process.cwd(),
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        // UTF-8 解码器 — PowerShell 已经强制 $OutputEncoding=UTF8
        const decoder = new TextDecoder("utf-8", { fatal: false });

        let output = "";
        let byteCount = 0;
        let lineCount = 1;
        let truncated = false;
        let savedTempPath: string | undefined;
        let killed = false;
        let settled = false;

        // ── 超时定时器 ──
        const timer = setTimeout(() => {
          killed = true;
          if (child.pid) killProcessTree(child.pid);
          // 兜底：powershell.exe 可能残留
          killResidualPowerShell();
        }, timeoutSec * 1000);

        const finish = (result: Parameters<typeof resolve>[0]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };

        // ========================================================
        // Phase 1: 检查信号是否在 spawn 前已终止
        // ========================================================

        if (signal?.aborted) {
          if (child.pid) killProcessTree(child.pid);
          killResidualPowerShell();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          finish({
            content: [
              {
                type: "text",
                text: "Cancelled (signal already aborted before execution)",
              },
            ],
            details: {
              command: params.command,
              exitCode: -1,
              cancelled: true,
            },
          });
          return;
        }

        // ========================================================
        // Phase 2: 监听 abort 信号 — 运行中打断
        // ========================================================

        const onAbort = () => {
          if (settled) return;
          killed = true;
          clearTimeout(timer);

          // 保存已产生的输出到临时文件，不丢数据
          if (output.length > 0 && !truncated) {
            saveTruncatedOutput(output).then((path) => {
              savedTempPath = path;
            });
          }

          // 杀进程树
          if (child.pid) killProcessTree(child.pid);
          killResidualPowerShell();

          // ★ 强制摧毁管道：Windows 上 child.kill() 只杀主进程，
          // 孙进程可能继续持有 stdout pipe，导致 close 事件永不触发
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        // Phase 2 清理：进程正常退出时移除监听
        function cleanupAbort() {
          signal?.removeEventListener("abort", onAbort);
        }

        // ========================================================
        // 辅助：保存完整输出到临时文件
        // ========================================================

        async function saveTruncatedOutput(
          fullOutput: string,
        ): Promise<string | undefined> {
          try {
            const tempDir = join(tmpdir(), "pi-powershell");
            const timestamp = Date.now();
            const rand = Math.random().toString(36).slice(2, 6);
            const tempFile = join(
              tempDir,
              `ps-output-${timestamp}-${rand}.log`,
            );
            await mkdir(tempDir, { recursive: true });
            await writeFile(tempFile, fullOutput, "utf8");
            return tempFile;
          } catch {
            return undefined;
          }
        }

        // ========================================================
        // 流式数据接收
        // ========================================================

        const onOutputData = (chunk: Buffer) => {
          if (truncated) {
            // 截断后仍追加到完整缓冲（供保存），但不再推送
            const text = decoder.decode(chunk, { stream: true });
            output += text;
            lineCount += (text.match(/\n/g) || []).length;
            return;
          }
          byteCount += chunk.length;
          const text = decoder.decode(chunk, { stream: true });
          output += text;
          lineCount += (text.match(/\n/g) || []).length;

          // 截断检测
          if (
            byteCount > MAX_OUTPUT_BYTES ||
            lineCount > MAX_OUTPUT_LINES
          ) {
            output += TRUNCATION_MARKER;
            truncated = true;
            const fullSnapshot = output;
            saveTruncatedOutput(fullSnapshot).then((path) => {
              savedTempPath = path;
            });
          }
        };

        child.stdout?.on("data", onOutputData);
        child.stderr?.on("data", onOutputData);

        // ========================================================
        // spawn 错误
        // ========================================================

        child.on("error", (err) => {
          cleanupAbort();
          finish({
            content: [
              {
                type: "text",
                text: `Failed to spawn PowerShell: ${err.message}`,
              },
            ],
            details: {
              command: params.command,
              exitCode: -1,
              error: err.message,
            },
          });
        });

        // ========================================================
        // Phase 3: 进程退出处理
        // ========================================================

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
              setTimeout(() => {
                clearInterval(poll);
                if (!settled) finalize();
              }, 2000);
            } else {
              finalize();
            }
            return;
          }

          // ── 正常退出 ──

          if (!output.trim()) {
            output = "(no output)";
          }

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
