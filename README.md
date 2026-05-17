# Pi Agent Extensions

> 一套为 [pi coding agent](https://github.com/earendil-works/pi-mono) 量身打造的生产级扩展集合，赋予其子 Agent 并行调度、模型热切换、上下文监控等高级能力。

## 为什么需要这些扩展？

pi 本身是一个极简的终端 AI 编码助手，只提供 `read` / `write` / `edit` / `bash` 四个基础工具。这套扩展在不修改 pi 内核的前提下，大幅拓展了它的工程化能力：

- **子 Agent 系统** — 将复杂任务拆解到多个独立 Agent 并行执行，结果自动汇入主对话
- **Windows 原生支持** — 为没有 WSL/Bash 的环境提供 `cmd` 工具
- **运行时可观测** — 实时统计上下文占用、子 Agent 进度可视化
- **灵活切换** — Plan/Work/YOLO 三模式 + LLM 可自行切换模型

## 扩展列表

| 扩展 | 文件 | 功能 |
|------|------|------|
| 🔀 子 Agent 系统 | `parallel-agent.ts` | v8 · 并行派发子 Agent，AbortSignal 支持，生命周期管理，结果自动注入 |
| 🚌 Agent 通信总线 | `lib/agent-bus.ts` | 全局 EventEmitter，跨 session 消息传递 |
| ✅ 确认弹窗总线 | `lib/confirm-bus.ts` | 子 Agent 的安全确认弹窗路由至主 session |
| 🪟 Windows 命令工具 | `cmd-tool.ts` | 用 `cmd.exe` 替代 `bash`，适配 Windows 环境 |
| 🔄 模型热切换 | `model-switch.ts` | LLM 可通过 `switch_model` 工具自行切换模型 |
| 🎯 工作模式 | `work-mode.ts` | v3 · Plan/Work/YOLO，滑动窗口计划面板，Unicode 状态图标 |
| 📊 上下文统计 | `context-usage.ts` | `/context` 命令，浮层展示 token 占用明细 |
| 💍 上下文环 | `token-stats.ts` | 状态栏实时显示上下文使用百分比 |

---

## 核心亮点：子 Agent 系统

### 架构

```
┌──────────────────────────────────────────────────┐
│                    主 Agent                       │
│  spawn_agent ──→ 立即返回 jobId                   │
│       │                                           │
│       ↓ 注册完成回调                               │
│  用户正常交互 ←───────────────┐                    │
│       │                       │                    │
│       │   子 Agent₁ ●─────────┤                    │
│       │   子 Agent₂ ●─────────┤  后台并行运行       │
│       │   子 Agent₃ ●─────────┘                    │
│       │                       │                    │
│       ↓  全部完成             │                    │
│  autoInject 推送结果 ─────────┘                    │
│       ↓                                           │
│  LLM 自动看到结果 → 无需阻塞等待                    │
└──────────────────────────────────────────────────┘
```

### 提供的工具

| 工具 | 用途 |
|------|------|
| `spawn_agent` | 派发子 Agent，支持多任务并行 + 上下文注入 + skill 加载 |
| `check_agent_results` | 非阻塞轮询进度 / 阻塞等待完成 / 列出所有 Job |
| `send_agent_message` | Agent 间消息传递（广播 / 点对点） |
| `control_agent` | 完整生命周期：`kill` / `abort` / `pause` / `resume` / `send` / `list` / `status` |

### v8 改进

- **AbortSignal 支持** — 4 个工具的 `execute()` 全部接入 AbortSignal，`check_agent_results(wait=true)` 可被用户取消
- **Promise 反模式修复** — `runSingleAgent` 从 `new Promise(async)` 改为同步 executor + async IIFE
- **异常日志** — 8 处静默吞异常改为 `console.warn`，问题排查不再黑盒

### v7 新特性：结果自动注入

子任务全部完成后，结果通过 `steer` 机制自动推送到主对话——**主 Agent 不再需要阻塞式等待**。你在派发任务后可以继续交互，结果到了自会出现在对话中。

---

## 计划面板 v3

| 特性 | 说明 |
|------|------|
| Unicode 图标 | `✅` 完成 `▶` 进行中 `○` 待定 `❌` 出错 |
| 命令 ≠ 任务失败 | 命令返回非零退出码不再自动中断执行，由 AI 自主判断 |
| 滑动窗口 | 面板以当前步骤为中心显示 5 步，前后省略提示，始终跟踪最新进度 |

---

## 安装

```bash
# 克隆到 pi 的全局扩展目录
git clone https://gitea.llang.top/li/pi-agent-extensions.git ~/.pi/agent/extensions-gitea

# 或者直接复制文件到 ~/.pi/agent/extensions/
cp extensions/*.ts ~/.pi/agent/extensions/
cp extensions/lib/*.ts ~/.pi/agent/extensions/lib/
```

在 pi 中运行 `/reload` 即可加载。

> **依赖**：扩展使用 pi 内置的 `@earendil-works/pi-coding-agent`、`typebox`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`，无需额外安装。

---

## 快速上手

### 并行分析多个文件

```
> 分析这 3 个模块的代码质量，给出优化建议
```

LLM 会自动调用 `spawn_agent` 将 3 个模块分发给 3 个子 Agent 并行分析，完成后结果自动出现在对话中。

### 切换模型

LLM 可自行调用 `switch_model` 在可用模型间切换，无需手动配置。

### 查看上下文占用

```
/context
```

浮层展示 System / Skills / 用户上下文的 token 用量占比。

---

## License

MIT
