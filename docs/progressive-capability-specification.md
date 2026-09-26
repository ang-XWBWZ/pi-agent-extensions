# 渐进式能力系统 (PCS) 插件接入规范
Progressive Capability System (PCS) Specification & Developer Guide

## 1. 架构目标与设计原则

在大模型 Agent 架构中，随着功能扩展，全量静态注册工具会带来两个致命瓶颈：
1. **上下文冗余与注意稀释**：全部工具定义与 Guidelines 一次性注入，首轮 System Prompt 膨胀至 25K+ Tokens，模型执行简单指令时注意力涣散、首 Token 延迟高（TTFT > 5s）；
2. **前缀缓存（Prompt Caching）击穿**：根据 Pi 底层机制，任何工具若声明 `promptGuidelines` 或 `promptSnippet`，在工具挂载、激活或动态变更时，Pi 均会重新编译并拼接 System Prompt 字符串，导致 Anthropic/Gemini/OpenAI 等主流大模型的 KV Cache 100% 击穿作废，造成延迟剧增与巨额 Token 成本。

**PCS 核心解决方案**：
- **两级分层架构**：第一层由常驻基础工具（`read`, `edit`, `write`, `bash`, `cmd`, `powershell`, `manage_requirements`, `update_plan`, `load_capability`）构成稳定前缀；第二层专业子系统（如 `parallel_agent`, `work_goal`, `mcp` 等）采用按需 JIT 挂载。
- **不可变元索引卡**：首轮 System Prompt 仅注入恒定、严格按 ID 字典序排序的 `<subsystems>` 元数据（每项仅约 30 字符摘要），System Prompt 字节级冻结，保证 100% 缓存命中率。
- **尾部协议注入**：专业子系统的完整指南与 SOP 在模型调用 `load_capability` 激活后，通过 `tool_result` 尾部纯追加返回，既让模型获得精准指导，又绝不碰 System Prompt 缓存前缀。

---

## 2. 插件接入接口与数据结构

新插件在接入 Pi Agent 时，应使用 `registerCapability(manifest)` 声明能力清单：

```typescript
import { registerCapability, type CapabilityManifest } from "./lib/capability-router.js";

export interface CapabilityManifest {
  /** 唯一标识符，建议短横线或下划线命名，如 "database_ops" */
  id: string;

  /** 显示名称（人类可读），如 "Database Operations" */
  name: string;

  /**
   * 极简单行摘要（用于首轮 System Prompt 的不可变元索引卡）
   * 严格限制在 100 字符以内，描述适用场景与核心动作
   */
  summary: string;

  /** 触发关键词/意图特征（用于意图检索与匹配） */
  keywords: string[];

  /**
   * 适用的会话阶段（用于阶段门控隔离）
   * 可选值: "chat" | "plan" | "work"
   * 默认: ["work"] (即在 /chat 和 /plan 阶段该能力完全不可见)
   */
  phases?: Array<"chat" | "plan" | "work">;

  /** 该能力包含的工具名称列表 */
  tools: string[];

  /**
   * 深度使用说明文档（Markdown 格式）
   * ！！！绝不能进入首轮 System Prompt ！！！
   * 仅在模型调用 load_capability 激活后，在 tool_result 中作为尾部消息注入给模型
   */
  usageDoc: string;

  /** 可选的激活生命周期回调（用于按需启动后台服务、初始化数据等） */
  onActivate?: (ctx: ExtensionContext) => Promise<void> | void;
}
```

---

## 3. 铁律准则：Cache-Safe 开发规范

所有按需挂载的二级工具必须严格遵守以下准则：

### ❌ 严禁使用 `promptGuidelines` 和 `promptSnippet`
在子系统工具的 `pi.registerTool({ ... })` 中，**绝对不允许**包含 `promptGuidelines` 或 `promptSnippet` 属性！
```typescript
// ❌ 错误示范：会导致 System Prompt 重新编译并击穿缓存！
pi.registerTool({
  name: "db_query",
  promptSnippet: "Execute database query", // 严禁！
  promptGuidelines: ["Use db_query only after..."], // 严禁！
  ...
});

// ✅ 正确示范：纯净工具定义
pi.registerTool({
  name: "db_query",
  label: "Database Query",
  description: "Execute a read-only SQL query against configured databases.",
  parameters: Type.Object({ ... }),
  ...
});
```

### ✅ 使用 `usageDoc` 与 `description`
- **基础定位**：在 `registerTool` 的 `description` 中用 1~2 句话清晰描述该工具的作用与输入参数。
- **深度操作规范**：全部收敛至 `CapabilityManifest.usageDoc`。当大模型调用 `load_capability({ capability: "..." })` 时，路由器会自动将 `usageDoc` 追加在执行结果中。

### ✅ 工具效果分类（Tool Effect）
在 `extensions/work-mode/tool-decision.ts` 中，为新工具声明安全风险分级：
- `READ_TOOLS`：只读诊断类（自动放行，无需审批）；
- `PROGRESS_TOOLS`：轻量任务协作/状态记录类；
- `PERSISTENT_TOOLS`：持久化修改配置/环境变更类；
- `DESTRUCTIVE_COMMAND`：高危删除/破坏性操作。

---

## 4. 完整插件接入示例

以下是一个标准的符合 PCS 规范的新插件实现示例：

```typescript
// extensions/my-database-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCapability } from "./lib/capability-router.js";

export default function (pi: ExtensionAPI) {
  // 1. 注册能力清单
  registerCapability({
    id: "database_ops",
    name: "Database Operations",
    summary: "Query schema and execute SQL migrations on configured databases.",
    keywords: ["database", "sql", "migration", "query", "schema"],
    phases: ["work"],
    tools: ["db_query", "db_migrate"],
    usageDoc: `# Database Operations Capability (database_ops)

### Available Tools:
- \`db_query(sql, database?)\`: Run read-only query and inspect tables.
- \`db_migrate(migrationFile)\`: Apply a versioned migration.

### Rules & Best Practices:
1. Always run schema inspection before applying migrations.
2. Destructive SQL (DROP, TRUNCATE) requires explicit confirmation.`,
    onActivate: async (ctx) => {
      // 可选：初始化连接池
    },
  });

  // 2. 注册工具（严格无 promptGuidelines / promptSnippet）
  pi.registerTool({
    name: "db_query",
    label: "Database Query",
    description: "Execute a read-only SQL query against configured databases.",
    parameters: Type.Object({
      sql: Type.String({ description: "SQL query string" }),
    }),
    async execute(_tcid, params) {
      return {
        content: [{ type: "text", text: "Query executed successfully" }],
      };
    },
  });

  pi.registerTool({
    name: "db_migrate",
    label: "Database Migrate",
    description: "Apply a migration file to the target database.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to migration SQL file" }),
    }),
    async execute(_tcid, params) {
      return {
        content: [{ type: "text", text: "Migration applied" }],
      };
    },
  });
}
```

---

## 5. 自动化合规审查 (Cache-Safe Linter)

为防止未来开发中误引入破坏缓存的代码，项目在测试套件中内置了 AST 级静态合规检查：

```bash
# 运行合规与能力路由测试
node --loader ./extensions/stream-compat/__tests__/test-loader.mjs --test extensions/work-mode/__tests__/prompt-policy.test.ts extensions/work-mode/__tests__/capability-router.test.ts
```

审查逻辑：
1. 自动遍历所有 TypeScript 源码；
2. 提取所有 `registerCapability` 中声明的 `tools`；
3. 解析对应的 `registerTool` AST 节点；
4. 若发现任何 capability 工具包含 `promptGuidelines` 或 `promptSnippet`，测试立刻中断并报告违规文件及行号。
