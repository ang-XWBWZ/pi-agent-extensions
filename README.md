# Pi Agent Extensions

> 中文说明在前，English documentation follows.

Pi Agent Extensions gives [pi coding agent](https://github.com/badlogic/pi-mono) a
structured runtime for parallel work, guarded execution, model routing,
Windows command execution, context tracking, and local MCP integration.

This directory is the public GitHub distribution. It contains the runnable
extension source and the public Pwiki usage skill, but not private workspaces,
internal reports, local indexes, test fixtures, or credentials. The extensions
use pi's Extension API and do not modify pi's core.

## 中文说明

### 这是什么

这是面向 pi coding agent 的工程化扩展集合，重点是把“能执行工具”变成
“按阶段、按授权、可观察、可恢复地执行工作”。扩展保持 TypeScript 源码形态，
由 pi 在加载时解析；安装后执行 /reload 即可重新加载。

### 当前能力

| 模块 | 能力 | 主要入口 |
| --- | --- | --- |
| 工作阶段与授权 | CHAT / PLAN / WORK，受控授权、AUTO AI 审批、AUTO_ALL 显式全同意、Work Contract、计划和安全评审 | work-mode.ts、work-mode/ |
| AUTO_FLASH | 为 /auto 配置 AI 安全审批模型；审批失败、模型错误和中止会显式返回，不会伪装成普通 JSON 拒绝 | work-mode/auto-flash.ts |
| 并行 Agent | 派发独立子任务、轮询/等待结果、读取输出、消息通信、暂停/恢复/终止、阶段面板、超时恢复记录 | parallel-agent.ts、parallel-agent/ |
| 模型与层级 | 直接切换 provider/model，维护 L0/L1/L2 模型层级，设置默认思考深度 | model-switch.ts、model-switch/ |
| 自定义供应商 | 注册和恢复自定义 provider，发现模型，兼容 OpenAI 风格和 Anthropic 流式响应，处理供应商流结束字段差异 | provider-manager.ts、provider-manager/ |
| Windows 命令 | 通过 cmd.exe 和 PowerShell 执行命令，支持代码页、超时、输出截断、进程树清理和目的说明 | cmd-tool.ts、powershell-tool.ts |
| 上下文与长程注意力 | 查看 token/context 状态，记录和管理阶段性提醒，维护工作目标及可恢复状态 | context-usage.ts、token-stats.ts、long-attention-ps.ts、work-goal-mode.ts |
| MCP Bridge | 管理本机 stdio MCP Server，发现工具/提示/资源，按策略调用工具并区分只读、持久化和破坏性操作 | mcp/ |

常见工具包括：

spawn_agent、check_agent_results、read_agent_output、control_agent、
send_agent_message、update_agent_task、manage_skills、manage_tools、
manage_plan、manage_requirements、work_goal_*、manage_providers、
switch_model、mcp_manage、mcp_discover 和 mcp_call。

实际注册的 schema 以当前 pi 运行时为准。

### 授权模型

| 阶段/模式 | 行为 |
| --- | --- |
| CHAT | 只对话和澄清，不执行仓库副作用。命令：/chat |
| PLAN | 只读调查、需求确认和计划维护，不执行实现副作用。命令：/plan |
| WORK | 受控执行，普通操作可继续，敏感、未知、破坏性或受保护操作仍需处理。命令：/work |
| AUTO | 在 WORK 中使用配置的 AI 审批模型处理需要审批的命令边界。命令：/auto |
| AUTO_ALL | 用户明确同意所有非保护性命令调用；仍不绕过受保护路径和硬安全边界。命令：/auto_all |

AUTO 不是 AUTO_ALL 的别名，也不会自动授予更高权限。使用 /auto 前先配置
审批模型：

```text
/auto_flash <provider>/<model>
```

也可以只执行 /auto_flash 从当前可用模型中选择，或执行 /auto_flash off
关闭审批模型。未配置审批模型时，/auto 会提示并拒绝需要 AI 审批的边界；
/auto_all 仍是独立的显式全同意模式。cmd 和 powershell 在 AUTO_ALL 下还
要求调用参数包含 auto_all=true 与 purpose。

### 安装公开版本

先安装并确认 [pi coding agent](https://github.com/badlogic/pi-mono) 可以正常运行，
然后将仓库克隆到 pi 的扩展目录：

```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git ~/.pi/agent/extensions
```

已有目录可以更新：

```bash
cd ~/.pi/agent/extensions
git pull --ff-only
```

回到 pi 执行：

```text
/reload
```

如果只使用普通扩展，不需要安装 MCP Bridge 的依赖。不要把本地
mcp/node_modules、配置文件、运行时状态或个人凭据提交回仓库。

### MCP Bridge

MCP Bridge 依赖 Node.js 和官方 MCP SDK，默认管理本机 stdio Server：

```bash
cd ~/.pi/agent/extensions/mcp
npm install --omit=dev --ignore-scripts
```

配置文件默认位于 ~/.pi/agent/mcp-servers.json，也可以用 PI_MCP_CONFIG
指定路径。推荐的首次检查顺序是：

```text
mcp_manage(action="list")
mcp_manage(action="status", name="example")
mcp_manage(action="tools", name="example")
mcp_discover(action="catalog", server="example")
mcp_discover(action="tool", server="example", name="tool_name")
mcp_call(server="example", tool="tool_name", arguments={})
```

先用 mcp_manage 查看服务器和真实工具 schema，再调用 mcp_call。Bridge
不会把环境变量值回显；服务器策略支持 strict 和 Pwiki 专用的 pwiki。
未知或破坏性操作不会因为服务器被设为 always-allow 就自动绕过确认。

### Pwiki 知识库接入

Pwiki 是独立项目，不包含在本仓库的扩展代码中。需要 CLI 或 MCP 时安装公开包：

```bash
npm install -g @llangtop/pwiki-cli @llangtop/pwiki-mcp
```

当前 Pwiki 包要求 Node.js 22 或更高版本。只使用扩展时不需要安装 Pwiki。

安装 @llangtop/pwiki-mcp 后，可在 pi 中配置一个经过审查的 Server：

```text
mcp_manage(
  action="add",
  name="pwiki",
  command="pwiki-mcp",
  args=[],
  policy="pwiki"
)
```

仓库中的 skills/pi-wiki/SKILL.md 是 Pwiki 操作纪律：搜索优先使用只读工具，
编辑、刷新、语义模型和编译操作按风险分级，禁止绕过 wiki 工具直接操作索引和
向量文件。它是使用说明，不是 Pwiki Server 本身。

### 常用工作流

#### 受控实现

```text
/chat             只讨论
/plan             只读调查和需求确认
/work             受控执行
/auto_flash ...   配置 AUTO 审批模型
/auto             AI 审批模式
/auto_all         显式全同意非保护性命令
/security-review  启动安全评审
```

/yolo 只是 /auto 的兼容别名。执行阶段仍受运行时授权、路径保护和工具
安全网约束。

#### 并行工作

使用 spawn_agent 派发有明确目标、范围、允许/禁止工具和停止条件的独立任务；
用 check_agent_results 轮询或等待，用 read_agent_output 读取输出，用
control_agent 管理生命周期，用 update_agent_task 写入阶段进度和结论。
已完成结果可以自动注入，但仍应使用任务面板和结果工具确认状态。

#### 模型路由

switch_model 支持直接切换 provider/model、查看当前模型，以及维护 L0/L1/L2
层级。命令行辅助命令包括：

```text
/tier
/tier-add <L0|L1|L2> <provider> <model> [--thinking <level>]
/tier-remove <L0|L1|L2> [<provider> <model>]
/tier-set-thinking <L0|L1|L2> <off|minimal|low|medium|high|xhigh|max>
/tier-config
```

#### Windows 命令

Windows 用户使用 cmd 或 powershell 工具，并明确命令目的、超时和所需代码页。
Linux/macOS 用户继续使用 pi 原生 bash，不需要为本扩展额外安装 PowerShell。

### 目录与公开边界

```text
.
├── *.ts                    # pi 顶层扩展入口
├── lib/                    # 执行上下文、审计、消息总线和 TUI 辅助
├── parallel-agent/         # 子 Agent、任务面板和输出管理
├── model-switch/           # 模型层级和思考深度
├── provider-manager/       # 自定义供应商、发现和流式兼容
├── work-mode/              # 阶段、授权、计划、路径保护和安全评审
├── mcp/                    # 独立的 stdio MCP Bridge
└── skills/pi-wiki/         # Pwiki 使用纪律和工具流程
```

GitHub 特供版只包含公开运行时代码、MCP Bridge、Pwiki 使用 skill、README 和
.gitignore。开发树中的测试目录、报告/笔记、完整 Pwiki 工程、本地索引、
node_modules 和凭据不属于公开分发内容。仓库根目录如果保留 AGENTS.md 或
SYSTEM.md，它们只服务于贡献协作，不会被 pi 当作扩展加载。

### 更新与排错

更新后重新安装 MCP 依赖并执行 /reload：

```bash
cd ~/.pi/agent/extensions
git pull --ff-only
cd mcp
npm install --omit=dev --ignore-scripts
```

如果工具没有出现，依次检查：

1. pi 当前加载的确实是 ~/.pi/agent/extensions；
2. pi 版本支持当前 Extension API；
3. 只有在使用 MCP Bridge 时才安装 mcp 依赖；
4. pwiki-mcp 可以在终端直接启动；
5. 已执行 /reload，必要时重启 pi 以清理旧进程。

### 开发与安全

修改扩展后，应检查 TypeScript 导入路径、MCP package lock、README 安装路径，
并确认没有带入密钥、个人路径、内部服务地址、运行时状态或私有 Pwiki 数据。
公开同步前至少执行：

```bash
git diff --check
rg -n -i 'api[_-]?key|access[_-]?token|password|secret|/mnt/data|/home/' . \
  --glob '!mcp/node_modules/**'
```

字段名和脱敏规则本身可能被搜索命中；需要人工确认的是是否存在真实值、个人
绝对路径或内部地址。

### 许可

MIT。欢迎提交可复现的问题、兼容性信息和最小修改建议。

## English Documentation

### Overview

Pi Agent Extensions is a public, source-form distribution of pi extensions for
structured engineering work. It adds phase-aware authorization, parallel
sub-agents, model/provider routing, Windows command tools, context and goal
tracking, and a policy-aware local MCP bridge. It runs through pi's Extension
API and does not modify pi core.

### Feature map

- **Workflow and safety:** /chat, /plan, /work, /auto, and /auto_all, Work
  Contracts, plan management, path protection, command safety checks, and
  sanitized audit context.
- **AUTO_FLASH:** configure the AI reviewer used by /auto with
  /auto_flash <provider>/<model>. A reviewer can decide an approval-boundary
  call, but cannot promote guarded work or grant AUTO_ALL. Provider stream
  failures and aborts are surfaced as failures instead of being misread as an
  invalid boolean response.
- **Parallel agents:** spawn_agent, check_agent_results, read_agent_output,
  control_agent, send_agent_message, update_agent_task, manage_skills, and
  manage_tools, with task panels, stage reports, persistence, and timeout
  recovery metadata.
- **Models and providers:** switch_model, L0/L1/L2 tiers, thinking levels,
  custom provider persistence and discovery, plus OpenAI-compatible and
  Anthropic streaming compatibility helpers.
- **Windows execution:** cmd and powershell with code-page selection, timeouts,
  bounded output, process-tree cleanup, and explicit command purpose.
- **Context and goals:** context/token status, long-attention PS reminders,
  work-goal lifecycle tools, and persisted phase/goal state.
- **MCP Bridge:** manage local stdio servers, inspect their tools and metadata,
  call tools through verified schemas, and apply strict or pwiki risk policies.
- **Pwiki integration:** the repository contains a skills/pi-wiki/SKILL.md usage
  discipline; Pwiki itself remains a separately installed CLI/MCP project.

### Installation

Install and verify [pi coding agent](https://github.com/badlogic/pi-mono), then:

```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git pull --ff-only
```

Reload pi after installing or updating:

```text
/reload
```

The ordinary extensions do not require MCP dependencies. If you use the bridge:

```bash
cd ~/.pi/agent/extensions/mcp
npm install --omit=dev --ignore-scripts
```

The default MCP configuration is ~/.pi/agent/mcp-servers.json; override it
with PI_MCP_CONFIG when needed.

### Authorization model

| Mode | Meaning |
| --- | --- |
| CHAT | Conversation and clarification only; no repository side effects. |
| PLAN | Read-only discovery, requirements, and plan work. |
| WORK | Guarded implementation; sensitive, unknown, destructive, and protected operations remain controlled. |
| AUTO | AI-reviewed authorization for eligible command boundaries inside WORK. Configure with /auto_flash. |
| AUTO_ALL | Explicit approval for non-protected command calls; it does not bypass hard protection. |

AUTO is not AUTO_ALL. If no reviewer is configured, /auto warns and rejects
operations that require AI review. /auto_flash off disables the reviewer;
/auto_all remains a separate explicit mode. cmd and powershell additionally
require auto_all=true and a purpose when used under AUTO_ALL.

### MCP and Pwiki quick start

Inspect a configured MCP server before calling it:

```text
mcp_manage(action="list")
mcp_manage(action="tools", name="example")
mcp_discover(action="catalog", server="example")
mcp_discover(action="tool", server="example", name="tool_name")
mcp_call(server="example", tool="tool_name", arguments={})
```

Pwiki is independent and requires Node.js 22 or newer:

```bash
npm install -g @llangtop/pwiki-cli @llangtop/pwiki-mcp
```

The included Pwiki skill requires read operations to use wiki read tools and
keeps edits, refreshes, vector operations, and compilation explicitly separated
by risk. It must not be used as a reason to edit Pwiki data files directly.

### Public distribution boundary

The public bundle contains extension source, the MCP bridge, the Pwiki usage
skill, README, and .gitignore. It intentionally excludes development tests,
private reports and notes, the full Pwiki project, local indexes, runtime
dependencies, and credentials. Root-level AGENTS.md and SYSTEM.md, when
present in the repository, are contribution documents rather than runtime
extensions.

### Troubleshooting and contribution

After an update, run /reload; reinstall mcp dependencies only when using the
bridge. If a tool is missing, verify the loaded extension directory, pi's
Extension API compatibility, the bridge dependency installation, and whether an
old pi process needs to be restarted.

Before publishing a change, run git diff --check and review searches for API
keys, access tokens, passwords, secrets, personal absolute paths, internal
addresses, runtime state, and private Pwiki data. Matches for field names and
sanitization code are not automatically leaks; inspect the actual values.

MIT licensed. Please file reproducible issues with compatibility details and the
smallest useful patch.
