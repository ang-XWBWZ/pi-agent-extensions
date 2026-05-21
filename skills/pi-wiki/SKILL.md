---
name: pi-wiki
description: Wiki knowledge base operations for pi-agent-extensions. Use when searching, reading, creating, or compiling wiki entries; managing data sources; managing semantic search; or running file-level LLM compilation. Triggers on "wiki", "kb_search", "knowledge base", "编译", "知识库", "保存到 wiki", "记下来", "search wiki", "compile wiki", "semantic search".
model_tier: L1
skill_tier: functional
version: 2.2.0
status: active
---

# Pi Wiki — 操作流程

> 遇到什么场景、按什么步骤走。

---

## 🚫 铁律（违反将导致不可逆数据损坏）

**全程遵守 wiki 生命周期，禁止绕过 wiki 工具直接操作数据源。**

| ❌ 绝对禁止 | ✅ 正确做法 |
|-------------|-------------|
| 使用 `bash` / `cmd` / `powershell` 查看 wiki 文件 | 用 `wiki_get_entry` / `wiki_get_chunks_raw` |
| 使用 `read` / `write` / `edit` 修改 wiki 目录文件 | 用 `wiki_create_entry` / `wiki_rename` / `wiki_move` |
| 在终端删除 wiki 文件后依赖 `wiki_refresh` 清理 | 用 `wiki_rename` 归档到 `_archived/` |
| 直接操作 `models/`、`vectors.json`、`compiled.json` | **绝对不允许** — 这些是运行时数据 |
| 绕过 wiki 工具搜索内容 | 用 `kb_search`（keyword/semantic/hybrid） |

**原因**: wiki 维护自己的索引和向量数据。终端/读写工具直接操作文件会导致索引与磁盘不一致、向量数据损坏、编译状态丢失。所有操作必须通过 wiki 工具 API 完成。

---

## 决策树

```
用户: "搜索/查一下 XXX"        → Workflow A
用户: "记下来 / 保存到 wiki"    → Workflow B
用户: "编译 wiki / 提升搜索质量" → Workflow C
用户: "wiki 状态 / 加载数据源"  → Workflow D
```

---

## Workflow A: 搜索 → 读结果

**Step 1** — 确认数据源已加载：`wiki_list_sources`。空则 `wiki_load_source`。

**Step 2** — `kb_search(query, mode="hybrid")`。hybrid 模式自动结合关键词+语义，效果最佳。需要时指定 `mode="keyword"` 或 `mode="semantic"`。每页 5 条。

**Step 3** — 用户选后再 `wiki_get_entry(source, path)`。

> ❌ 禁止搜完自动打开全部。

---

## Workflow B: 捕捉知识 → 创建条目

确认内容 → `wiki_create_entry(source, path, title, tags, content)`。

---

## Workflow C: 编译 wiki（⭐ 核心）

### 决策

碎片化笔记/日报 → ✅ 编译 | 结构文档 → ⚠️ 可选 | 纯日志 → ❌ 跳过

### 完整生命周期（LLM 编译 → 存储 → 刷新 → 检索）

```
① wiki_store_file_compiled  ──→ 存储 segments + 同步计算 LLM 向量
         ↓
② wiki_refresh              ──→ 刷新搜索索引，LLM 向量可检索
         ↓
③ kb_search(mode="semantic") ──→ 验证召回效果
```

### 子 Agent 约束编译流程（推荐）

主 Agent 通过 `spawn_agent` 派发子 Agent，**严格约束其仅使用 wiki 工具**：

```
主 Agent                                  子 Agent
  │                                          │
  ├── 准备任务描述                              │
  │   - 目标文件路径                            │
  │   - 编译步骤（读取→分析→存储）               │
  │   - 🚫 禁止 read/write/edit/bash/cmd       │
  │   - ✅ 仅允许 wiki_get_entry /             │
  │       wiki_store_file_compiled / kb_search │
  │                                            │
  ├── spawn_agent ───────────────────→         │
  │                                            │
  │                              ├── wiki_get_entry ✅
  │                              ├── 拆语义段 + 组装 JSON
  │                              └── wiki_store_file_compiled ✅
  │←── 完成 ──────────────────────│
  │                                            │
  └── wiki_refresh  →  kb_search 验证          │
```

**spawn_agent 任务描述模板**:

```
你是一个 wiki 编译助手。

## 绝对禁止
🚫 禁止使用 read、write、edit、bash、cmd、powershell 等任何非 wiki 工具。
任何情况下都不允许调用以上工具。

## 允许的工具
仅可使用以下 wiki 工具：
- wiki_get_entry(source, path)
- wiki_store_file_compiled(source, relPath, data)
- kb_search(query)

## 任务
source="D:\Synology\跨设备同步\notepad\davnotepad2"

1. wiki_get_entry(source, "目标文件相对路径.md") — 读取文件
2. 按 ## 标题拆语义段，每段提取 text/topic/normalizedText/concepts/aliases
3. 组装为 {"segments": [...]} JSON
4. wiki_store_file_compiled(source, "目标文件相对路径.md", data) — 存储

原则：保留原意，concepts 提取核心业务术语，aliases 补充同义表达
```

### 段结构

```typescript
interface Segment {
  text: string;          // 原文片段
  topic: string;         // 段主题（简洁）
  normalizedText: string; // 归一化描述（用于语义匹配）
  concepts: string[];    // 关键概念
  aliases: string[];     // 同义词/别名
}
```

### 批量编译

按页 5-8 个并行，一次 `spawn_agent` 派发多个任务，完成后统一 `wiki_refresh`。

---

## Workflow D: 初始化 / 状态检查

**首次:** `wiki_list_sources` → `wiki_semantic()` 看状态 → `wiki_semantic(action="on")` 启用语义（自动下载模型）

**日常:** `wiki_list_sources` + `wiki_semantic()`

**变更后:** `wiki_refresh` 增量刷新（自动清理已删文件的脏向量）

---

## 模型选择

| 模型 | 维度 | tokens | 大小 | 适用 |
|------|:--:|:--:|:--:|------|
| `bge-base-zh-v1.5` | 768 | 512 | ~130M | 中文笔记，默认 |
| `bge-large-zh-v1.5` | 1024 | 512 | ~324M | 中文高精度 |
| `paraphrase-multilingual` | 384 | 128 | ~118M | 多语言混合 |
| `bge-m3` | 1024 | **8192** | ~570M | 多语言长文本，首选 |

切换：`wiki_semantic(action="model", id="bge-m3")` → 维度变化自动清旧向量 → 需 `wiki_semantic(action="on")` 启用（自动下载模型）

> 💡 切模型后需 `wiki_refresh(rebuildVectors=true)` 重建 AST 向量才能用新模型的完整上下文。

---

## 语义搜索特性

- **路径语义注入**：embedText 包含 `[工作 > AMI > 更新 > 10.18AMI更新]`，目录结构参与语义匹配
- **embedText 自适应**：`model.maxTokens * 2` 字符上限，bge-m3 下每块可达 ~16k 字符
- **三态锁**：❌未编译 · 🔄编译中 · ✅已编译

---

## Wiki 生命周期总结

```
加载/卸载
  wiki_load_source / wiki_unload_source
    ↓
索引扫描
  wiki_refresh  ← 文件增删改后同步
    ↓
搜索
  kb_search(keyword|semantic|hybrid)
    ↓
读取
  wiki_get_entry
    ↓
创建/重命名/移动
  wiki_create_entry / wiki_rename / wiki_move
    ↓
编译
  wiki_compile_file → spawn_agent(仅wiki工具) → wiki_store_file_compiled → wiki_refresh → kb_search
```

**所有操作都通过 wiki 工具 API 完成，绝不绕过。**

---

## 完整工具速查

| 工具 | 用途 |
|------|------|
| `wiki_load_source` | 加载数据源 |
| `wiki_unload_source` | 卸载（无参=列出） |
| `wiki_list_sources` | 列出数据源 |
| `wiki_refresh` | 刷新索引 / AST 向量重建 |
| `wiki_semantic` | 无参=状态，action="on"/"off"/"model" |
| `kb_search` | 搜索（keyword/semantic/hybrid） |
| `wiki_get_entry` | 读条目 |
| `wiki_create_entry` | 创建条目 |
| `wiki_rename` / `wiki_move` | 重命名 / 移动 |
| `wiki_get_chunks_raw` | 文件编译状态 |
| `wiki_compile_file` | 生成编译 prompt（force 解锁） |
| `wiki_store_file_compiled` | 存储编译结果（同步计算 LLM 向量） |

---

## 反模式

| ❌ | ✅ |
|----|----|
| **使用终端/cmd/bash 操作 wiki 文件** | **只用 wiki 工具 API** |
| **使用 read/write/edit 操作 wiki 数据源** | **只用 wiki 工具 API** |
| 搜完自动打开全部 | 等用户选一篇 |
| 不确认就创建 | 先确认 |
| 编译后不 refresh | `wiki_store_file_compiled` → `wiki_refresh` |
| 子 Agent 未约束工具 | spawn 时明确禁止非 wiki 工具 |
| 见文件就编译 | 优先碎片化笔记 |
| spawn >8 个编译 Agent | 5-8 个分批 |
| 切模型不重建向量 | `wiki_refresh(rebuildVectors=true)` |
