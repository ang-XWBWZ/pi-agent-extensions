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
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionContext, withPiExecutionEnv } from "./lib/execution-context.js";
import { afterCommand, beforeCommand } from "./lib/work-goal-recorder.js";
import { renderCommandToolCall, renderToolResult } from "./lib/tui-render.js";

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

/**
 * 安全地清理特定 PowerShell 进程树。
 *
 * 使用 taskkill /PID <pid> 按进程 ID 精确杀进程，
 * 绝不会错杀用户的独立 PowerShell 窗口。
 *
 * 兜底链路：
 *   1. 先 taskkill /T /PID childPid 杀进程树
 *   2. 子进程可能已经变成了孤儿（Start-Process 场景），
 *      但我们有 child.pid 就不应该出现其他同名进程被误杀。
 */
function killSpecificPowerShell(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
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

// ============================================================
// 工具函数
// ============================================================

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function resultText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return text || undefined;
}

function resultExitCode(result: unknown): number | null | undefined {
  const details = (result as { details?: Record<string, unknown> }).details;
  const exitCode = details?.exitCode;
  return typeof exitCode === "number" ? exitCode : undefined;
}

function resultError(result: unknown): unknown {
  const details = (result as { details?: Record<string, unknown> }).details;
  return details?.error;
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
      "Use powershell for Windows-native object pipelines, UTF-8 or mixed-encoding text, and JSON/CSV processing.",
      "Prefer read or rg over powershell for ordinary source inspection, and cmd for simple Windows builtins.",
      "When powershell output is truncated or times out, narrow the command before retrying.",
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
      };
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      return renderCommandToolCall(theme, context, "PS>", args.command, [
        { name: "timeout", value: args.timeout, tone: "muted" },
      ]);
    },

    // ============================================================
    // TUI: renderResult — 模式 A (纯 Text)，对齐 cmd-tool / grep
    // ============================================================

    renderResult(result, options, theme, context) {
      const state = context.state as {
        startedAt?: number;
        endedAt?: number;
      };
      state.endedAt ??= Date.now();
      const details = result.details as Record<string, unknown> | undefined;
      const exitCode = details?.exitCode as number | undefined;
      const cancelled = details?.cancelled === true;
      const timedOut = details?.timedOut === true;
      const hasError =
        context.isError ||
        (exitCode !== undefined && exitCode !== 0) ||
        cancelled ||
        timedOut;
      const annotations: Array<{ text: string; tone: "muted" | "warning" | "error" }> = [];
      if (cancelled) annotations.push({ text: "Command cancelled by user", tone: "warning" });
      else if (timedOut) annotations.push({ text: "Command timed out", tone: "warning" });
      else if (hasError && exitCode !== undefined) annotations.push({ text: `Command exited with code ${exitCode}`, tone: "error" });
      if (details?.truncated) {
        const fullPath = details.fullOutputPath as string | undefined;
        annotations.push({
          text: fullPath ? `Output truncated. Full output: ${fullPath}` : "Output truncated",
          tone: "warning",
        });
      }
      if (state.startedAt !== undefined) {
        const endTime = state.endedAt ?? Date.now();
        annotations.push({ text: `Took ${formatDuration(endTime - state.startedAt)}`, tone: "muted" });
      }
      return renderToolResult(result, options, theme, context, {
        previewLines: PS_PREVIEW_LINES,
        isError: hasError,
        emptyText: hasError ? "Command failed — no output" : undefined,
        annotations,
      });
    },

    // ============================================================
    // execute — 完整终止状态机
    // ============================================================

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = String(params.command ?? "");
      const cwd = ctx?.cwd ?? process.cwd();
      const execCtx = getExecutionContext();
      const started = await beforeCommand({ command, cwd });

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
        const wrappedCommand = wrapPowerShellCommand(command);
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
            cwd,
            env: withPiExecutionEnv(process.env, execCtx),
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
          if (child.pid) {
            killProcessTree(child.pid);
            killSpecificPowerShell(child.pid);
          }
        }, timeoutSec * 1000);

        const finish = (result: Parameters<typeof resolve>[0]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void afterCommand({
            command,
            cwd,
            goalId: started.goalId,
            startedAt: started.startedAt,
            exitCode: resultExitCode(result),
            stdout: resultText(result),
            error: resultError(result),
          }).finally(() => resolve(result));
        };

        // ========================================================
        // Phase 1: 检查信号是否在 spawn 前已终止
        // ========================================================

        if (signal?.aborted) {
          if (child.pid) {
            killProcessTree(child.pid);
            killSpecificPowerShell(child.pid);
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({
            content: [
              {
                type: "text",
                text: "Cancelled (signal already aborted before execution)",
              },
            ],
            details: {
              command,
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
          if (child.pid) {
            killProcessTree(child.pid);
            killSpecificPowerShell(child.pid);
          }

          // ★ 强制摧毁管道：Windows 上 child.kill() 只杀主进程，
          // 孙进程可能继续持有 stdout pipe，导致 close 事件永不触发
          child.stdout?.destroy();
          child.stderr?.destroy();
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

        // stderr 独立解码，用 [stderr] 行前缀标记
        // 不进入 byteCount/lineCount 截断计数（stderr 通常较短）
        const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = stderrDecoder.decode(chunk, { stream: true });
          const prefixed = text
            .split("\n")
            .map((l, idx) => (idx > 0 && l.trim() ? "[stderr] " + l : l))
            .join("\n");
          output += prefixed;
        });
        child.stdout?.on("data", onOutputData);

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
              command,
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
              command,
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
            command,
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
