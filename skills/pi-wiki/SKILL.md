---
name: pi-wiki
description: Wiki knowledge base for pi-agent-extensions. Search, read, create, edit, compile wiki entries; manage data sources. Triggers on "wiki", "wiki_read_search", "知识库", "编译", "保存到 wiki", "记下来", "搜索 wiki", "wiki-edit", "编辑 wiki".
model_tier: L1
skill_tier: functional
version: 2.4.0
status: active
---

# Pi Wiki — 操作流程

> wiki 是知识库，不是文件系统。wiki 是查资料的，不是解决问题的。

---

## 🚫 铁律

**全程遵守 wiki 生命周期，禁止绕过 wiki 工具直接操作数据源。**

| ❌ 绝对禁止 | ✅ 正确做法 |
|-------------|-------------|
| 使用 `bash` / `cmd` / `powershell` 查看 wiki 文件 | 用 `wiki_read_entry` |
| 使用 `read` / `write` / `edit` 修改 wiki 目录文件 | 用 `wiki_edit_create` / `wiki_edit_modify` / `wiki_edit_rename` / `wiki_edit_move` |
| 在终端删除 wiki 文件 | 归档或通过 wiki 工具操作 |
| 直接操作 `models/`、`vectors.json`、`compiled.json` | **绝对禁止** — 运行时数据 |

---

## 🔍 搜索纪律（最高优先级）

### 硬限制

| 规则 | 说明 |
|------|------|
| **最多 2 次 `wiki_read_search`** | 两次搜索后必须展示结果、询问用户，不得继续搜索 |
| **禁止连续搜索不看内容** | 每次搜索后先看结果，再决定是否换策略 |
| **禁止自动 `wiki_read_entry`** | 搜索结果出来后，等用户选一篇，再读 |
| **首次用 keyword** | keyword 最精确；无结果→翻译/缩写展开→再试 1 次；仍无结果→停止 |

### 搜索策略

```
首次: wiki_read_search(query, mode="keyword")
  → 有结果 → 展示（最多 5 条），等用户选择
  → 无结果 → 拆解查询（翻译、展开缩写、核心词变体）
    → wiki_read_search(变体, mode="keyword")  ← 第 2 次
      → 有结果 → 展示，等用户选择
      → 无结果 → 告知用户，停止搜索

仅当用户意图模糊/自然语言描述时，才用 semantic 或 hybrid：
  → wiki_read_search(query, mode="semantic") 或 "hybrid"
  → 同样计入 2 次限制
```

### 反模式

| ❌ | ✅ |
|----|----|
| keyword → semantic → hybrid 连续 3-5 次 | 最多 2 次，keyword 优先 |
| 搜完不看结果就换 mode 再搜 | 先看结果，再决定 |
| 搜完自动 `wiki_read_entry` | 等用户说"读第 N 篇" |
| 无结果 → 立刻 semantic | 先换关键词变体再搜 |

---

## 工具分级

| 级 | 前缀 | 工具 | 说明 |
|:--:|------|------|------|
| 🟢 | `wiki_read_*` | `search` `entry` `sources` `chunks` | 纯读取，无副作用 |
| 🟡 | `wiki_edit_*` | `create` `modify` `rename` `move` | 修改磁盘内容 |
| 🔴 | `wiki_DANGER_*` | `load` `unload` `refresh` `semantic` `compile` `store` | 扫描磁盘/下载模型/修改向量 |

---

## 决策树

```
用户: "搜索/查一下 XXX"        → 搜索纪律 (最多 2 次 wiki_read_search)
用户: "记下来 / 保存到 wiki"    → wiki_edit_create
用户: "编辑 / 修改 wiki"        → /wiki-edit → wiki_edit_modify
用户: "编译 wiki / 提升搜索质量" → wiki_DANGER_compile → wiki_DANGER_store
用户: "wiki 状态 / 加载数据源"  → wiki_read_sources / wiki_DANGER_load
```

---

## Workflow A: 搜索 → 读结果

1. 确认数据源：`wiki_read_sources`（空则 `wiki_DANGER_load`）
2. `wiki_read_search(query, mode="keyword")` — 首次用关键词
3. 有结果 → 展示给用户，等用户选一篇
4. 用户选后 → `wiki_read_entry(source, path)`
5. 无结果 → 换关键词变体再搜 1 次 → 仍无结果 → 告知用户

---

## Workflow B: 创建条目

确认内容 → `wiki_edit_create(source, path, title, tags, content)`

---

## Workflow C: 编辑条目

1. `/wiki-edit <搜索词>` → AI 自动读取并注入编辑上下文
2. AI 修改内容
3. `wiki_edit_modify(source, path, content)` → 覆盖保存 + 自动刷新索引

---

## Workflow D: 编译 wiki

碎片化笔记/日报 → ✅ 编译 | 结构文档 → ⚠️ 可选 | 纯日志 → ❌ 跳过

```
① wiki_DANGER_compile(source, relPath) → 生成 prompt
② spawn_agent (Flash, work mode) → LLM 编译 → wiki_DANGER_store
③ wiki_DANGER_refresh → wiki_read_search 验证
```

子 Agent 约束：仅允许 `wiki_read_entry` / `wiki_DANGER_store` / `wiki_read_search`

---

## Workflow E: 初始化 / 状态

首次: `wiki_read_sources` → `wiki_DANGER_semantic()` → `wiki_DANGER_semantic(action="on")`
日常: `wiki_read_sources` + `wiki_DANGER_semantic()`
变更后: `wiki_DANGER_refresh`

---

## 完整工具速查

### 🟢 只读

| 工具 | 用途 |
|------|------|
| `wiki_read_search` | 搜索（keyword/semantic/hybrid） |
| `wiki_read_entry` | 读条目全文 |
| `wiki_read_sources` | 列出数据源 |
| `wiki_read_chunks` | 文件编译状态 |

### 🟡 改内容

| 工具 | 用途 |
|------|------|
| `wiki_edit_create` | 创建条目 |
| `wiki_edit_modify` | 修改条目（全文覆盖） |
| `wiki_edit_rename` | 重命名 |
| `wiki_edit_move` | 移动 |

### 🔴 危险

| 工具 | 用途 |
|------|------|
| `wiki_DANGER_load` | 加载数据源 |
| `wiki_DANGER_unload` | 卸载数据源 |
| `wiki_DANGER_refresh` | 刷新索引 |
| `wiki_DANGER_semantic` | 状态/启用/关闭/切换模型 |
| `wiki_DANGER_compile` | 生成编译 prompt |
| `wiki_DANGER_store` | 存储编译结果 |

---

## 模型选择

| 模型 | 维度 | tokens | 适用 |
|------|:--:|:--:|------|
| `bge-base-zh-v1.5` | 768 | 512 | 中文笔记，默认 |
| `bge-large-zh-v1.5` | 1024 | 512 | 中文高精度 |
| `paraphrase-multilingual` | 384 | 128 | 多语言混合 |
| `bge-m3` | 1024 | 8192 | 多语言长文本，首选 |

切换：`wiki_DANGER_semantic(action="model", id="...")` → `wiki_DANGER_refresh(rebuildVectors=true)`
