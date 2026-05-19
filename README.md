# Pi Agent Extensions

> **Engineering-grade extensions for the pi coding agent.** Adds sub-agent parallelism, Windows dual-shell, mode-based execution control, observability, model hot-switching, and a wiki knowledge base — without modifying pi's kernel.

---

## Native vs Extended: At a Glance

pi ships with only four built-in tools (`read` / `write` / `edit` / `bash`). Here's what the extensions add:

| Dimension | pi Native | With Extensions |
|-----------|:---------:|:----------------|
| **Available tools** | 4 | **12** (8 new AI tools + 4 native) |
| **User commands** | 0 custom | **17** (`/plan`, `/wiki-search`, `/context`, etc.) |
| **Parallel execution** | ❌ Serial only | ✅ `spawn_agent` dispatches N sub-agents in background |
| **Windows support** | ❌ `bash` has poor encoding, garbled Chinese | ✅ `cmd` + `powershell` dual engine, native UTF-8 / smart GBK |
| **Execution control** | ❌ No mode concept, AI free-for-all | ✅ Plan → Confirm → Work → YOLO three modes + safety guards |
| **Plan visualization** | ❌ None | ✅ Logical-order plan panel, independent step lifecycle, 7 API operations |
| **Token monitoring** | ❌ Invisible, sudden truncation | ✅ Status bar real-time percent ring + `/context` detail overlay |
| **Model switching** | ❌ Manual config restart required | ✅ `switch_model` hot-switch, AI chooses per task complexity |
| **Knowledge base** | ❌ No built-in retrieval | ✅ `/wiki-search` full-text search, TUI display, `kb_search` AI tool |
| **Inter-agent communication** | ❌ None | ✅ AgentBus broadcast / point-to-point + ConfirmBus dialog routing |
| **Sub-agent control** | ❌ None | ✅ Full lifecycle: `kill` · `abort` · `pause` · `resume` · `status` |
| **Safety guards** | ❌ No path protection | ✅ Auto-block `write`/`edit` on `.git/` `.pi/` `.agents/` etc. |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    pi Kernel (read-only)                  │
│            read · write · edit · bash                    │
└──────────────────────┬──────────────────────────────────┘
                       │ Extension API
     ┌─────────┬───────┼───────┬─────────┬─────────┐
     ▼         ▼       ▼       ▼         ▼         ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌──────────┐
│work-m. ││parallel││cmd-    ││context ││wiki    ││model-    │
│3-mode  ││-agent  ││tool    ││-usage  ││knowledge││switch    │
│safety  ││v8 sub- ││power-  ││token-  ││base    ││hot-switch│
│plan    ││agents  ││shell   ││stats   ││search/ ││persist   │
│panel   ││        ││dual    ││observ. ││TUI     ││          │
└────────┘└───┬────┘└────────┘└────────┘└────────┘└──────────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
┌──────────┐    ┌─────────────┐
│agent-bus │    │confirm-bus  │
│global msg│    │confirmation │
│bus(single│    │dialog router│
│instance) │    │             │
└──────────┘    └─────────────┘
```

---

## 🔥 Features

### 1. Sub-Agent Parallel Dispatch — `parallel-agent.ts` v8

**Problem**: pi is a single-threaded conversational model — analyzing 5 modules requires 5 serial reads, with the AI thrashing context between them.

**Solution**: Split complex problems into N sub-tasks, dispatch them to background agents running in parallel, and auto-inject results into the main conversation.

```
Main Agent: "Review these 5 modules"

   ├─ spawn_agent → Sub-Agent₁ ●── auth module
   ├─ spawn_agent → Sub-Agent₂ ●── api module      Background
   ├─ spawn_agent → Sub-Agent₃ ●── db module       parallel
   ├─ spawn_agent → Sub-Agent₄ ●── ui module       non-blocking
   └─ spawn_agent → Sub-Agent₅ ●── utils module
   │
   ▼  autoInject: true  →  auto-push on completion
```

| Tool | Capability |
|------|-----------|
| `spawn_agent` | Parallel multi-task dispatch, model selection, skill injection, context carrying |
| `check_agent_results` | Non-blocking poll / blocking wait / list all jobs |
| `send_agent_message` | Inter-agent broadcast / point-to-point communication |
| `control_agent` | Full lifecycle: `kill` `abort` `pause` `resume` `status` `list` |

**v8 highlights**: AbortSignal full-chain support, Promise anti-pattern fixes, no more silently swallowed exceptions, `autoInject` auto-push on completion.

---

### 2. Windows Dual Engine — `cmd-tool.ts` + `powershell-tool.ts`

**Problem**: pi's `bash` tool requires WSL on Windows, and `findstr` can't handle mixed-encoding Chinese search.

**Solution**: Two engines selected by scenario — `cmd` for quick commands (~100ms startup), `powershell` for complex searches (native UTF-8).

| Feature | `cmd` | `powershell` |
|---------|:-----:|:------------:|
| Startup speed | ⚡ ~100ms | 🐢 ~1s |
| Simple commands | ✅ `dir` `type` `echo` | ✅ `ls` `gc` `echo` |
| UTF-8 files | ⚠️ needs `codepage=65001` | ✅ **Native UTF-8, zero config** |
| Mixed-encoding search | ❌ `findstr` byte match | ✅ **`Select-String` auto-detect** |
| Command safety | ⚠️ spawn ANSI conversion corrupts | ✅ **Base64(UTF-16LE) zero loss** |
| Structured output | ❌ Plain text only | ✅ JSON / CSV / objects |
| Timeout control | ✅ Default 30s, no hard cap | ✅ Default 60s, no hard cap |
| Truncation guard | ✅ 2000 lines / 50KB | ✅ 2000 lines / 50KB |

**Killer feature — Cross-encoding search**:

```powershell
# What findstr can't do — one command searches UTF-8 + GBK files
Select-String -Path *.txt -Pattern "connection timeout"
→ utf8-log.txt:42:  [ERROR] database connection timeout, retry #3
→ gbk-log.txt:17:   [ERROR] database connection timeout, retry #1
```

**Technical implementation**:
- `powershell`: `-EncodedCommand` + Base64(UTF-16LE) bypasses Node.js spawn's ANSI code page conversion; `$OutputEncoding=UTF8` + `2>&1 | Out-String -Width 200` ensures pure text UTF-8 output
- `cmd`: Auto-prepends `chcp <codepage>` prefix, eliminating encoding mismatch
- Both implement full termination state machines: AbortSignal three-phase checks + `killProcessTree` + residual cleanup

---

### 3. Smart Work Mode — `work-mode.ts` v3

**Problem**: AI acts freely — complex tasks jump in without planning, simple tasks get stuck in needless confirmation loops. No safety guardrails — AI might accidentally write to `.git/` or `node_modules/`.

**Solution**: Three modes + logical-order plan panel + path safety guards.

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Plan** | Plan first → user confirms → step-by-step execution | Complex multi-step, cross-module refactoring |
| **Work** | Direct execution + safety guards (default) | Routine dev, single-file edits |
| **YOLO** | Full automation, no confirmations | High-trust batch operations |

**Plan panel** (logical step model, each step has independent lifecycle):

```
✅ 1. Analyze root cause
▶ 2. Modify cmd-tool.ts         ← current step
○ 3. Deploy to production
○ 4. /reload & verify
○ 5. Git commit & push
```

| Status | Meaning |
|:------:|---------|
| ○ | Pending |
| ▶ | In progress |
| ✅ | Complete |
| ❌ | Error (doesn't abort the plan; can skip/retry) |
| ⏭ | Skipped |

**`manage_plan` API**: AI controls panel via tool calls — `set_steps`, `set_step_status`, `insert_step`, `delete_step`, `update_step`, `complete`, `clear`.

**Safety guards**: Auto-blocks `write`/`edit` on `.git/`, `.pi/`, `.agents/`, `.claude/`, `node_modules/`.

**User commands**: `/plan`, `/work`, `/yolo`, `/security-review`, `/plan-expand`, `/plan-collapse`, `/plan-cancel`

---

### 4. Observability — `context-usage.ts` + `token-stats.ts`

**Problem**: No visibility into token consumption — conversation suddenly truncates due to context overflow, losing all prior analysis.

**Solution**:

| Component | Capability |
|-----------|-----------|
| Status bar token ring | Real-time percent indicator `[████░░] 87%`, warns before overflow |
| `/context` command | Overlay showing System / Skills / Conversation token usage breakdown |
| Proactive offloading | AI detects high water mark, delegates to sub-agents / compresses history |

---

### 5. Model Hot-Switching — `model-switch.ts`

**Problem**: Changing models requires editing config and restarting. Small tasks waste tokens on large models.

**Solution**:

| Tool / Command | Capability |
|----------------|-----------|
| `switch_model` tool | AI chooses per task complexity — demote to Haiku for simple queries, switch to stronger model for complex analysis |
| `/set-default` | Persists default model to settings.json, auto-loaded on startup |
| `/reset-default` | Clears default model config |
| `/model-info` | Shows current / default model status |

**Smart behavior**: Manually-switched sessions are not overwritten by default config, preserving user intent.

---

### 6. Wiki Knowledge Base — `wiki.ts` v3

**Problem**: Project documentation scattered everywhere, search relies on `grep` with noisy results. Previously recorded notes are completely isolated from the current conversation.

**Solution**:

| Command / Tool | Capability |
|----------------|-----------|
| `/wiki-load <directory>` | Load data source, auto-scan `.md` files recursively, build search index |
| `/wiki-unload [index]` | Unload data source / list loaded sources |
| `/wiki-search <keyword>` | Full-text search, TUI panel displays results (zero AI token cost) |
| `/wiki-ask <question>` | Search + return full source content, triggers AI summarization |
| `/wiki-close` | Close search results panel |
| `/wiki-status` | View index status |
| `kb_search` tool | LLM can actively call to search knowledge base when answering questions |

**Key design**: Search and indexing are deterministic and token-free — the AI only uses results to answer questions.

---

### 7. Agent Communication Layer — `agent-bus.ts` + `confirm-bus.ts`

**Problem**: Different agents (main, sub) are completely isolated from each other, cannot coordinate.

**Solution**:

| Component | Capability |
|-----------|-----------|
| **AgentBus** (`globalThis.__pi_agent_bus`) | Cross-session message broadcast / point-to-point, EventEmitter singleton |
| **ConfirmBus** (`globalThis.__pi_confirm_bus`) | Sub-agent safety dialog routing, operation confirmations relayed to main agent |

---

## 📂 Project Structure

```
pi-agent-extensions/
├── README.md                        # This file
├── cmd-tool.ts                      # Windows cmd.exe tool (auto chcp)
├── context-usage.ts                 # /context token usage overlay
├── model-switch.ts                  # Model hot-switching + default persistence
├── parallel-agent.ts                # ⭐ Sub-agent parallel dispatch v8
├── powershell-tool.ts               # Windows PowerShell (UTF-8 / Select-String)
├── token-stats.ts                   # Status bar token percent ring
├── wiki.ts                          # ⭐ Wiki knowledge base v3
├── work-mode.ts                     # ⭐ 3-mode + safety guards + plan panel
├── lib/
│   ├── agent-bus.ts                 # Global message bus singleton
│   └── confirm-bus.ts               # Sub-agent confirmation dialog router
└── wiki/                            # Wiki sub-modules
    ├── commands/
    │   ├── query-cmds.ts            # /wiki-search, /wiki-ask, /wiki-load etc.
    │   └── repo-cmds.ts             # Wiki repository management
    ├── lib/
    │   ├── indexer.ts               # Full-text indexer
    │   ├── search.ts                # Search engine
    │   ├── store.ts                 # Data store
    │   └── types.ts                 # Type definitions
    └── tools/
        ├── kb-search.ts             # kb_search AI tool
        └── management.ts            # Wiki management tools
```

---

## 📦 Installation

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
New-Item -ItemType Directory -Force "$dst\lib", "$dst\wiki"
Copy-Item *.ts $dst
Copy-Item lib\*.ts "$dst\lib"
Copy-Item wiki\**\* "$dst\wiki\" -Recurse
```

**Linux / macOS (with WSL):**
```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git
cd pi-agent-extensions

DST="$HOME/.pi/agent/extensions"
mkdir -p "$DST/lib" "$DST/wiki"
cp *.ts "$DST/"
cp lib/*.ts "$DST/lib/"
cp wiki/**/*.ts "$DST/wiki/"
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
> List files using cmd
> What's my context usage? (/context)
> Switch to a different model
> Search the wiki for "configuration"
```

If the tool executes successfully, the extension is working.

---

## 🎬 Usage Scenarios

### Scenario 1: Multi-Module Code Review

```
You: "Review src/auth, src/api, and src/db for security vulnerabilities"

→ AI spawns 3 sub-agents in parallel
→ All 3 analyze simultaneously, non-blocking
→ Results auto-injected on completion
→ AI compiles a security report with severity levels
```

### Scenario 2: Mixed-Encoding Log Search

```
You: "Search logs/ for all lines containing 'connection timeout'"

→ AI selects powershell (auto-detects Chinese content)
→ Select-String -Path logs\*.log -Pattern "connection timeout"
→ Hits both UTF-8 and GBK files
→ Displays file name + line number for each match
```

### Scenario 3: Batch Refactoring with Plan Control

```
You: "Replace all console.log with logger.debug in src/"

→ AI outputs Execution Plan
  ✅ 1. Find all files containing console.log
  ▶ 2. Replace one by one with logger.debug       ← current
  ○ 3. Check for remaining direct calls
  ○ 4. Run linter to verify
→ You confirm → panel advances step by step
→ Safety guards protect node_modules/
→ If a step errors → mark ❌ → skip or retry
```

### Scenario 4: Long-Running Build

```
You: "Run npm run build"

→ AI selects cmd-tool (fast ~100ms startup)
→ Sets timeout to 120s (no hard cap)
→ Ctrl+C at any time → full killProcessTree cleanup
→ Output >2000 lines → auto-saved to temp file
→ "Use read tool to view full output"
```

### Scenario 5: Token Warning Saves Context

```
Status bar: [████████░░] 87%

→ AI detects impending context overflow
→ Proactively:
  1. Delegates current analysis to sub-agents
  2. Compresses redundant history
  3. Uses kb_search instead of full file reads
→ Conversation continues without sudden truncation
```

---

## ⚙️ Configuration

- **Default model**: Edit `settings.json` in the extensions directory to set `defaultProvider` and `defaultModel`.
- **Work mode**: Set `__pi_default_mode` in your pi configuration to `"plan"`, `"work"`, or `"yolo"`.

---

## 🔒 Compatibility

These extensions use pi's public Extension API (`registerTool`, `registerCommand`, lifecycle events) and do not modify pi's source code. They depend on packages bundled with pi:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

Global singletons (`globalThis.__pi_agent_bus`, `globalThis.__pi_confirm_bus`) are used for cross-session communication. This is **incompatible with ISOLATE mode**.

---

## 📄 License

MIT
