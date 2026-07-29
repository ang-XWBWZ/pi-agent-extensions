# Pi Agent Extensions

> **给 pi coding agent 装上工程化引擎。** 不改内核一行代码，通过 Extension API 赋予其子 Agent 并行调度、Windows 双引擎、三模式管控、模型热切换、注意力暂存、知识库检索等 10 项高级能力。

---

## 原生 vs 扩展

pi 原生仅提供 `read` / `write` / `edit` / `bash` 四个基础工具：

| 维度 | pi 原生 | 装上扩展后 |
|------|:---:|------|
| **可用工具** | 4 个 | **18 个**（14 个新增 AI 工具 + 4 个原生） |
| **用户命令** | 0 个自定义 | **25+ 个**（`/tier` `/note` `/wiki-search` `/context` 等） |
| **并行执行** | ❌ 纯串行 | ✅ `spawn_agent` 同时派发 N 个子 Agent 后台并行 |
| **Windows 中文** | ❌ bash 编码适配差 | ✅ `cmd` + `powershell` 双引擎，原生 UTF-8 |
| **执行管控** | ❌ 无模式概念 | ✅ Plan → Work → YOLO 三模式 + 安全守卫 |
| **计划可视化** | ❌ 无 | ✅ 逻辑顺序计划面板，7 种操控 API |
| **Token 监控** | ❌ 不可见 | ✅ 状态栏实时百分比环 + `/context` 浮层 |
| **模型切换** | ❌ 需手动改配置重启 | ✅ 热切换 + L0/L1/L2 三级分层 + 六级思考深度 |
| **自定义供应商** | ❌ 需改内核 | ✅ `manage_providers` 注册 OpenAI/Anthropic 兼容供应商，自动模型发现 |
| **注意力暂存** | ❌ compaction 丢上下文 | ✅ `attention_add` 粘性记忆，sticky 跨 compaction 保留 |
| **知识库** | ❌ 无内置检索 | ✅ `/wiki-search` 全文秒搜 + LLM 语义编译 + AST 解析 |
| **Agent 间通信** | ❌ 无 | ✅ AgentBus 广播/点对点 + ConfirmBus 安全弹窗路由 |
| **子 Agent 控制** | ❌ 无 | ✅ 完整生命周期：`kill` `abort` `pause` `resume` `save` `status` |
| **安全护栏** | ❌ 无路径保护 | ✅ 自动拦截对 `.git/` `.pi/` `.agents/` 等的 write/edit |

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
│三模式  ││-agent  ││-manager││switch  ││-buffer ││tool    ││-usage    │
│安全守卫││子Agent ││自定义  ││层级系统││注意力  ││power-  ││token-    │
│计划面板││调度 v10││供应商  ││热切换  ││暂存器  ││shell   ││stats     │
│        ││        ││注册管理││六级思考││粘性记忆││双引擎  ││可观测    │
└────────┘└───┬────┘└────────┘└────────┘└────────┘└────────┘└──────────┘
              │                                           │
     ┌────────┴────────┐                          ┌──────┴──────┐
     ▼                 ▼                          ▼             ▼
┌──────────┐    ┌─────────────┐            ┌────────┐    ┌──────────┐
│agent-bus │    │confirm-bus  │            │wiki.ts │    │wiki/     │
│全局消息  │    │安全弹窗路由   │            │知识库  │    │18 个子模块│
│总线单例  │    │             │            │入口    │    │LLM+AST   │
└──────────┘    └─────────────┘            └────────┘    └──────────┘
```

---

## 🔥 高级特性详解

### 1. 子 Agent 并行调度 — `parallel-agent.ts` + `parallel-agent/` v10

把复杂问题拆成 N 个子任务，派发到后台并行执行，结果自动汇入主对话。

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
| `spawn_agent` | 多任务并行派发，支持模型指定（`model`/`tier`）、skill 注入、上下文携带、`resumeFrom` 存档恢复 |
| `check_agent_results` | 非阻塞轮询 / 阻塞等待 / 列出所有 Job |
| `send_agent_message` | Agent 间消息广播 / 点对点通信 |
| `control_agent` | 完整生命周期：`kill` `abort` `pause` `resume` `status` `list` `save` `list_saves` `delete_save` |
| `update_agent_task` | 每个子 Agent 独立更新任务进度、当前步骤、阶段摘要和追加式备注 |
| `manage_skills` | skill 黑名单管理，即时生效 |
| `manage_tools` | tool 黑名单管理，子进程完全无感知 |

**v10 亮点**：模型分级联动、克隆恢复和生命周期控制基础上，新增超时前自动存档、失败中间产出保留、每任务独立面板与备注、输出快照增量落盘到 `~/.pi/agent/sub-agent-tasks/`、安全的状态文件路径映射，以及不会终止宿主进程的异常边界。

---

### 2. Windows 双引擎 — `cmd-tool.ts` + `powershell-tool.ts`

| 特性 | `cmd` | `powershell` |
|------|:---:|:---:|
| 启动速度 | ⚡ ~100ms | 🐢 ~1s |
| 简单命令 | ✅ `dir` `type` `echo` | ✅ `ls` `gc` `echo` |
| 中文 UTF-8 文件 | ⚠️ 需 `codepage=65001` | ✅ 原生 UTF-8，零配置 |
| 跨编码中文搜索 | ❌ `findstr` 字节匹配 | ✅ `Select-String` 自动检测 |
| 命令中文安全 | ⚠️ spawn ANSI 转换损毁 | ✅ Base64(UTF-16LE) 零损伤 |
| 超时控制 | ✅ 默认 30s，无硬上限 | ✅ 默认 60s，无硬上限 |
| 截断保护 | ✅ 2000 行 / 50KB | ✅ 2000 行 / 50KB |

```powershell
# 杀手特性 — 跨编码搜索
Select-String -Path *.txt -Pattern "连接超时"
→ utf8-log.txt:42:  [ERROR] 数据库连接超时，重试第3次
→ gbk-log.txt:17:   [ERROR] 数据库连接超时，重试第1次
```

---

### 3. 智能工作模式 — `work-mode.ts` + `work-mode/` v3

三模式 + 逻辑顺序计划面板 + 路径安全守卫。

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **Plan** | 先出计划 → 用户确认 → 逐步执行 | 复杂多步骤任务、跨模块重构 |
| **Work** | 直接执行 + 安全守卫（默认） | 常规开发、单文件修改 |
| **YOLO** | 全自动跳过所有确认 | 信任度高的批量操作 |

计划面板支持 7 种操控：`set_steps` `set_step_status` `insert_step` `delete_step` `update_step` `complete` `clear`。

安全守卫自动拦截对 `.git/` `.pi/` `.agents/` `node_modules/` 的 write/edit。

---

### 4. 模型热切换 + 层级系统 — `model-switch.ts` + `model-switch/`

L0/L1/L2 三级模型分层 + 六级思考深度 (`off`～`xhigh`) + 自定义供应商管理。

| 工具/命令 | 能力 |
|------|------|
| `switch_model` | AI 按任务复杂度自行决策——简单查询降级快速模型，复杂分析切换高级模型 |
| `/tier` `/tier-add` `/tier-remove` | 模型分级管理，L0(快速)/L1(主要)/L2(高级) |
| `/thinking` `/tier-set-thinking` | 六级思考深度，按层级预设 |
| `/set-default` `/reset-default` | 持久化默认模型/层级 |
| `/model-info` | 查看当前/默认模型状态 |

---

### 5. 自定义供应商管理 — `provider-manager.ts` + `provider-manager/`

| 工具 | 能力 |
|------|------|
| `manage_providers` | 注册/移除/列出 OpenAI/Anthropic 兼容供应商，自动模型发现、上下文窗口检测、流兼容模式 |

`finish-reason-fallback` 模式解决上游流缺少 `finish_reason` 的错误。支持 `supportsUsageInStreaming` 开关。

---

### 6. 注意力暂存器 — `attention-buffer.ts` + `attention-buffer/` v4

AI 自主调用的粘性记忆系统。

| 工具 | 能力 |
|------|------|
| `attention_add` | AI 自主写入临时备忘，支持 `sticky` 粘性标记（跨 compaction 保留） |
| `attention_list` | 查看全部暂存内容 + 提醒/轮换阈值进度 |
| `attention_clear` | 清空暂存器，重置计数器 |
| `attention_summarize` | 将多条合并为一条总结 |
| `attention_config` | 调整阈值（提醒/轮换/容量） |
| `/note` | 用户手动管理暂存器的兜底命令 |

每轮通过 context 事件自动注入 buffer 内容，状态栏 `📌N` 实时提示。

---

### 7. 可观测性 — `context-usage.ts` + `token-stats.ts`

| 组件 | 能力 |
|------|------|
| 状态栏 Token 环 | 实时百分比指示器，即将溢出时预警 |
| `/context` 命令 | 浮层展示 System / Skills / 对话的 Token 用量占比 |

---

### 8. Wiki 知识库 — `wiki.ts` + `wiki/` v5.4

AST 精确解析 + bge 语义向量 + LLM 语义编译 + 文件追踪 + 质心降噪。

| 命令 / 工具 | 能力 |
|------|------|
| `wiki_load_source` | 加载数据源，AST 解析 → MD5 追踪 → 自动建索引 |
| `wiki_search` | 关键词 / 语义 / 混合三模式搜索，RRF 融合排序 |
| `kb_search` | LLM 可主动调用，搜索知识库辅助回答问题 |
| `wiki_compile_file` | LLM 语义编译：提取 concepts / aliases / normalizedText |
| `wiki_store_file_compiled` | 存储编译结果，同步计算 LLM 向量 |
| `wiki_refresh` | 增量更新，检测文件增/删/改 |
| `wiki_status` | 查看索引 + 编译进度 |

**技术栈**: unified + remark-parse AST · bge-m3 ONNX · 质心降噪 · RRF(k=60) · manifest MD5

> ⚠️ **核心铁律**：wiki 数据源操作必须通过 wiki 工具 API 完成，禁止使用 `bash`/`cmd`/`read`/`write`/`edit` 直接操作。

---

### 9. Agent 通信层 — `agent-bus.ts` + `confirm-bus.ts`

| 组件 | 能力 |
|------|------|
| **AgentBus** | 跨 session 消息广播/点对点通信，EventEmitter 单例，基于 `globalThis` 跨 reload 持久 |
| **ConfirmBus** | 子 Agent 安全弹窗路由，操作确认回传主 Agent |

---

## 🎬 实战场景

### 多模块代码审查
```
你: "审查 src/auth、src/api、src/db 三个模块的安全漏洞"
→ AI 自动 spawn_agent × 3 并行审查 → 完成后自动推送 → AI 汇总安全报告
```

### 中文日志排查
```
你: "帮我在 logs/ 下搜所有包含'数据库连接超时'的行"
→ AI 自动选 powershell → Select-String 跨编码搜索 → 展示完整结果
```

### 批量重构 + 计划管控
```
你: "把 src/ 下所有 .ts 文件的 console.log 替换为 logger.debug"
→ AI 输出计划面板 → 逐步骤推进 → 安全守卫保护 node_modules/
```

### Token 预警保上下文
```
状态栏: [████████░░] 87%
→ AI 主动操作：委派子 Agent / 压缩历史 / 使用 kb_search 代替全量读取
```

---

## 📂 项目结构

```
extensions/
├── parallel-agent.ts            # 子 Agent 并行调度 v10 — 主入口
├── parallel-agent/              #   子模块 (lib/6 + tools/7)
├── provider-manager.ts          # 自定义供应商管理 — 主入口
├── provider-manager/            #   子模块 (lib/5 + tools/1)
├── model-switch.ts              # 模型热切换 + 层级系统 — 主入口
├── model-switch/                #   子模块 (lib/2 + commands/2 + tools/1)
├── attention-buffer.ts          # 注意力暂存器 — 主入口
├── attention-buffer/            #   子模块 (lib/3 + tools/5)
│
├── work-mode.ts + work-mode/    # 三模式 + 安全守卫 + 计划面板
├── cmd-tool.ts                  # Windows cmd.exe
├── powershell-tool.ts           # Windows PowerShell
├── context-usage.ts             # 上下文用量浮层
├── token-stats.ts               # 状态栏 Token 环
│
├── wiki.ts + wiki/              # Wiki 知识库 (18 个子模块)
│
└── lib/
    ├── agent-bus.ts             # 全局消息总线
    └── confirm-bus.ts           # 安全弹窗路由
```

> 全部模块化拆分，单文件均 ≤15KB。

---

## 📦 安装

```bash
# 克隆到 pi 的全局扩展目录
git clone https://github.com/your-username/pi-agent-extensions.git ~/.pi/agent/extensions

# 或手动复制（含所有子目录）
cp extensions/*.ts ~/.pi/agent/extensions/
cp -r extensions/wiki/ ~/.pi/agent/extensions/wiki/
cp -r extensions/work-mode/ ~/.pi/agent/extensions/work-mode/
cp -r extensions/parallel-agent/ ~/.pi/agent/extensions/parallel-agent/
cp -r extensions/provider-manager/ ~/.pi/agent/extensions/provider-manager/
cp -r extensions/model-switch/ ~/.pi/agent/extensions/model-switch/
cp -r extensions/attention-buffer/ ~/.pi/agent/extensions/attention-buffer/
cp extensions/lib/*.ts ~/.pi/agent/extensions/lib/
```

在 pi 中 `/reload` 即可。

> **依赖**：扩展使用 pi 内置的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`、`@earendil-works/pi-tui`，无需额外安装。

### Wiki 语义搜索（可选）

```bash
# 安装 npm 依赖
~/.pi/agent/extensions/wiki/scripts/init-wiki-deps.bat
# 下载语义模型 bge-m3 (~570MB)
~/.pi/agent/extensions/wiki/scripts/init-wiki-model.bat bge-m3
```

---

## 📄 License

MIT
