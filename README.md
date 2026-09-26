# Pi Agent Extensions

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)
![Pi Coding Agent](https://img.shields.io/badge/Pi%20Coding%20Agent-Extension-blueviolet)
![License](https://img.shields.io/badge/License-MIT-green)
![Status](https://img.shields.io/badge/Dashboard-2--Line%20Minimal%20HUD-orange)

**给 Pi Coding Agent 装上工业级工程引擎与极简 HUD 仪表盘。**  
不改内核一行代码，通过 Extension API 赋予其子 Agent 并行调度、极简两行状态底栏、生成速率追踪、Windows 双引擎、受控工作流、上下文深度监控、模型热切换与 MCP 接入等企业级能力。

[特性对比](#-原生-vs-扩展一目了然) • [极简仪表盘](#-极简两行-hud-仪表盘与速率中枢) • [核心特性](#-核心特性详解) • [实战场景](#-实战场景) • [目录结构](#-目录结构) • [快速安装](#-快速安装)

</div>

---

## ⚡ 原生 vs 扩展：一目了然

Pi 原生仅提供 `read` / `write` / `edit` / `bash` 四个基础工具与简易终端输出。装上扩展后实现能力跃迁：

| 维度 | Pi 原生 | 装上扩展后 |
| :--- | :---: | :--- |
| **可用工具** | 4 个 | **20+ 个**（16+ 个新增 AI 工具 + 4 个原生 + 动态 MCP 工具） |
| **用户命令** | 0 个自定义 | **25+ 个**（`/auto` `/auto_stop` `/context` `/tier` `/note` `/mcp` 等） |
| **底栏视觉** | 3 行（插件状态堆叠挤压） | **严格锁定 2 行极简高级 HUD**，全量指标两端对齐，零表情无冗余 |
| **速率追踪** | ❌ 无速率感知 | ✅ **实时生成速率（t/s）**、首字延迟（TTFT）、思考耗时与多轮均值 |
| **自定义模型** | ❌ 丢失缓存读写与费用 | ✅ **OpenAI 兼容全平台缓存（R/W/CH%）与资费自动换算**，与原生体验一致 |
| **并行执行** | ❌ 纯串行，单任务单线程 | ✅ `spawn_agent` 多任务后台并发，超时快照，断点恢复，结果自动回传 |
| **工作流管控** | ❌ 无统一授权与阶段防线 | ✅ Chat / Plan / Work 阶段 + Guarded / Auto / Auto_All 授权 + 脱敏审计 |
| **AUTO 审批** | ❌ 盲目放行或频繁弹窗 | ✅ **语义提示词智能判定**（放行安全目录外只读与全局 Skill，拦截敏感凭证） |
| **防死循环** | ❌ 依赖人工手动打断 | ✅ **连续 25 步自动熔断保护** + `/auto_stop`（一键中止并回退） |
| **Windows 适配**| ❌ `bash` 依赖环境，中文常乱码 | ✅ **`cmd` + `powershell` 双引擎**，Base64 原生 UTF-8 + 智能 GBK 跨编码搜索 |
| **计划可视化** | ❌ 仅普通文本 | ✅ 结构化 Work Contract 计划面板，原子推进与事实证据防谎报 |
| **上下文观测** | ❌ 不可见，易突发截断 | ✅ 状态栏精确百分比预警 + `/context` 深度分布与速率透视浮层 |
| **模型热切换** | ❌ 需改配置重启 | ✅ `switch_model` 热切换，L0/L1/L2 三级阶梯 + 六级思考深度 |
| **MCP 生态** | ❌ 无内置 MCP Client | ✅ 通用 stdio MCP Bridge，自动按工具 Schema 注册，支持 Pwiki 知识库 |
| **跨轮注意力** | ❌ Compaction 后遗忘上下文 | ✅ `attention_add` 粘性备忘录，跨轮注入，Compaction 免疫 |

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
  - `· 48.2 t/s`：**实时吐字速率**（流式过程中平滑跳动，生成结束后锁定权威精确值）。
- **Line 2 右侧（模式状态与模型融合）**：
  - `AUTO [就绪]` / `AUTO [已拦截: bash]` / `GUARDED` / `PLAN`：模式与当前拦截动作实时展示；
  - `(provider) model • thinking`：供应商、模型标识与思考深度。
  - **绝不加表情**：彻底移除 `🧠`、`🤖`、`🛑` 等任何花哨 emoji，保持清爽严肃的工程美感。

### 2. 自定义供应商模型（OpenAI / Anthropic 兼容端点）全面对齐
过去在 Pi 中使用第三方中转或私有模型时，状态栏通常只剩最简陋的 `↑ ↓ %`，缺失缓存与费用。本扩展从协议底层彻底解决：
- **流式 Usage 完整捕获**：修复通用流中收到 `finish_reason` 提前断流导致丢失末尾 usage chunk 的 Bug；
- **全平台缓存解析**：深度兼容 `cached_tokens`、`prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens` 等字段；
- **资费智能推导**：内置 DeepSeek 等主流模型默认费率表，并在每次响应完成后自动触发计费核算。

### 3. `/context` 详情浮层：速率指标全透视
输入 `/context` 命令即可唤起带完整速率分布的统计浮层：

```text
上下文与速率统计

总用量       12.3K / 128.0K tokens   9.6%

── 明细 ────────────────────
System        2.8K tokens    2.2%
Skills        0.4K tokens    0.3%
用户上下文     9.1K tokens    7.1%

合计(估算)    12.3K tokens    9.6%
模型报告      12.3K tokens    9.6%

── 速率指标 ────────────────
最新轮次:
  生成速率      48.2 tokens/s
  首字延迟       340 ms
  生成耗时      2.65 s
  总计耗时      2.99 s
  本次输出       128 tokens (思考: 0 tokens)

会话累计:
  累计输出       856 tokens
  平均速率      45.6 tokens/s
  统计轮次         5 轮
```

---

## 🔥 核心特性详解

### 1. 自动化工作流与安全守卫 — `work-mode/`
由协作阶段（Phase）、授权级别（Autonomy）、结构化计划（Work Contract）构成的统一安全运行时。

- **三阶段防线**：
  - **Chat**：纯对话咨询，禁止一切代码与终端执行；
  - **Plan**：只读探测与分析，生成完整 Work Contract 等待人工批准；
  - **Work**：进入执行阶段，按授权模式流转。
- **三种授权等级**：
  - **Guarded（默认）**：常规开发直接放行，仅在破坏性、越界或高危操作时弹窗确认；
  - **Auto**：借助后台配置的轻量 Reviewer 模型（`/auto_model`）进行语义审批；
  - **Auto All**：显式执行 `/auto_all` 后全自动放行（非保护路径）。
- **AI 审批准则优化**：
  - **目录外安全只读**：只要不涉及密钥凭据（如 `.ssh`、`token`、密码等），外部文件的状态读取、日志分析全面放行；
  - **全局 Skill 支持**：明确放行 `.agents`、`.pi`、`.codex`、`.claude` 目录下的 Skill 规则读取及其中工具/脚本的调用；
  - **防死循环熔断与强制终止**：单轮执行达 25 步（可配）自动熔断退回 Guarded；随时输入 `/auto_stop`（或 `/auto_cancel`、`/auto_abort`）一键掐断自动化。

### 2. 子 Agent 并行调度集群 — `parallel-agent/` v10
把复杂问题拆解为独立子任务，在后台多实例并发执行，结果自动汇总。

- **并发派发**：`spawn_agent` 启动独立子任务，支持指定不同的模型、上下文与工作区；
- **任务面板与结论优先**：子 Agent 在每个里程碑提交结构化控制面板，避免海量原始日志撑爆主上下文；
- **状态持久化与超时安全**：任务完成自动落盘会话，超时前自动保存快照并生成 `saveId`，支持随时 `resumeFrom` 克隆恢复；
- **生命周期完全受控**：主 Agent 可随时 `control_agent` 进行 `kill`、`abort`、`pause`、`resume`、`status` 查询。

### 3. Windows 终极双引擎 — `cmd-tool.ts` + `powershell-tool.ts`
彻底解决 Windows 终端中文乱码与性能瓶颈。

- **`cmd` 引擎**：~100ms 极速启动，自动注入 `chcp 65001` 代码页前缀，适合简单指令与脚本；
- **`powershell` 引擎**：Base64 (UTF-16LE) 绕过系统 ANSI 损毁，原生 UTF-8 输出；
- **跨编码中文搜索**：一条命令同时在 UTF-8 和 GBK 编码混合的代码/日志文件中精准匹配中文关键字。

### 4. 模型热切换与阶梯体系 — `model-switch/`
- **L0 / L1 / L2 阶梯管理**：快速（Haiku/Flash）、主力（Claude Sonnet/GPT-4o）、高阶（DeepSeek R1/Opus）；
- **动态热切换**：AI 可使用 `switch_model` 工具按任务复杂度自动升降级，节省成本；
- **六级思考控制**：支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 思考深度自由调节。

### 5. 自主注意力暂存器 — `attention-buffer/`
- **跨 Compaction 粘性记忆**：AI 通过 `attention_add` 写入临时备忘或重要技术决策，带 `sticky` 标记的内容在 Pi 历史上下文压缩后依然保留；
- **每轮自动注入**：以轻量格式在系统提示词末尾浮现，杜绝长会话“遗忘初衷”。

### 6. 通用 stdio MCP Bridge — `mcp/`
- **原生工具映射**：将外部 MCP Server（如知识库、数据库服务）声明的工具自动无缝注册为 Pi 本地原生工具；
- **安全策略**：支持按服务配置 `strict`、`allow` 或 `pwiki` 专用安全规则。

---

## 🎬 实战场景

### 场景 1：多模块代码并行审查
```text
你: "审查 src/auth、src/api、src/db 三个模块的潜在安全漏洞"

→ 主 Agent 自动调用 spawn_agent × 3 派发到后台
→ 3 个子 Agent 并行分析，互不阻塞
→ 各模块结论自动汇总，主 Agent 呈现实时报告与风险评级
```

### 场景 2：Windows 跨编码中文排查
```text
你: "在 logs/ 目录下查找包含'数据库连接超时'的所有错误"

→ 自动调度 PowerShell 引擎
→ 执行 Select-String 跨编码检索
→ 无论日志文件是 UTF-8 还是 GBK，行号与内容一次性全部精准定位
```

### 场景 3：受控自动化工作流
```text
你: /auto
你: "分析现有测试套件并重构 cmd-tool.ts"

→ AUTO 模式启动，底栏显示 AUTO [就绪]
→ AI 申请运行测试与读取全局 Skill，后台 Reviewer 智能放行
→ 若 AI 尝试越权修改敏感目录，立即被拦截并暂停
→ 用户随时输入 /auto_stop 即可一键恢复人工接管
```

---

## 📂 目录结构

```text
pi-agent-extensions/
├── README.md                  # 本文件 — 特性说明与使用指南
├── AGENTS.md                  # 行为与交互风格契约
├── SYSTEM.md                  # 阶段、授权与安全规则规范
│
├── token-stats.ts             # ⭐ 2 行极简 HUD 仪表盘与速率渲染
├── context-usage.ts           # ⭐ /context 上下文与详细速率透视
│
├── work-mode.ts               # 工作流与安全控制主入口
├── work-mode/                 # 阶段流转、AUTO 审查、防死循环熔断、审计
│
├── parallel-agent.ts          # 子 Agent 并行调度主入口
├── parallel-agent/            # 并发控制、任务面板、快照持久化
│
├── model-switch.ts            # 模型分级热切换与思考深度控制
├── model-switch/              # L0/L1/L2 阶梯映射与持久化配置
│
├── provider-manager.ts        # 自定义模型供应商主入口
├── provider-manager/          # OpenAI/Anthropic 协议适配、容错流、资费计算
│
├── attention-buffer.ts        # 跨轮注意力暂存器主入口
├── attention-buffer/          # 粘性备忘与上下文动态注入
│
├── cmd-tool.ts                # Windows CMD 极速执行引擎
├── powershell-tool.ts         # Windows PowerShell UTF-8 深度引擎
│
├── mcp/                       # 通用 stdio MCP Bridge
└── lib/                       # 全局总线、执行上下文、速度跟踪器单例
    ├── speed-tracker.ts       # 速率中枢（TTFT、TPS、会话加权计算）
    ├── agent-bus.ts           # AgentBus 跨实例总线
    ├── execution-context.ts   # 运行时全局上下文
    └── settings-io.ts         # 配置读写工具
```

---

## 📦 快速安装

### 1. 克隆到 Pi 全局扩展目录

```bash
# 推荐克隆到 Pi 默认的用户扩展目录
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git ~/.pi/agent/extensions

# 进入 MCP 目录安装桥接运行时依赖（仅需一次）
cd ~/.pi/agent/extensions/mcp && npm install --omit=dev --ignore-scripts
```

*Windows PowerShell 用户：*
```powershell
git clone https://github.com/ang-XWBWZ/pi-agent-extensions.git $HOME\.pi\agent\extensions
cd $HOME\.pi\agent\extensions\mcp
npm install --omit=dev --ignore-scripts
```

### 2. 加载与验证
在任意已运行的 Pi 会话中输入：
```text
/reload
```
底栏立即变更为**全新 2 行 HUD 仪表盘**，所有扩展即刻生效！

---

## 🛠️ 常用命令速查

| 指令 | 作用 |
| :--- | :--- |
| `/context` | 打开上下文占用分布与详细 Token 速率指标浮层 |
| `/auto` | 切换至 AUTO 自动审批模式（需配置审核模型） |
| `/auto_stop` | 一键中止当前 AUTO 运行并回退为 GUARDED 模式 |
| `/auto_model <provider>/<model>` | 设置用于后台自动审批的轻量 AI 模型 |
| `/auto_add_prmt <提示词>` | 追加审核模型的自定义提示词 |
| `/tier` / `/tier-add` | 管理 L0/L1/L2 阶梯模型配置 |
| `/thinking <off~xhigh>` | 调节推理模型的思考深度 |
| `/note` | 查看并管理跨轮注意力暂存备忘录 |

---

## 📄 License

[MIT](LICENSE) © 2026 ang-XWBWZ & Contributors
