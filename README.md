# Pi Agent Extensions

A collection of extensions for the [pi coding agent](https://github.com/earendil-works/pi) that add sub-agent parallelism, Windows shell support, model switching, and observability — without modifying pi's core.

## Overview

pi ships with four built-in tools: `read`, `write`, `edit`, and `bash`. These extensions layer additional capabilities on top via the Extension API:

| Extension | File | Purpose |
|-----------|------|---------|
| Sub-Agent System | `parallel-agent.ts` | Dispatch parallel sub-agents for multi-file analysis |
| Agent Message Bus | `lib/agent-bus.ts` | Cross-session EventEmitter for inter-agent communication |
| Confirm Dialog Bus | `lib/confirm-bus.ts` | Route sub-agent confirmation dialogs to the main session |
| Windows Command Tool | `cmd-tool.ts` | Execute commands via `cmd.exe` on Windows |
| Windows PowerShell Tool | `powershell-tool.ts` | Execute PowerShell commands with native UTF-8 output |
| Model Switching | `model-switch.ts` | Switch between AI models at runtime |
| Work Mode Manager | `work-mode.ts` | Plan/Work/YOLO modes with execution plan panel and path guards |
| Context Usage | `context-usage.ts` | `/context` command showing token usage breakdown |
| Token Stats | `token-stats.ts` | Status bar indicator for context window usage |

## Extensions

### parallel-agent.ts — Sub-Agent System (v8)

Dispatches background sub-agents for parallel task execution. Results are automatically injected into the main conversation when all sub-tasks complete.

**Tools provided:**

| Tool | Description |
|------|-------------|
| `spawn_agent` | Launch sub-agents with context injection and skill loading |
| `check_agent_results` | Poll progress, wait for completion, or list all jobs |
| `send_agent_message` | Send messages between agents (broadcast or point-to-point) |
| `control_agent` | Lifecycle management: kill, abort, pause, resume, status |

Requires `lib/agent-bus.ts` and `lib/confirm-bus.ts`.

### cmd-tool.ts — Windows Command Execution

Provides a `cmd` tool that runs commands via `cmd.exe /c`. Handles encoding by detecting the system's active code page at startup and prepending `chcp <codepage> >nul &` to each command to keep the shell output encoding consistent with the decoder.

**Parameters:** `command` (required), `timeout` (optional, default 30s), `codepage` (optional, defaults to system code page; use 65001 for UTF-8, 936 for GBK).

**Key behaviors:**
- Output truncated at 2000 lines / 50KB (whichever first), full output saved to a temp file
- Three-phase abort: pre-spawn check, runtime signal listener, post-close cleanup
- `\r` stripped from output to prevent TUI rendering artifacts

### powershell-tool.ts — Windows PowerShell Execution

Provides a `powershell` tool with native UTF-8 support. Commands are encoded as Base64 (UTF-16LE) and passed via `-EncodedCommand`, bypassing Node.js `spawn`'s ANSI code page conversion on Windows.

**Advantages over cmd-tool:**
- Native UTF-8 output — no code page parameter needed
- `Select-String` handles mixed-encoding content search
- `Get-Content -Encoding` for explicit encoding control
- Base64 command encoding prevents corruption of non-ASCII characters in command strings

**Parameters:** `command` (required), `timeout` (optional, default 60s).

**Internal wrapper applied to every command:**
```powershell
$OutputEncoding = [System.Text.Encoding]::UTF8;
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$ErrorActionPreference = 'Continue';
$ProgressPreference = 'SilentlyContinue';
& { <user command> } 2>&1 | Out-String -Width 200
```

**Known limitation:** `exit N` inside PowerShell pipelines may not propagate correctly through `Out-String`. For native commands (git, node, etc.), `$LASTEXITCODE` is preserved.

### work-mode.ts — Work Mode Manager (v3)

Implements three execution modes controlled via `globalThis.__pi_default_mode`:

| Mode | Behavior |
|------|----------|
| `plan` | Generate plan first, await confirmation, then execute |
| `work` | Direct execution with path guards (default) |
| `yolo` | Full automation, no confirmations |

**Execution plan panel** uses a logical step model where each step has an independent lifecycle: `pending → current → done | error | skipped`. The AI controls the panel through the `manage_plan` tool.

**Path guards** intercept `tool_call` events and block `write`/`edit` operations on protected paths: `node_modules/`, `.git/`, `.pi/`, `.agents/`, `.claude/`.

### model-switch.ts — Model Switching

Registers a `switch_model` tool that allows the AI to change its model at runtime. Lists available models when called without arguments; switches when called with `provider` and `model`.

Default model is read from `settings.json`.

### context-usage.ts & token-stats.ts — Observability

- `context-usage.ts`: Registers `/context` command displaying a breakdown of token usage across system prompt, skills, and conversation context.
- `token-stats.ts`: Adds a persistent status bar widget showing context window usage as a percentage ring.

## Deployment

### Prerequisites

- [pi coding agent](https://github.com/earendil-works/pi) installed
- Node.js ≥ 18

### Install

Clone this repository and copy the files to pi's extensions directory:

**Windows (PowerShell):**
```powershell
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git
cd pi-agent-extensions

$dst = "$env:USERPROFILE\.pi\agent\extensions"
New-Item -ItemType Directory -Force "$dst\lib"
Copy-Item *.ts $dst
Copy-Item lib\*.ts "$dst\lib"
```

**Linux / macOS:**
```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git
cd pi-agent-extensions

DST="$HOME/.pi/agent/extensions"
mkdir -p "$DST/lib"
cp *.ts "$DST/"
cp lib/*.ts "$DST/lib/"
```

### Activate

In your pi session, run:

```
/reload
```

This unloads existing extensions and loads all `.ts` files from the extensions directory.

### Verify

Ask the AI to use one of the extension tools. For example:

```
> List files in the current directory using cmd
> What's my context usage? (/context)
> Switch to a different model
```

If the tool executes successfully, the extension is working.

### Configuration

- **Default model**: Edit `settings.json` in the extensions directory to set `defaultProvider` and `defaultModel`.
- **Work mode**: Set `__pi_default_mode` in your pi configuration to `"plan"`, `"work"`, or `"yolo"`.
- **AI behavior**: Copy `SYSTEM.md` to pi's skills or configuration directory to apply behavioral constraints to the AI agent. See below.

### Installing SYSTEM.md

`SYSTEM.md` defines rules the AI follows during every session — no unauthorized file operations, mandatory user confirmation for risky actions, working directory boundaries, etc.

Place it where pi loads system-level instructions. Typically one of:

- `~/.pi/agent/SYSTEM.md`
- Your project root as `CLAUDE.md` or `AGENTS.md`
- pi's configured system prompt directory

After placing the file, `/reload` to apply.

## Compatibility

These extensions use pi's public Extension API (`registerTool`, `registerCommand`, lifecycle events) and do not modify pi's source code. They depend on packages bundled with pi:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

Global singletons (`globalThis.__pi_agent_bus`, `globalThis.__pi_confirm_bus`) are used for cross-session communication. This is incompatible with ISOLATE mode.

## Project Structure

```
github-dist/
├── README.md
├── SYSTEM.md
├── cmd-tool.ts
├── context-usage.ts
├── model-switch.ts
├── parallel-agent.ts
├── powershell-tool.ts
├── token-stats.ts
├── work-mode.ts
└── lib/
    ├── agent-bus.ts
    └── confirm-bus.ts
```

## License

MIT
