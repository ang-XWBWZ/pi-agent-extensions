# Pi Agent Extensions

> **给 pi coding agent 装上工程化引擎。** 不改内核一行代码，通过 Extension API 赋予其子 Agent 并行调度、Windows 双引擎、三模式管控、上下文监控、模型热切换、知识库检索等 8 项高级能力。

---

## 原生 vs 扩展：一目了然

pi 原生仅提供 `read` / `write` / `edit` / `bash` 四个基础工具。以下是装上扩展后的能力跃迁：

| 维度 | pi 原生 | 装上扩展后 |
|------|:---:|------|
| **可用工具** | 4 个 | **12 个**（8 个新增 AI 工具 + 4 个原生） |
| **用户命令** | 0 个自定义 | **17 个**（`/plan` `/wiki-search` `/context` 等） |
| **并行执行** | ❌ 纯串行，一个任务一个任务读 | ✅ `spawn_agent` 同时派发 N 个子 Agent 后台并行 |
| **Windows 中文** | ❌ `bash` 工具编码适配差，中文乱码 | ✅ `cmd` + `powershell` 双引擎，原生 UTF-8 / 智能 GBK |
| **执行管控** | ❌ 无模式概念，AI 自由发挥 | ✅ Plan → 确认 → Work → 推进 YOLO 三模式 + 安全守卫 |
| **计划可视化** | ❌ 无 | ✅ 逻辑顺序计划面板，步骤独立生命周期，7 种操控 API |
| **Token 监控** | ❌ 不可见，突然截断 | ✅ 状态栏实时百分比环 + `/context` 浮层明细 |
| **模型切换** | ❌ 需手动改配置重启 | ✅ `switch_model` 热切换，AI 按任务复杂度自行决策 |
| **知识库** | ❌ 无内置检索 | ✅ `/wiki-search` 全文秒搜，TUI 面板直显，`kb_search` AI 工具 |
| **Agent 间通信** | ❌ 无 | ✅ AgentBus 广播 / 点对点 + ConfirmBus 安全弹窗路由 |
| **子 Agent 控制** | ❌ 无 | ✅ 完整生命周期：`kill` · `abort` · `pause` · `resume` · `status` · `save` |
| **子 Agent 克隆** | ❌ 无 | ✅ 存档/恢复/克隆，`resumeFrom` 继承上下文并行分发 |
| **安全护栏** | ❌ 无路径保护 | ✅ 自动拦截对 `.git/` `.pi/` `.agents/` 等的 write/edit |

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────┐
│                    pi 内核（只读，不修改）                  │
│            read · write · edit · bash                    │
└──────────────────────┬──────────────────────────────────┘
                       │ Extension API
     ┌─────────┬───────┼───────┬─────────┬─────────┐
     ▼         ▼       ▼       ▼         ▼         ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌──────────┐
│work-m. ││parallel││cmd-    ││context ││wiki    ││model-    │
│三模式  ││-agent  ││tool    ││-usage  ││知识库  ││switch    │
│安全守卫││子Agent ││power-  ││token-  ││搜索/   ││模型热切  │
│计划面板││调度 v8 ││shell   ││stats   ││索引/   ││默认持久  │
│        ││        ││双引擎  ││可观测  ││TUI面板 ││          │
└────────┘└───┬────┘└────────┘└────────┘└────────┘└──────────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
┌──────────┐    ┌─────────────┐
│agent-bus │    │confirm-bus  │
│全局消息  │    │安全弹窗路由   │
│总线单例  │    │             │
└──────────┘    └─────────────┘
```

---

## 🔥 高级特性详解

### 1. 子 Agent 并行调度 — `parallel-agent.ts` v8

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
| `send_agent_message` | Agent 间消息广播 / 点对点通信 |
| `control_agent` | 完整生命周期：`kill` `abort` `pause` `resume` `status` `list` |

**v8 亮点**：AbortSignal 全链路支持、Promise 反模式修复、8 处异常日志不再静默吞错、`autoInject` 完成自动推送。

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

### 3. 智能工作模式 — `work-mode.ts` v3

**原生痛点**：AI 自由发挥，复杂任务不规划直接改代码，简单任务却反复确认。没有安全护栏——AI 可能误写 `.git/` 或 `node_modules/`。

**扩展方案**：三模式 + 逻辑顺序计划面板 + 路径安全守卫。

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **Plan** | 先出计划 → 用户确认 → 逐步执行 | 复杂多步骤任务、跨模块重构 |
| **Work** | 直接执行 + 安全守卫（默认） | 常规开发、单文件修改 |
| **YOLO** | 全自动跳过所有确认 | 信任度高的批量操作 |

**计划面板**（逻辑顺序模型，每步独立生命周期）：

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

**`manage_plan` API**：AI 通过工具调用操控面板 — `set_steps` `set_step_status` `insert_step` `delete_step` `update_step` `complete` `clear`。

**安全守卫**：自动拦截对 `.git/` `.pi/` `.agents/` `.claude/` `node_modules/` 的 write/edit 操作。

**用户命令**：`/plan` `/work` `/yolo` `/security-review` `/plan-expand` `/plan-collapse` `/plan-cancel`

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

### 5. 模型热切换 — `model-switch.ts`

**原生痛点**：切换模型需要修改配置文件并重启，小任务用大模型浪费 Token/Cost。

**扩展方案**：

| 工具/命令 | 能力 |
|------|------|
| `switch_model` 工具 | AI 按任务复杂度自行决策——简单查询降级 Haiku，复杂分析切换 DeepSeek |
| `/set-default` | 持久化默认模型到 settings.json，启动自动加载 |
| `/reset-default` | 清除默认模型配置 |
| `/model-info` | 查看当前/默认模型状态 |

**智能行为**：手动切换过的 session 不会被默认配置覆盖，避免打断用户意图。

---

### 6. Wiki 知识库 — `wiki.ts` v5.4

**原生痛点**：项目文档分散在各处，搜索靠 `grep`，结果杂乱无章。之前记录的笔记与当前对话完全隔离。

**扩展方案**：AST 精确解析 + bge 语义向量 + LLM 语义编译 + 文件追踪，构建个人语义知识操作系统。

| 命令 / 工具 | 能力 |
|------|------|
| `/wiki-load <目录>` | 加载数据源，AST 解析 → MD5 追踪 → 自动建索引 |
| `/wiki-search <关键词>` | 关键词 / 语义 / 混合三模式搜索，RRF 融合排序 |
| `kb_search` 工具 | LLM 可主动调用，搜索知识库辅助回答问题 |
| `wiki_compile_file` | LLM 语义编译：提取 concepts / aliases / normalizedText |
| `wiki_store_file_compiled` | 存储编译结果，同步计算 LLM 向量 |
| `wiki_refresh` | 增量更新，检测文件增/删/改 (+N / ~N / -N)；编译后需 refresh 才能检索 |
| `/wiki-status` | 查看索引 + 编译进度 (📝 LLM 编译: N/290 文件) |

**技术栈**: unified + remark-parse AST · bge-m3 ONNX (8192 tokens) · RRF(k=60) · manifest MD5 · 子 Agent 约束编译

**⚠️ 核心铁律 — Wiki 生命周期**

对 wiki 数据源的所有操作**必须通过 wiki 工具 API 完成**，禁止绕过：

| ❌ 禁止 | ✅ 正确做法 |
|---------|-------------|
| 使用 `bash` / `cmd` / `powershell` 查看 wiki 文件 | 用 `wiki_get_entry` / `wiki_get_chunks_raw` |
| 使用 `read` / `write` / `edit` 修改 wiki 条目 | 用 `wiki_create_entry` / `wiki_rename` / `wiki_move` |
| 终端删除文件后依赖 `wiki_refresh` 清理 | 用 `wiki_rename` 归档到 `_archived/` |
| 直接操作 `models/` / `vectors.json` 等运行时数据 | **绝对不允许** |

**编译完整生命周期**：

```
wiki_store_file_compiled  ──→ 存储 segments + 同步计算 LLM 向量
         ↓
wiki_refresh              ──→ 刷新搜索索引，LLM 向量可检索
         ↓
kb_search(mode="semantic") ──→ 验证召回效果
```

**子 Agent 约束编译**（推荐）：

```
主 Agent                                  子 Agent
  │                                          │
  ├── 准备任务描述 + 工具约束                   │
  │   - 🚫 禁止 read/write/edit/bash/cmd      │
  │   - ✅ 仅允许 wiki_get_entry /             │
  │       wiki_store_file_compiled / kb_search │
  ├── spawn_agent ───────────────────→         │
  │                              ├── wiki_get_entry ✅
  │                              ├── 拆语义段 + 组装 JSON
  │                              └── wiki_store_file_compiled ✅
  │←── 完成 ──────────────────────│
  └── wiki_refresh → kb_search 验证
```

---

### 7. Agent 通信层 — `agent-bus.ts` + `confirm-bus.ts`

**原生痛点**：不同 Agent（主 Agent、子 Agent）之间完全隔离，无法协调工作。

**扩展方案**：

| 组件 | 能力 |
|------|------|
| **AgentBus** (`globalThis.__pi_agent_bus`) | 跨 session 消息广播 / 点对点通信，EventEmitter 单例 |
| **ConfirmBus** (`globalThis.__pi_confirm_bus`) | 子 Agent 安全弹窗路由，操作确认回传主 Agent |

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
你: "把 src/ 下所有 .ts 文件的 console.log 替换为 logger.debug"

→ AI 输出 Execution Plan
  ✅ 1. 搜索所有含 console.log 的文件
  ▶ 2. 逐个替换为 logger.debug       ← 当前
  ○ 3. 检查是否遗漏直接调用
  ○ 4. 运行 lint 验证
→ 你确认 → 计划面板逐步骤推进
→ 安全守卫自动保护 node_modules/ 不受影响
→ 某步骤出错 → 标记 ❌ → 你决定跳过还是重试
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
  3. 使用 kb_search 代替全量读取文件
→ 对话正常继续，不会突然截断丢失上下文
```

### 场景 6：跨会话知识检索

```
你: "上次处理的那个跨域 CORS 问题，解决方案写在哪个文件里？"

→ AI 调用 kb_search(query="CORS 跨域") 
→ 即时命中 Obsidian 笔记中的相关条目
→ TUI 面板展示匹配结果（标题 + 片段），按相关性排序
→ AI 基于命中内容回答，无需翻 Obsidian
```

### 场景 7：子 Agent 约束编译提升搜索

```
你: "编译这几个大笔记，让搜索更准"

→ AI 准备多个编译任务
→ spawn_agent 派发子 Agent，严格约束仅 wiki 工具
→ 子 Agent 并行：wiki_get_entry 读取 → 拆语义段 → wiki_store_file_compiled 存储
→ 全部完成后 wiki_refresh 刷新索引
→ kb_search 对比测试，编译文件召回排第 1
```

---

## 📂 项目结构

```
pi-agent-extensions/
├── README.md                    # 本文件 — 特性对比 & 快速上手
├── CLAUDE.md                    # 开发指南（API 速查、架构、常见陷阱）
├── SYSTEM.md                    # AI 全局行为约束
├── settings.json                # 默认模型配置
│
├── extensions/                  # 核心扩展（TypeScript）
│   ├── work-mode.ts             # ⭐ 三模式 + 安全守卫 + 计划面板（~1060 行）
│   ├── parallel-agent.ts        # ⭐ 子 Agent 并行调度 v8（~860 行）
│   ├── cmd-tool.ts              # Windows cmd.exe（自动 chcp）
│   ├── powershell-tool.ts       # Windows PowerShell（UTF-8 / Select-String）
│   ├── model-switch.ts          # 模型热切换 + 默认持久
│   ├── context-usage.ts         # /context 上下文用量浮层
│   ├── token-stats.ts           # 状态栏 Token 百分比环
│   ├── wiki.ts                  # ⭐ Wiki 知识库入口 v5.4
│   ├── wiki/                    # Wiki 子模块 (18 文件, 均 ≤15KB)
│   │   ├── lib/                 #   核心库 (ast-chunker / file-manifest / indexer-* / semantic-* / ...)
│   │   ├── tools/               #   AI 工具 (management-* / kb-search / _helpers)
│   │   ├── commands/            #   用户命令
│   │   └── scripts/             #   一键安装
│   └── lib/
│       ├── agent-bus.ts         # 全局消息总线单例
│       └── confirm-bus.ts       # 子 Agent 安全弹窗路由
│
├── skills/                      # 项目技能（按场景自动触发）
│   ├── pi-ext-dev/              # Extension API 开发标准
│   ├── pi-ext-code-map/         # 目录 & 依赖速查（L0，委派 Haiku）
│   ├── pi-ext-workflow/         # 开发 → 部署 → 测试闭环
│   ├── pi-ext-change-model/     # 跨模块变更影响分析
│   ├── pi-ext-tui-dev/          # TUI 渲染组件开发规范
│   ├── agent-browser/           # 浏览器自动化
│   └── pi-wiki/                 # ⭐ Wiki 知识库操作技能
│
├── pi-main/                     # pi 内核源码（只读参考）
└── backups/                     # 历史备份
```

---

##
 📦 安装

### 快速开始

```bash
# 克隆到 pi 的全局扩展目录
git clone https://github.com/your-username/pi-agent-extensions.git ~/.pi/agent/extensions

# 安装 wiki 依赖（npm 包 + 语义模型）
~/.pi/agent/extensions/wiki/scripts/init-wiki-deps.bat
~/.pi/agent/extensions/wiki/scripts/init-wiki-model.bat bge-m3

# 加载数据源
# 在 pi 中执行：
#   /reload
#   wiki_load_source 你的笔记目录
#   wiki_semantic(action="on")
```

### 依赖说明

| 依赖 | 安装方式 |
|------|----------|
| **pi 内置扩展框架** (`@earendil-works/pi-*`) | 随 pi 自带，无需额外安装 |
| **typebox** | pi 内置依赖，无需额外安装 |
| **wiki npm 包** (transformers, ONNX runtime) | `init-wiki-deps.bat` 自动安装到 `wiki/node_modules/` |
| **语义模型 bge-m3** (~570MB, ONNX INT8) | `init-wiki-model.bat bge-m3` 自动从 hf-mirror.com 下载 |

### 首次使用 wiki

```
/reload                          # 加载所有扩展
wiki_load_source 你的笔记目录     # 加载数据源
wiki_list_sources                # 确认已加载
wiki_semantic(action="on")      # 启用语义搜索（自动下载模型）
wiki_refresh                     # 构建索引
```

> ⚠️ **Wiki 生命周期铁律**：所有 wiki 操作必须通过 wiki 工具 API 完成（`wiki_get_entry`、`wiki_create_entry`、`kb_search` 等），**禁止**使用 `bash`/`cmd`/`read`/`write`/`edit` 直接操作数据源文件。

---

## 🛠️ 开发

详见 [CLAUDE.md](./CLAUDE.md) — 完整开发指南，包括 Extension API 速查、分层架构、依赖链路、编码规范、10 大常见陷阱。

### 开发闭环

```bash
# ① 编辑 extensions/*.ts
# ② 同步到 pi 生产目录
cp -r extensions/* ~/.pi/agent/extensions/

# ③ 在 pi 中 /reload
# ④ 测试功能
# ⑤ 提交
git add -A && git commit -m "feat(extensions): 描述"
```

> ⚠️ robocopy `/MIR` 会删除目标中源不存在的文件。必须排除运行时生成物：`/XD node_modules models` `/XF vector* settings.json manifest.json compiled.json`，否则每次部署都会清空已下载的模型和已生成的向量。

### 项目结构

```
pi-agent-extensions/
├── extensions/          # 核心扩展源码（TypeScript）
│   ├── work-mode.ts     # 三模式 + 安全守卫 + 计划面板
│   ├── parallel-agent.ts# 子 Agent 并行调度
│   ├── cmd-tool.ts      # Windows cmd.exe 工具
│   ├── powershell-tool.ts# Windows PowerShell 工具
│   ├── model-switch.ts  # 模型热切换
│   ├── context-usage.ts # 上下文浮层
│   ├── token-stats.ts   # Token 环指示器
│   ├── wiki.ts          # Wiki 知识库入口
│   ├── wiki/            # Wiki 子模块（lib/tools/commands/scripts）
│   └── lib/             # 通信层（agent-bus.ts / confirm-bus.ts）
├── skills/              # 项目技能（含 pi-wiki 操作指南）
├── github-dist/         # GitHub 发布版（本文件）
└── wiki-dev/            # Wiki 独立开发目录
```

---

## 🧠 技能说明

项目内置 **pi-wiki** 技能，指导 AI 正确操作 wiki 知识库。

### pi-wiki

**位置**: `skills/pi-wiki/SKILL.md`

**作用**: 教导 AI 全程遵守 wiki 生命周期，禁止通过终端或读写工具直接操作数据源。

**触发条件**: 用户提到 "wiki" / "知识库" / "搜索" / "编译" 等关键词时自动加载。

**核心约束**:

| ❌ 禁止 | ✅ 正确做法 |
|---------|-------------|
| 使用 `bash` / `cmd` / `read` / `write` / `edit` 操作 wiki 数据源 | 使用 `wiki_get_entry` / `wiki_create_entry` / `wiki_rename` / `wiki_move` |
| 终端删除文件 | 用 `wiki_rename` 归档到 `_archived/` |
| 直接操作运行时数据 (`models/` `vectors.json`) | **绝对不允许** |

### 安装技能

```bash
# 复制技能到 AI 的技能目录
cp -r skills/pi-wiki ~/.pi/agent/skills/
# 或完整复制所有技能
cp -r skills/* ~/.pi/agent/skills/
```

---

## 📄 License

MIT
