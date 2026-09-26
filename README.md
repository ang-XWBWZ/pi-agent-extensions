# Pi Agent Extensions

> **给 pi coding agent 装上工程化引擎。** 不改内核一行代码，通过 Extension API 赋予其子 Agent 并行调度、Windows 双引擎、受控自动化工作流、上下文监控、模型热切换和 MCP 服务接入等能力。

---

## 原生 vs 扩展：一目了然

pi 原生仅提供 `read` / `write` / `edit` / `bash` 四个基础工具。以下是装上扩展后的能力跃迁：

| 维度 | pi 原生 | 装上扩展后 |
|------|:---:|------|
| **可用工具** | 4 个 | **19 个**（15 个新增 AI 工具 + 4 个原生） |
| **用户命令** | 0 个自定义 | **20+ 个**（`/tier` `/note` `/context` 等） |
| **并行执行** | ❌ 纯串行，一个任务一个任务读 | ✅ `spawn_agent` 同时派发 N 个子 Agent 后台并行 |
| **Windows 中文** | ❌ `bash` 工具编码适配差，中文乱码 | ✅ `cmd` + `powershell` 双引擎，原生 UTF-8 / 智能 GBK |
| **执行管控** | ❌ 无统一授权和审计 | ✅ Chat / Plan / Work 阶段 + Guarded / Auto 授权 + Work Contract + 脱敏审计 |
| **计划可视化** | ❌ 无 | ✅ 逻辑顺序计划面板，步骤独立生命周期，7 种操控 API |
| **Token 监控** | ❌ 不可见，突然截断 | ✅ 状态栏实时百分比环 + `/context` 浮层明细 |
| **模型切换** | ❌ 需手动改配置重启 | ✅ `switch_model` 热切换，AI 按任务复杂度自行决策 |
| **MCP 服务** | ❌ 无内置 MCP | ✅ `mcp_manage` 管理本机 Server，`mcp_discover` 获取说明与指令清单，`mcp_call` 调用已配置工具（含 Pwiki） |
| **Agent 间通信** | ❌ 无 | ✅ AgentBus 广播 / 点对点 + ConfirmBus 安全弹窗路由 |
| **子 Agent 控制** | ❌ 无 | ✅ 完整生命周期：`kill` · `abort` · `pause` · `resume` · `status` · `save` |
| **自定义供应商** | ❌ 需改内核 | ✅ `manage_providers` 注册/移除/列出，OpenAI/Anthropic 全兼容 |
| **注意力暂存** | ❌ compaction 丢上下文 | ✅ `attention_add` 粘性记忆，跨轮注入，sticky 跨 compaction 保留 |
| **子 Agent 克隆** | ❌ 无 | ✅ 存档/恢复/克隆，`resumeFrom` 继承上下文并行分发 |
| **安全护栏** | ❌ 无路径保护 | ✅ 硬拦截 `.git/` `.pi/` `node_modules/`；操作 `.agents/` `.claude/` 时提醒并审计 |

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    pi 内核（只读，不修改）                          │
│            read · write · edit · bash                            │
└──────────────────────────┬───────────────────────────────────────┘
                           │ Extension API
     ┌─────────┬───────┬───┼───┬─────────┬─────────┬─────────┬─────────┐
     ▼         ▼       ▼   ▼   ▼         ▼         ▼         ▼         ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌──────────┐
│work-m. ││parallel││provider││model-  ││attention││cmd-    ││context   │
│工作流  ││-agent  ││-manager││switch  ││-buffer ││tool    ││-usage    │
│安全守卫││子Agent ││自定义  ││层级系统││注意力  ││power-  ││token-    │
│计划面板││调度 v10││供应商  ││热切换  ││暂存器  ││shell   ││stats     │
│        ││        ││注册管理││六级思考││粘性记忆││双引擎  ││可观测    │
└────────┘└───┬────┘└────────┘└────────┘└────────┘└────────┘└──────────┘
              │                                           │
     ┌────────┴────────┐                          ┌──────────────┐
     ▼                 ▼                          ▼
┌──────────┐    ┌─────────────┐            ┌──────────────────┐
│agent-bus │    │confirm-bus  │            │mcp/              │
│全局消息  │    │安全弹窗路由   │            │管理 + stdio 调用 │
│总线单例  │    │             │            │Pwiki / 其他 MCP  │
└──────────┘    └─────────────┘            └──────────────────┘
```

---

## 🔥 高级特性详解

### 1. 子 Agent 并行调度 — `parallel-agent.ts` + `parallel-agent/` v10

**原生痛点**：pi 是单线程对话模型，分析 5 个模块需要串行读取 5 次，AI 来回切换上下文，效率极低。

**扩展方案**：把复杂问题拆成 N 个子任务，派发到后台并行执行，结果自动汇入主对话。

```
主 Agent: "审查这 5 个模块"

   ├─ spawn_agent → 子 Agent₁ ●── auth 模块
   ├─ spawn_agent → 子 Agent₂ ●── api 模块      后台并行
   ├─ spawn_agent → 子 Agent₃ ●── db 模块       互不阻塞
   ├─ spawn_agent → 子 Agent₄ ●── ui 模块
   └─ spawn_agent → 子 Agent₅ ●── utils 模块
   │
   ▼  autoInject: true  →  完成即自动推送结果
```

| 工具 | 能力 |
|------|------|
| `spawn_agent` | 多任务并行派发，支持模型指定、skill 注入、上下文携带 |
| `check_agent_results` | 非阻塞轮询 / 阻塞等待 / 列出所有 Job |
| `read_agent_output` | 按 UTF-8 游标分段读取某个子任务的原始输出；默认只取 12KB，不读取会话存档 |
| `send_agent_message` | Agent 间消息广播 / 点对点通信 |
| `control_agent` | 完整生命周期：`kill` `abort` `pause` `resume` `status` `list` `save` `list_saves` `delete_save` |
| `update_agent_task` | 子 Agent 主动提交每阶段的结论控制面板、可选详细控制面板、进度和追加式备注 |

**v10 亮点**：保留 v9 的模型切换、克隆恢复和生命周期能力，并新增超时前自动存档、失败结果中间产出保留、专属任务面板与任务备注，以及安全的增量落盘。

**关键能力详解**：

| 新特性 | 说明 |
|------|------|
| **模型切换修复** | 子 Agent 共享主 session 的 ModelRegistry，`spawn_agent` 指定 `model` 字段即可切换 |
| **自动存档** | 子 Agent 完成时自动保存对话状态到 `~/.pi/agent/sub-agent-saves/` |
| **超时可恢复** | 超时先保存会话、输出快照和面板，再终止实例；结果返回 `saveId` |
| **专属任务面板** | 每个子任务独立记录状态、0-100% 进度、当前步骤，以及按阶段追加的结论控制面板和可选详细控制面板，并增量保存到 `~/.pi/agent/sub-agent-tasks/` |
| **按需原始输出** | 面板快照最多 64,000 字符（首段 + 末段）；完整原始输出单独写入 `~/.pi/agent/sub-agent-output/`，主 Agent 仅在需要证据时用 `read_agent_output` 分页读取 |
| **阶段结论优先** | 子 Agent 在每个有意义阶段主动写入能说明结果的结论（最多 8,000 字）和可选详细说明（最多 12,000 字）；最终阶段同样提交结论，自动回传优先展示它，长日志不主动污染主上下文 |
| **追加式任务备注** | 子 Agent 在里程碑和阻塞点持续追加备注，更新即落盘，不覆盖旧结论 |
| **非退出异常边界** | 宿主扩展不调用立即退出 API；故障转为异常或结构化失败，保留清理与落盘机会 |
| **安全状态路径** | 用户提供的 job/task ID 经过 slug + SHA-256 映射，不能越界写出状态目录 |
| **克隆恢复** | `resumeFrom` 参数从存档克隆子 Agent，继承上下文并行分发 |
| **FrontendQueue** | 统一消息队列串行化 confirm + steer 消息，解决并发竞态 |
| **泄漏自检** | 每次 turn/tool 前检查 bus 注册状态，未注册即自毁，杜绝僵尸进程 |
| **Token 统计面板** | 子 Agent 实时 ↑↓ token 数面板 + 完成单行通知 |
| **跨 reload 持久** | `globalThis.__pi_agent_state` 状态跨 `/reload` 不丢失 |

---

### 2. Windows 双引擎 — `cmd-tool.ts` + `powershell-tool.ts`

**原生痛点**：pi 的 `bash` 工具在 Windows 上需要 WSL，且编码适配差。`findstr` 只能按字节匹配，跨编码中文搜索直接返回空。

**扩展方案**：双引擎按场景自动选择——简单命令用 `cmd`（启动极快），复杂搜索用 `powershell`（原生 UTF-8）。

| 特性 | `cmd` | `powershell` |
|------|:---:|:---:|
| 启动速度 | ⚡ ~100ms | 🐢 ~1s |
| 简单命令 | ✅ `dir` `type` `echo` | ✅ `ls` `gc` `echo` |
| 中文 UTF-8 文件 | ⚠️ 需 `codepage=65001` | ✅ **原生 UTF-8，零配置** |
| 跨编码中文搜索 | ❌ `findstr` 字节匹配 | ✅ **`Select-String` 自动检测** |
| 命令中文安全 | ⚠️ spawn ANSI 转换损毁 | ✅ **Base64(UTF-16LE)** 零损伤 |
| 结构化输出 | ❌ 纯文本 | ✅ JSON / CSV / 对象 |
| 超时控制 | ✅ 默认 30s，无硬上限 | ✅ 默认 60s，无硬上限 |
| 截断保护 | ✅ 2000 行 / 50KB | ✅ 2000 行 / 50KB |

**杀手特性 — 跨编码搜索**：

```powershell
# findstr 做不到的事 — 一条命令搜遍目录中 UTF-8 + GBK 文件
Select-String -Path *.txt -Pattern "连接超时"
→ utf8-log.txt:42:  [ERROR] 数据库连接超时，重试第3次
→ gbk-log.txt:17:   [ERROR] 数据库连接超时，重试第1次
```

**技术实现**：
- `powershell`：`-EncodedCommand` + Base64(UTF-16LE) 绕过 Node.js spawn 的 ANSI 代码页转换；`$OutputEncoding=UTF8` + `2>&1 | Out-String -Width 200` 确保纯文本 UTF-8 输出
- `cmd`：自动注入 `chcp <codepage>` 前缀，消除编码两端不一致导致的乱码
- 两者均实现完整的终止状态机：AbortSignal 三段检查 + `killProcessTree` + 残留清理

---

### 3. 自动化工作流 — `work-mode.ts` v4

**原生痛点**：AI 自由发挥，复杂任务不规划直接改代码，简单任务却反复确认。没有安全护栏——AI 可能误写 `.git/` 或 `node_modules/`。

**扩展方案**：协作阶段、授权等级、结构化 Work Contract、真实进度和自动审计由同一个运行时统一管理。

| 阶段/授权 | 行为 | 适用场景 |
|------|------|----------|
| **Chat** | 只对话，不调用仓库或外部工具 | 解释、比较、讨论 |
| **Plan** | 只读检查 → 一次提交完整 Work Contract → 用户接受/修改/拒绝 | 高风险、跨模块或存在关键歧义 |
| **Work · Guarded** | 清晰任务直接执行；只在持久、越界或破坏性边界询问（默认） | 常规开发 |
| **Work · Auto** | 命令在审批边界交给已配置的 `auto_flash` AI 模型；模型缺失、调用失败或拒绝都会阻止命令，硬保护路径仍直接拦截 | 希望由 AI 审批连续命令 |
| **Work · Auto All** | 用户执行 `/auto_all` 后，`bash` 或带 `auto_all=true` 的 `cmd/powershell` 命令全同意并跳过 AI/人工审批；硬保护路径仍拦截 | 用户明确承担全部命令风险 |

阶段不等于权限，审计也不等于权限。`work_goal_start` 只开启详细执行账本，不能把 Guarded 提升为 Auto。根会话启动或重载会把 Auto 安全复位为 Guarded；只有显式继承授权的子 Agent 可以继承 Auto。

**结构化递进**：计划由工具参数建立，不再解析 AI 输出中的 Markdown 标题，也不会伪造用户消息开启下一轮。

```
✅ 1. 分析问题根因
▶ 2. 修改 cmd-tool.ts         ← 当前步骤
○ 3. 同步到生产目录
○ 4. /reload 测试验证
○ 5. Git 提交推送
```

| 状态 | 含义 |
|:---:|------|
| ○ | 待执行 |
| ▶ | 进行中 |
| ✅ | 已完成 |
| ❌ | 出错（不中断全局，可跳过/重试） |
| ⏭ | 已跳过 |

**`manage_plan` API**：`set_steps` `advance` `set_step_status` `insert_step` `delete_step` `update_step` `complete` `clear`。`advance` 必须附带可观察 evidence，并原子完成当前步骤、选择下一步；非当前步骤不能直接写入终态，已完成事实不能静默改写。只要仍有待办或错误，`complete` 就会拒绝。

**统一风险守卫**：内置文件/终端工具和全部自定义工具都经过 `read / progress / workspace_write / persistent / destructive / unknown` 风险判定。破坏性和未知确认只能单次授权，不能写入“始终允许”。非只读调用自动写入脱敏审计条目；普通工具失败保持当前步骤，交给 AI 诊断和重试，不会谎报完成。

**用户命令**：`/chat` `/plan` `/work` `/auto` `/auto_stop` `/auto_all` `/auto_model` `/auto_add_prmt` `/security-review` `/plan-expand` `/plan-collapse` `/plan-cancel`。`/auto` 使用 `/auto_model <provider>/<model>` 配置的 AI 审批模型（`/auto_flash` 为兼容别名）；引用保存在 `~/.pi/agent/settings.json` 的 `autoFlashModel`，自定义供应商仍从运行时 `provider` 注册链调用；审批模型限制思考强度（`reasoning: "minimal"`）与最大 Token（256），避免长考和冗长输出；`/auto_add_prmt <提示词>` 可配置审核模型的自定义提示词；若计划/目标模式启动，其无状态规格内容会自动注入审批上下文；`/auto_stop`（别名 `/auto_cancel`、`/auto_abort`）可一键强制终止 AUTO 任务并回退到 GUARDED 模式；单轮连续自动执行超过 25 步（可配 `autoMaxSteps`）自动触发防死循环熔断；终端最底部状态栏实时展示 AUTO 工作状态（就绪/审核中/已放行/已拦截/已终止/已熔断）。`/auto_all` 是独立的显式全同意授权，不调用 AI 审批。`cmd/powershell` 支持 `purpose`（审批用途）和 `auto_all`（全同意请求）参数；拒绝审批时可选择填写原因，原因进入脱敏审计并返回给调用方。`/yolo` 暂作为 `/auto` 兼容别名。

---

### 4. 可观测性 — `context-usage.ts` + `token-stats.ts`

**原生痛点**：无法感知 Token 消耗，对话突然因上下文溢出而截断，之前的分析成果全部丢失。

**扩展方案**：

| 组件 | 能力 |
|------|------|
| 状态栏 Token 环 | 实时百分比指示器 `[████░░] 87%`，即将溢出时预警 |
| `/context` 命令 | 浮层展示 System / Skills / 对话的 Token 用量占比，一目了然 |
| 主动降载 | AI 感知到高水位时，主动委派子 Agent / 压缩历史 |

---

### 5. 模型热切换 + 层级系统 — `model-switch.ts` + `model-switch/`

**原生痛点**：切换模型需要修改配置文件并重启，小任务用大模型浪费 Token/Cost。

**扩展方案**：L0/L1/L2 三级模型分层 + 六级思考深度 (`off`～`xhigh`) + 自定义供应商管理。

| 工具/命令 | 能力 |
|------|------|
| `switch_model` 工具 | AI 按任务复杂度自行决策——简单查询降级 Haiku，复杂分析切换 DeepSeek |
| `/tier` `/tier-add` `/tier-remove` | 模型分级管理，L0(快速)/L1(主要)/L2(高级) |
| `/thinking` `/tier-set-thinking` | 六级思考深度，按层级预设 |
| `/set-default` `/reset-default` | 持久化默认模型/层级到 settings.json |
| `/model-info` | 查看当前/默认模型状态 |
| `manage_providers` 工具 | 注册/移除/列出 OpenAI/Anthropic 兼容自定义供应商，自动模型发现 |

**智能行为**：手动切换过的 session 不会被默认配置覆盖，避免打断用户意图。

---

### 6. 注意力暂存器 — `attention-buffer.ts` + `attention-buffer/` v4

**原生痛点**：AI 在长对话中遗忘之前发现的线索、用户偏好或当前任务主线，compaction 后上下文彻底丢失。

**扩展方案**：AI 自主调用的粘性记忆系统——`attention_add` 写入，每轮自动注入 context 事件，`sticky` 标记跨 compaction 保留。

| 工具 | 能力 |
|------|------|
| `attention_add` | AI 自主写入临时备忘，支持 `sticky` 粘性标记 |
| `attention_list` | 查看全部暂存内容 + 提醒/轮换阈值进度 |
| `attention_clear` | 清空暂存器，重置计数器 |
| `attention_summarize` | 将多条合并为一条总结 |
| `attention_config` | 调整阈值（提醒/轮换/容量） |
| `/note` | 用户手动管理暂存器的兜底命令 |

**状态栏提示**：`📌3` — AI 在每次 message_end 后看到暂存条数，高水位时主动 summarize。

---

### 7. MCP Bridge — `mcp/`

Pi 内核刻意不内置 MCP；该扩展补上一个受工作流安全策略约束的 stdio MCP Client，而不再内嵌 Pwiki 的索引、向量或模型实现。

| 工具 | 能力 |
|------|------|
| `mcp_manage` | 列出、检查、添加、更新、启停、断开或移除本机 stdio MCP Server；`allow` / `disallow` 可切换某个 Server 的始终允许策略；配置位于 `~/.pi/agent/mcp-servers.json`（Windows/Linux 均按当前用户主目录解析；可用 `PI_MCP_CONFIG` 覆盖） |
| `mcp_manage(action="tools")` | 连接服务器并读取其真实 `tools/list` 目录和 JSON Schema |
| `mcp_discover(action="catalog")` | 获取 Server 初始化说明、能力、工具、Prompt 模板、资源和资源模板清单 |
| `mcp_discover(action="tool" | "prompt" | "resource")` | 按需读取某一项的完整 Schema、工作流模板或已列出 URI 的文档内容；不会执行 Prompt 或 MCP 工具 |
| 自动注册的 MCP 工具 | 扩展加载时遍历所有启用 Server 的 `tools/list`，按原始 JSON Schema 注册为 Pi 工具；单一来源保留原名，重名使用 `mcp__<server>__<tool>` 命名空间；仍经过本地风险策略 |
| `mcp_call` | 通用兜底：校验目标工具后透传 `{ server, tool, arguments }`；调用行显示为 `mcp call <server> <tool> <JSON arguments>`，结果默认收起，按 `Ctrl+O` 展开 |

服务默认采用 `strict` 风险策略，未知 MCP 工具需要确认。Pwiki 可显式设置 `policy="pwiki"`：搜索/读取归为只读，索引与条目编辑归为持久化，卸载数据源归为破坏性操作。Server 通过 `shell: false` 的 stdio 进程启动，环境变量值不会在工具输出中回显。服务提供的说明、Prompt、资源和 annotations 均是外部不可信参考，不能改变本地授权或触发调用；资源读取只接受先前目录中精确列出的 URI，二进制内容不会注入上下文。

需要让某个已审查 Server 的常规写操作不再重复确认时，使用 `mcp_manage(action="allow", name="pwiki")`；用 `action="disallow"` 撤销。该设置只在 WORK 中对本地策略已识别为持久化的 `mcp_call` 生效；Chat / Plan 不会被提升，未知或破坏性调用仍保持一次一确认。

任意 MCP Server 加入 `~/.pi/agent/mcp-servers.json` 并启用后，扩展加载或 `/reload` 时会自动发现并注册它公开的工具。例如 Pwiki 的 `wiki_search`、`wiki_status` 可直接作为 Pi 工具调用；如果多个 Server 提供同名方法，则使用 `mcp__<server>__<tool>`。`mcp_discover` 仍用于读取完整目录和文档，`mcp_call` 保留为通用兜底。

---

### 8. Agent 通信层 — `agent-bus.ts` + `confirm-bus.ts`

**原生痛点**：不同 Agent（主 Agent、子 Agent）之间完全隔离，无法协调工作。

**扩展方案**：

| 组件 | 能力 |
|------|------|
| **AgentBus** (`globalThis.__pi_agent_bus`) | 跨 session 消息广播 / 点对点通信，EventEmitter 单例 |
| **ConfirmBus** (`globalThis.__pi_confirm_bus`) | 子 Agent 安全弹窗路由，操作确认回传主 Agent |
| **AgentState** (`globalThis.__pi_agent_state`) | 🆕 跨 `/reload` 状态持久化，Jobs/Instances 不丢失 |

---

## 🎬 实战场景

### 场景 1：多模块代码审查

```
你: "审查 src/auth、src/api、src/db 三个模块的安全漏洞"

→ AI 自动 spawn_agent × 3 并行审查
→ 3 个子 Agent 同时分析，各自独立不阻塞
→ 所有完成后 autoInject 自动推送结果到对话
→ AI 汇总为一份安全报告，带严重度分级
```

### 场景 2：中文日志排查

```
你: "帮我在 logs/ 下搜所有包含'数据库连接超时'的行"

→ AI 判断中文搜索 → 自动选 powershell
→ Select-String -Path logs\*.log -Pattern "数据库连接超时"
→ 无论文件是 UTF-8 还是 GBK，全部命中
→ 展示带文件名和行号的完整结果
```

### 场景 3：批量重构 + 计划管控

```
你: /plan
你: "把日志系统迁移到新接口，保持旧调用兼容并补齐测试"

→ AI 只读检查调用点、兼容约束和现有测试
→ AI 一次提交完整 Work Contract
→ 你在 UI 中接受、修改或暂不执行
→ 接受后建立结构化计划面板
  ✅ 1. 搜索所有含 console.log 的文件
  ▶ 2. 逐个替换为 logger.debug       ← 当前
  ○ 3. 检查是否遗漏直接调用
  ○ 4. 运行 lint 验证
→ `advance` 逐步骤推进，不能跳过未完成项伪造成功
→ 所有写入、确认和结果进入脱敏审计
→ 工具失败时当前步骤保持进行中，由 AI 诊断、修复或明确标错
```

### 场景 4：编译任务 — 超长超时不慌

```
你: "运行 npm run build"

→ AI 自动选 cmd-tool（启动 ~100ms）
→ timeout 设为 120s（无硬上限，可任意设）
→ 编译中随时 Ctrl+C → 完整的 killProcessTree 清理
→ 超时或输出超出 2000 行 → 自动保存到临时文件
→ 提示 "Use read tool to view full output"
```

### 场景 5：Token 预警保上下文

```
状态栏显示: [████████░░] 87%

→ AI 感知到上下文即将溢出
→ 主动操作：
  1. 将当前分析结果委派给子 Agent 继续
  2. 压缩冗余的历史消息
  3. 通过 `mcp_call` 查询已配置的知识库或外部服务
→ 对话正常继续，不会突然截断丢失上下文
```

### 场景 6：跨会话知识检索

```
你: "上次处理的那个跨域 CORS 问题，解决方案写在哪个文件里？"

→ AI 先用 mcp_discover(action="tool", server="pwiki", name="wiki_search") 确认工具说明与参数
→ 再调用 mcp_call(server="pwiki", tool="wiki_search", arguments={ query: "CORS 跨域" })
→ Pwiki 返回匹配条目；AI 可继续调用 wiki_read_entry 读取命中内容
→ AI 基于 MCP 返回内容回答，无需内嵌知识库
```

---

## 📂 项目结构

```
pi-agent-extensions/
├── README.md                    # 本文件 — 特性对比 & 快速上手
├── AGENTS.md                    # AI 判断、主动性与协作风格契约
├── SYSTEM.md                    # 阶段、授权、工具、风险与验证契约
├── settings.json                # 默认模型配置
│
├── extensions/                  # 核心扩展（TypeScript，全部模块化拆分 ≤15KB/文件）
│   │
│   ├── parallel-agent.ts        # ⭐ 子 Agent 并行调度 v10 — 主入口
│   ├── parallel-agent/          #   子模块 (lib/5 + tools/7 + tests)
│   │
│   ├── provider-manager.ts      # ⭐ 自定义模型供应商 — 主入口（21 行）
│   ├── provider-manager/        #   子模块 (6 文件: lib/5 + tools/1)
│   │
│   ├── model-switch.ts          # ⭐ 模型热切换 + 分级系统 — 主入口（116 行）
│   ├── model-switch/            #   子模块 (5 文件: lib/2 + commands/2 + tools/1)
│   │
│   ├── attention-buffer.ts      # ⭐ 自主注意力暂存器 — 主入口（89 行）
│   ├── attention-buffer/        #   子模块 (8 文件: lib/3 + tools/5)
│   │
│   ├── work-mode.ts             # 工作流运行时组装入口
│   ├── work-mode/               #   阶段/授权、Work Contract、风险矩阵、审计、真实进度
│   │
│   ├── cmd-tool.ts              # Windows cmd.exe（自动 chcp）
│   ├── powershell-tool.ts       # Windows PowerShell（UTF-8 / Select-String）
│   ├── context-usage.ts         # /context 上下文用量浮层
│   ├── token-stats.ts           # 状态栏 Token 百分比环
│   │
│   ├── mcp/                     # ⭐ 通用 stdio MCP Bridge
│   │   ├── index.ts             #     mcp_manage + mcp_discover + mcp_call 工具入口
│   │   ├── lib/                 #     配置、连接池、Pwiki 风险策略
│   │   └── __tests__/           #     配置与调用边界测试
│   │
│   └── lib/
│       ├── agent-bus.ts         # 全局消息总线单例
│       └── confirm-bus.ts       # 子 Agent 安全弹窗路由
│
├── skills/                      # 5 个项目技能的发布源
│   ├── pi-ext-dev/              # Extension API 开发标准
│   ├── pi-ext-code-map/         # 目录 & 依赖速查（L0，委派 Haiku）
│   ├── pi-ext-workflow/         # 开发 → 部署 → 测试闭环
│   ├── pi-ext-change-model/     # 跨模块变更影响分析
│   ├── pi-ext-tui-dev/          # TUI 渲染组件开发规范
│   └── agent-browser/           # 浏览器自动化
│
├── Pwiki/                       # ⭐ Wiki 独立 npm 包 @llangtop/pwiki-{core,mcp,cli}
├── pi-main/                     # pi 内核源码（只读参考）
└── backups/                     # 历史备份
```

---

## Pwiki Web 知识库管理端

`Pwiki/` 以 `@llangtop/pwiki-core` 为核心，通过 `@llangtop/pwiki-api` 提供
`/api/v1` HTTP API，再由 `@llangtop/pwiki-webpage` 提供浏览器页面适配：

```text
core  →  api  →  webpage
```

Web 管理端当前支持：

- Markdown 文件树、知识库切换、筛选、阅读和编辑；
- `keyword` / `semantic` / `hybrid` 搜索，以及可选的二次精排开关；
- 搜索历史和搜索结果恢复，记录保存在浏览器本地；
- 多窗口管理、已打开/未打开页面区分和独立的新建工作区；
- 新工作区中的最近关闭 Markdown 文件恢复；
- 创建、保存、重命名、移动、删除和刷新索引；
- 右侧 Markdown 大纲、文件属性和六套主题配色。

在 `Pwiki` 目录启动页面服务：

```bash
npm run build -w @llangtop/pwiki-webpage
npm run start -w @llangtop/pwiki-webpage -- --port 4317
```

打开 [http://127.0.0.1:4317/](http://127.0.0.1:4317/)。页面服务同时挂载 `/api/v1`；
本机回环地址默认允许数据源管理，非回环部署需要显式加上
`--allow-source-management`。当前 API 没有身份认证和 TLS，适合本机或受控内网，
不要直接暴露到公网。

详细说明见 [`Pwiki/README.md`](./Pwiki/README.md)、[`Pwiki/api/README.md`](./Pwiki/api/README.md)
和 [`Pwiki/webpage/README.md`](./Pwiki/webpage/README.md)。

---

## 📦 安装

```bash
# 克隆到 pi 的全局扩展目录
git clone https://gitea.llang.top/li/pi-agent-extensions.git ~/.pi/agent/extensions

# 或手动复制（包含所有子目录）
cp extensions/*.ts ~/.pi/agent/extensions/
cp -r extensions/mcp/ ~/.pi/agent/extensions/mcp/
cp -r extensions/work-mode/ ~/.pi/agent/extensions/work-mode/
cp -r extensions/parallel-agent/ ~/.pi/agent/extensions/parallel-agent/
cp -r extensions/provider-manager/ ~/.pi/agent/extensions/provider-manager/
cp -r extensions/model-switch/ ~/.pi/agent/extensions/model-switch/
cp -r extensions/attention-buffer/ ~/.pi/agent/extensions/attention-buffer/
cp extensions/lib/*.ts ~/.pi/agent/extensions/lib/

# MCP bridge 需要自己的运行时依赖
cd ~/.pi/agent/extensions/mcp && npm install --omit=dev --ignore-scripts
```

项目开发 Skill 已位于仓库 `.pi/skills/`，进入仓库时由 Pi 自动加载。不要再复制到 `~/.pi/agent/skills/`，否则同名的项目级与用户级 Skill 会产生 collision。

在 pi 中运行：

```
/reload
```

> **依赖**：大多数扩展使用 pi 内置的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`、`@earendil-works/pi-tui`；`extensions/mcp/` 额外依赖固定版本的 `@modelcontextprotocol/sdk`，按上面的命令安装。

---

## 🛠️ 开发

先读 [AGENTS.md](./AGENTS.md) 与 [SYSTEM.md](./SYSTEM.md)；扩展结构和运行时边界见本仓库 skills 与 `docs/`。

快速开发闭环：

```bash
# ① 编辑 → ② 无删除预览；核对后才移除 /L
robocopy D:\demo\pi-agent-extensions\extensions C:\Users\93061\.pi\agent\extensions /E /XD .git __tests__ /L

# 如行为规范也有变化且用户已明确授权，比较后单独同步（不属于 extensions 镜像）
git diff --no-index -- AGENTS.md C:\Users\93061\.pi\agent\AGENTS.md
git diff --no-index -- SYSTEM.md C:\Users\93061\.pi\agent\SYSTEM.md
Copy-Item -LiteralPath .\AGENTS.md -Destination C:\Users\93061\.pi\agent\AGENTS.md -Force
Copy-Item -LiteralPath .\SYSTEM.md -Destination C:\Users\93061\.pi\agent\SYSTEM.md -Force

# ③ 在 pi 中 /reload → ④ 测试 → ⑤ 核对并提交明确文件
git status --short
git diff --check
git add <本次变更的明确文件>
git commit -m "feat(extensions): 描述"
```

---

## 📄 License

MIT
