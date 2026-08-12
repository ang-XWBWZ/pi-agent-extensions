# Pi Agent Extensions

> 给 pi coding agent 装上工程化能力：并行子 Agent、Windows 双引擎、受控工作流、上下文观测、模型管理和 MCP 接入。

这是面向 GitHub 的公开发布目录。它是从主开发树筛选出的可直接安装版本，不包含工作区笔记、内部报告、私有 Pwiki 数据、测试夹具或凭据。扩展通过 pi 的 Extension API 工作，不修改 pi 内核。

## 能力概览

| 模块 | 主要能力 | 入口 |
| --- | --- | --- |
| 并行 Agent | 后台派发、轮询、输出读取、消息通信、暂停/恢复/终止、存档与任务面板 | `parallel-agent.ts` |
| 工作流与安全 | Chat / Plan / Work / Auto 阶段，Work Contract，计划面板，路径保护，脱敏审计 | `work-mode.ts` |
| Windows 命令 | 通过 `cmd.exe` 和 PowerShell 执行命令，处理代码页、超时、截断和进程树 | `cmd-tool.ts`、`powershell-tool.ts` |
| 模型与供应商 | 模型热切换、层级与思考深度、OpenAI/Anthropic 兼容供应商注册和发现 | `model-switch.ts`、`provider-manager.ts` |
| 上下文与记忆 | Token 状态、上下文明细、长程注意力提醒和工作目标记录 | `context-usage.ts`、`token-stats.ts`、`long-attention-ps.ts`、`work-goal-mode.ts` |
| MCP Bridge | 管理本机 stdio MCP Server，读取目录，按策略调用工具 | `mcp/` |

常用工具包括 `spawn_agent`、`check_agent_results`、`read_agent_output`、`control_agent`、`send_agent_message`、`manage_plan`、`manage_providers`、`switch_model`、`work_goal_*`、`mcp_manage`、`mcp_discover` 和 `mcp_call`。具体 schema 以运行中的 pi 注册结果为准。

## 安装

### 直接安装公开版本

需要先安装并能正常运行 [pi coding agent](https://github.com/badlogic/pi-mono)。然后把本仓库克隆到 pi 的扩展目录：

```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git ~/.pi/agent/extensions
```

如果扩展目录已经存在，可以把仓库内容复制到该目录，保留已有的个人配置；不要把 `mcp/node_modules` 等运行时依赖提交回仓库。

安装或更新后，在 pi 中执行：

```text
/reload
```

### 启用 MCP Bridge

MCP Bridge 依赖 Node.js 和官方 SDK。进入扩展目录安装运行时依赖：

```bash
cd ~/.pi/agent/extensions/mcp
npm install --omit=dev --ignore-scripts
```

然后重新加载 pi。Bridge 默认只启动本机 stdio Server，配置文件位于：

```text
~/.pi/agent/mcp-servers.json
```

也可以通过 `PI_MCP_CONFIG` 指定其他配置路径。首次接入外部 Server 时，建议先用 `mcp_manage(action="tools")` 和 `mcp_discover(action="catalog")` 检查其真实能力，再执行 `mcp_call`。

## 接入 Pwiki

Pwiki 是独立的知识库项目，不再内嵌到本仓库的扩展代码中。需要在终端使用 Pwiki CLI 或通过 MCP 给 pi 使用时，可直接安装公开 npm 包：

```bash
npm install -g @llangtop/pwiki-cli @llangtop/pwiki-mcp
```

Pwiki 当前发布包要求 Node.js 22 或更高版本。只使用扩展而不接入 Pwiki 时，不需要安装这些包。

安装 `@llangtop/pwiki-mcp` 后，在 pi 对话中配置一个已审查的 Server：

```text
mcp_manage(
  action="add",
  name="pwiki",
  command="pwiki-mcp",
  args=[],
  policy="pwiki"
)
```

接着按顺序确认服务和工具：

```text
mcp_manage(action="tools", name="pwiki")
mcp_discover(action="catalog", server="pwiki")
mcp_discover(action="tool", server="pwiki", name="wiki_status")
mcp_call(server="pwiki", tool="wiki_status", arguments={})
```

`policy="pwiki"` 会把搜索和读取视为只读，把条目/索引修改视为持久化操作，把卸载数据源视为破坏性操作。Chat 和 Plan 阶段不会因为该策略自动获得写权限。

## 常用工作流

### 受控开发

```text
/chat    只讨论，不执行仓库操作
/plan    只读调查并形成 Work Contract
/work    执行已接受的计划
/auto    在已授权范围内连续执行
/security-review
```

`/yolo` 保留为 `/auto` 的兼容别名。Work 阶段仍会拦截破坏性、未知、越界和受保护路径操作；Auto 不是绕过安全边界的开关。

### 并行拆分

主 Agent 可以把独立工作拆给后台子 Agent：

```text
spawn_agent          派发一个或多个任务
check_agent_results   轮询或等待结果
read_agent_output     按游标读取完整原始输出
update_agent_task     更新任务状态、进度和结论
control_agent         查看、暂停、恢复、终止或存档
```

子 Agent 的状态、面板和输出写入当前用户的 pi 状态目录；仓库本身不会携带这些运行时数据。

### Windows 中文命令

在 Windows 上，扩展提供两个工具：

- `cmd`：适合 `dir`、`type`、`where` 等轻量命令；可指定代码页，例如 `936`。
- `powershell`：适合结构化输出、中文搜索和复杂脚本；使用编码命令降低 ANSI 代码页造成的乱码风险。

Linux/macOS 用户继续使用 pi 原生 `bash`；不需要为了本扩展额外安装 PowerShell。只有当你的实际任务需要运行 PowerShell 脚本时，才单独安装对应运行时。

## 目录结构

```text
.
├── *.ts                    # pi 顶层扩展入口
├── lib/                    # 执行上下文、审计、消息总线和 TUI 辅助
├── parallel-agent/         # 子 Agent 调度、通信、任务和输出工具
├── model-switch/           # 模型层级、默认值和热切换工具
├── provider-manager/       # 自定义供应商、发现和流式兼容层
├── work-mode/              # 阶段、计划、权限和安全评审
├── mcp/                    # 独立的 stdio MCP Bridge 包
└── skills/pi-wiki/         # Pwiki MCP 的使用纪律和操作流程
```

GitHub 特供版不包含开发树中的测试目录、报告/笔记、完整 Pwiki 工程和本地索引数据。仓库根目录若保留公开的 `AGENTS.md` / `SYSTEM.md`，它们只用于贡献协作，不会被 pi 作为运行时扩展加载。发布目录中的 TypeScript 保持源码形态，由 pi 在加载扩展时解析。

## 更新与排错

更新代码后：

```bash
cd ~/.pi/agent/extensions
git pull --ff-only
cd mcp
npm install --omit=dev --ignore-scripts
```

回到 pi 执行 `/reload`。如果工具没有出现，优先检查：

1. 当前目录是否确实是 `~/.pi/agent/extensions`；
2. pi 是否支持当前 Extension API；
3. MCP Bridge 的 `mcp/package.json` 依赖是否安装完成；
4. Pwiki Server 是否能在终端直接执行 `pwiki-mcp`；
5. 是否在加载旧进程，必要时重启 pi 后再检查。

## 开发

开发树包含测试和更完整的工作区资料；GitHub 特供版只用于安装和公开分发。修改扩展后，至少应检查 TypeScript 导入路径、MCP package 的依赖锁文件、README 中的安装路径，并确认没有把密钥、个人路径、运行时状态或内部服务地址带入发布目录。

提交前建议执行：

```bash
git diff --check
rg -n -i 'api[_-]?key|access[_-]?token|password|secret|/mnt/data|/home/' . \
  --glob '!mcp/node_modules/**'
```

上述搜索会命中代码中的安全字段名和脱敏规则，这是预期的；需要人工确认的是是否存在真实值、个人绝对路径或内部地址。

## 许可

MIT。请在公开 Issue 或 Pull Request 中提交可复现的问题、兼容性信息和最小修改建议。
