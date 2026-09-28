# Pi Agent Extensions

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)
![Pi Coding Agent](https://img.shields.io/badge/Pi%20Coding%20Agent-Pi%20Package-blueviolet)
![License](https://img.shields.io/badge/License-MIT-green)
![Status](https://img.shields.io/badge/Dashboard-2--Line%20Minimal%20HUD-orange)
![Tests](https://img.shields.io/badge/Tests-135%20Passing-brightgreen)

**给 Pi Coding Agent 装上工业级工程引擎、双轨浏览器中枢与极简 HUD 仪表盘。**  
不改内核一行代码，通过官方 Pi Package 扩展规范与 PCS 渐进能力路由器，赋予其一键安装、子 Agent 并行调度、前台 Chrome CDP 真实接管、静默无头抓取、极简两行状态底栏、生成速率追踪、受控工作流、上下文深度监控、模型热切换与 MCP 接入等企业级能力。

[特性对比](#-原生-vs-扩展一目了然) • [一键安装](#-快速安装pi-package-标准) • [极简仪表盘](#-极简两行-hud-仪表盘与速率中枢) • [核心特性](#-核心特性详解) • [实战场景](#-实战场景) • [目录结构](#-目录结构) • [常用命令](#-常用命令速查)

</div>

---

## ⚡ 原生 vs 扩展：一目了然

Pi 原生仅提供 `read` / `write` / `edit` / `bash` 四个基础工具与简易终端输出。装上扩展后实现能力跃迁：

| 能力 | 原生 Pi | 装上扩展后 |
| :--- | :---: | :--- |
| **浏览器** | ❌ 无 | 前台 Chrome 接管（保留登录态） + 后台无头抓取 |
| **多任务** | 单线程串行 | 子 Agent 后台并发执行（自动汇总结果） |
| **工作流** | 无阶段区分 | Chat（对话） / Plan（规划） / Work（受控执行）三阶段防线 |
| **自动审批** | 人工频繁弹窗 | AI 语义审查 + 动态熔断防死循环 |
| **计划进度** | 仅普通文字回复 | 结构化进度面板（完成后自动折叠清理，零消息污染） |
| **状态底栏** | 3+ 行挤压屏幕 | 严格锁定 2 行极简 HUD + 实时生成速率（t/s） |
| **模型切换** | 需改配置重启 | 会话中随时热切换（L0/L1/L2 阶梯与思考深度） |
| **安装方式** | 手工拷文件、依赖容易漏 | `pi install` 一键搞定（所有子依赖自动递归安装） |

---

## 📦 快速安装（Pi Package 标准）

本项目遵循 Pi 官方标准 Package 规范与 npm Workspaces 单体架构，所有依赖（包括 MCP SDK、Puppeteer 等）在安装时**由系统自动递归拉取安装，零手动干预**。

### 1. 远端一键安装（推荐）

在终端直接运行：

```bash
pi install git:github.com/ang-XWBWZ/pi-agent-extensions
```

*Pi 会自动克隆仓库并在根目录触发依赖装配，所有扩展与技能即刻生效。*

### 2. 本地开发与挂载（实时热加载，免手动复制）

如果你克隆了本仓库进行二次开发，可直接以本地包的形式一键挂载：

```bash
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git ~/pi-agent-extensions
pi install ~/pi-agent-extensions
```

*通过本地路径挂载后，你在工作区修改任何 TypeScript 代码，Pi 启动时实时生效，彻底告别手动 `cp` 文件的旧时代！*

### 3. 查看已安装扩展

```bash
pi list
```

---

## 🌐 双轨浏览器自动化与桌面接管

通过全新引入的 `browser` 渐进式能力，兼顾“日常真实网页交互”与“后台静默信息搜集”：

```
                           ┌──────────────────────────────┐
                           │      PiAgent 浏览器能力      │
                           └───────┬──────────────┬───────┘
                                   │              │
                    需要登录态/用户交互时          单纯搜寻/阅读资料时
                                   ▼              ▼
                     ┌──────────────────┐    ┌──────────────────┐
                     │ 前台日常 Chrome   │    │ 后台静默无头     │
                     │ (Active Chrome)  │    │ (Headless)       │
                     └────────┬─────────┘    └────────┬─────────┘
                              │                       │
                     CDP (:9222 直连)         Playwright Headless
                              │                       │
                     • 保持所有 Cookie/登录态  • 后台静默运行
                     • 桌面窗口肉眼可见操作   • 零弹窗、不抢焦点
                     • 精准 DOM/无障碍树点击   • 极速抓取转 Markdown
```

### 1. 前台日常 Chrome 接管 (Active Mode)
- **保留全部登录态**：通过 CDP 协议直连本地日常 Chrome，直接操作你已登录的 GitHub、飞书、公司内网及包含验证码的网站；
- **精准 DOM 操作**：基于语义选择器与无障碍树派发原生事件，比视觉坐标点位更准；
- **隐私保护截屏**：`chrome_screenshot` 仅截取当前网页渲染内容，绝不窥探你的操作系统桌面或其他隐私窗口。
- **启动方式**：
  ```bash
  google-chrome-stable --remote-debugging-port=9222 &
  ```

### 2. 后台备用无头浏览器 (Headless Mode)
- **零干扰阅读**：提取长网页、检索技术文档时，在内存中静默拉取；
- **内核自动复用**：直接复用系统已有的 Chrome/Chromium 二进制，**无需额外下载几百兆 Chromium**；
- **自动内存回收**：采用智能无头池，5 分钟无任务自动关闭释放内存；
- **DOM 提纯降 Token**：自动剥离 `<script>`、`<style>`、`<svg>` 等无用节点，转换为 Clean Markdown，并提供字数截断与分页机制。

### 3. 工具清单（按需调用）
- `browser_read`: 读取网页正文为 Markdown（默认后台 headless，传 `mode="active"` 读当前前台 Tab）；
- `chrome_tabs`: 列出前台 Chrome 打开的所有标签页；
- `chrome_act`: 在前台 Chrome 中执行 `click`、`type`、`press_key`、`scroll`、`navigate` 等交互（纳入风险审批防线）；
- `chrome_screenshot`: 截取当前网页图像供 AI 进行视觉核验。

---

## 🖥️ 极简两行 HUD 仪表盘与速率中枢

### 1. 彻底消灭第三行：极致的终端空间利用
原生 Pi 在插件调用 `setStatus` 时会自动累加生成第 3 行甚至更多行，导致屏幕视区严重割裂。  
本扩展接管 `ctx.ui.setFooter` 自定义渲染，将所有必要指标精炼融合，**严格锁定为 2 行极简仪表盘**：

```text
Line 1: ~/projects/my-app (main) • session-1
Line 2: ↑67k ↓22k R50k W2.0k CH42.0% $0.085 3.2%/1.0M (auto) · 48.2 t/s        AUTO [就绪] · (gptplus-openai) deepseek-flash • max
```

- **Line 1（环境与定位）**：`当前工作目录 (Git 分支) • 会话名称`
- **Line 2 左侧（全量数据指标与实时速率）**：
  - `↑67k` / `↓22k`：累计输入 / 输出 Token 计数；
  - `R50k` / `W2.0k`：缓存命中读取（Cache Read）与写入（Cache Write）；
  - `CH42.0%`：最新轮次缓存命中率（Cache Hit Rate）；
  - `$0.085`：根据模型资费自动计算的累计调用成本；
  - `3.2%/1.0M (auto)`：上下文占用百分比与窗口大小（超 70% 黄色预警，超 90% 红色告警）；
  - `· 48.2 t/s`：**实时吐字速率**（流式过程中平滑跳动，生成结束后锁定精确值）。
- **Line 2 右侧（模式状态与模型融合）**：
  - `AUTO [就绪]` / `AUTO [已拦截: bash]` / `GUARDED` / `PLAN`：模式与当前拦截动作实时展示；
  - `(provider) model • thinking`：供应商、模型标识与思考深度。
  - **绝不加表情**：彻底移除 `🧠`、`🤖`、`🛑` 等任何花哨 emoji，保持清爽严肃的工程美感。

### 2. `/context` 详情浮层：速率指标全透视
输入 `/context` 命令即可唤起带完整速率分布的统计浮层，透视 System、Skills、用户消息各部分占比及首字延迟（TTFT）。

---

## 🔥 核心特性详解

### 1. 自动化工作流与安全守卫 — `work-mode/`
由协作阶段（Phase）、授权级别（Autonomy）、结构化计划（Work Contract）构成的统一安全运行时。

- **三阶段防线**：
  - **Chat**：纯对话咨询，禁止一切代码修改与终端副作用；
  - **Plan**：只读探测与分析，生成完整 Work Contract 等待人工批准；
  - **Work**：进入执行阶段，按授权模式流转。
- **三种授权等级**：
  - **Guarded（默认）**：常规开发直接放行，仅在破坏性、越界或高危操作时弹窗确认；
  - **Auto**：借助后台配置的轻量 Reviewer 模型（`/auto_model`）进行语义审批；
  - **Auto All**：显式执行 `/auto_all` 后全自动放行（非保护路径）。
- **结构化进度与纯文本提示**：
  - 进度面板全部达成后，原地紧凑折叠并在 10 秒后自动释放顶部空间；
  - 用户手动清除（`/plan-cancel`）或全部完成时，通过 `ctx.ui.notify` 弹出**精简纯文本提示（零 emoji、绝不作为对话消息提交污染上下文）**。
- **自适应延时保护**：
  - AUTO 审核弹窗超时前，若用户按方向键浏览选项，超时时间自动增加 60 秒并重置，防止误操作中断思考。

### 2. 子 Agent 并行调度集群 — `parallel-agent/`
把复杂问题拆解为独立子任务，在后台多实例并发执行，结果自动汇总。

- **强制通信与去重治理**：规范子进程生命周期报告，在消息总线层实施终态拦截，彻底杜绝重复提交结论；
- **并发派发**：`spawn_agent` 启动独立子任务，支持指定不同的模型、上下文与工作区；
- **任务面板与结论优先**：子 Agent 在每个里程碑提交结构化控制面板，避免海量原始日志撑爆主上下文；
- **状态持久化与超时安全**：任务完成自动落盘会话，超时前自动保存快照并生成 `saveId`，支持随时 `resumeFrom` 克隆恢复。

### 3. PCS 渐进式能力挂载（Progressive Capability Specification）
- **Prompt Cache 字节级冻结**：首轮 System Prompt 仅注入简短的不可变元索引卡，初始 Token 底噪从 23K+ 压缩至 ~3K；
- **按需加载（JIT）**：当需要浏览器、MCP、子 Agent 等复杂工具时，AI 调用 `load_capability` 动态增量暴露工具并注入完整 Usage 文档，保障大模型推理准确性。

### 4. 通用 stdio MCP Bridge — `mcp/`
- 原生工具映射：将外部 MCP Server（如各类本地知识库、外部数据库服务）声明的工具自动无缝注册为 Pi 本地原生工具；
- 安全分级与策略审查：支持按服务配置 strict / allow 等细粒度安全准入规则。

### 5. 模型热切换与阶梯体系 — `model-switch/`
- **L0 / L1 / L2 阶梯管理**：快速（Flash/Haiku）、主力（Sonnet/GPT-4o）、高阶（DeepSeek R1/Opus）；
- **动态热切换**：AI 可使用 `switch_model` 工具按任务复杂度自动升降级；
- **七级思考控制**：`/thinklev` 支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，支持交互式选择菜单与配置落盘。

---

## 📂 目录结构

```text
pi-agent-extensions/
├── package.json               # ⭐ 标准 Pi Package 根清单 (npm Workspaces)
├── README.md                  # 本文件 — 特性说明与使用指南
├── AGENTS.md                  # 行为与交互风格契约
├── SYSTEM.md                  # 阶段、授权与安全规则规范
│
├── token-stats.ts             # ⭐ 2 行极简 HUD 仪表盘与速率渲染
├── context-usage.ts           # ⭐ /context 上下文与详细速率透视
│
├── browser.ts                 # ⭐ 浏览器自动化 PCS 入口
├── browser/                   # ⭐ [独立子工作区] 双轨浏览器中枢 (Active Chrome & Headless)
│   ├── package.json           # 声明私有依赖: puppeteer-core
│   ├── cdp-client.ts          # 前台日常 Chrome CDP @ 9222 直连
│   ├── headless-pool.ts       # 后台备用无头浏览器池与内存回收
│   ├── page-purifier.ts       # DOM 提纯与 Clean Markdown 压缩转换
│   └── browser-tools.ts       # browser_read, chrome_tabs, chrome_act, chrome_screenshot
│
├── work-mode.ts               # 工作流与安全控制主入口
├── work-mode/                 # 阶段流转、AUTO 审查、防死循环熔断、审计
│
├── parallel-agent.ts          # 子 Agent 并行调度主入口
├── parallel-agent/            # 并发控制、强制通信总线、快照持久化
│
├── mcp/                       # ⭐ [独立子工作区] 通用 stdio MCP Bridge
│   ├── package.json           # 声明私有依赖: @modelcontextprotocol/sdk
│   └── index.ts               # MCP 协议桥接与安全策略
│
├── model-switch.ts            # 模型分级热切换与思考深度控制
├── provider-manager.ts        # 自定义模型供应商主入口与流式兼容
├── attention-buffer.ts        # 跨轮注意力暂存器主入口
├── cmd-tool.ts                # Windows CMD 极速执行引擎
├── powershell-tool.ts         # Windows PowerShell UTF-8 深度引擎
│
└── lib/                       # 全局总线、执行上下文、能力路由器与工具函数
```

---

## 🛠️ 常用命令速查

| 指令 | 作用 |
| :--- | :--- |
| `/context` | 打开上下文占用分布与详细 Token 速率指标浮层 |
| `/auto` | 切换至 AUTO 自动审批模式（需配置审核模型） |
| `/auto_stop` | 一键中止当前 AUTO 运行并回退为 GUARDED 模式 |
| `/auto_model <provider>/<model>` | 设置用于后台自动审批的轻量 AI 模型 |
| `/auto_add_prmt <提示词>` | 追加审核模型的自定义提示词 |
| `/plan-cancel` | 手动放弃并清除当前执行计划（纯文本提示，保留审计快照） |
| `/tier` / `/tier-add` | 管理 L0/L1/L2 阶梯模型配置 |
| `/thinklev` | 调节思考深度（支持 7 级 lev、交互式菜单及配置持久化） |
| `/note` | 查看并管理跨轮注意力暂存备忘录 |
| `/mcp` | 查看与管理本地 stdio MCP 服务器连接状态 |

---

## 🧪 自动化测试验证

全量核心功能均配备严格的单元与集成测试（涵盖熔断、AUTO 审核、去重通信、浏览器提纯、PCS 缓存安全性、权限边界与 SSRF 防护）：

```bash
npm test
# ℹ tests 135 | pass 135 | fail 0
```

---

## 📄 License

[MIT](LICENSE) © 2026 ang-XWBWZ & Contributors
