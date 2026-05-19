# Wiki 写作规范 & AI 操作指引

## AI 如何参与 Wiki

### 添加条目
1. 用 `/wiki add <源文件路径> <条目标题>` 创建条目骨架
2. 源文件路径相对于本仓库的 rawDir（见 wiki.json）
3. 骨架生成后，AI 应编辑条目文件，补充正文内容
4. 完成后条目自动纳入索引，可通过 `/wiki search` 检索

### 搜索知识
- 回答项目问题前，先用 `kb_search` 工具查 wiki
- wiki 条目是对原始文件的提炼总结，优先于直接读原始文件
- 搜索不到时，考虑用 `/wiki add` 补充

### 维护索引
- 原始文件变更时，更新对应条目的内容和 updated 时间
- 废弃条目用 `/wiki delete` 移入回收站
- 定期 `/wiki status` 检查索引健康度

---

## 条目模板

```markdown
---
source: extensions/work-mode.ts
parent: extensions
tags: [extension, state-machine]
status: complete
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# 条目标题

## 概述

≤200 字说明：这是什么，解决什么问题，核心设计思路。

## 核心内容

分节展开。遵循以下层级：

### 三级标题（最多）
具体内容。

## 关联

- [[其他条目id]]
- [原始文件](source)
```

---

## 写作规则

| 规则 | 说明 |
|------|------|
| 标题层级 | ≤ 3 级（`#` / `##` / `###`），更深内容拆分为独立条目 |
| source 字段 | **必填**，指向 rawDir 下的原始文件（相对路径） |
| parent 字段 | **必填**，指定所属分类目录 |
| tags 字段 | **必填**，≥ 2 个标签 |
| status 字段 | **必填**，draft（骨架）/ complete（已完成） |
| 内部引用 | 用 `[[条目id]]` 引用其他 wiki 条目 |
| 内容原则 | 提炼总结，不是复制粘贴。从读者视角解释"为什么这样设计" |
| 长度控制 | 概述 ≤ 200 字，核心内容每个 ### 节 ≤ 500 字 |

---

## 标签体系

| 标签 | 适用场景 |
|------|------|
| `extension` | pi 扩展文件 |
| `skill` | 技能文件 |
| `state-machine` | 状态机相关 |
| `architecture` | 架构设计 |
| `api` | API 接口定义 |
| `tool` | 工具实现 |
| `bus` | 通信层 |
| `config` | 配置相关 |
| `guide` | 使用指南 |
| `reference` | 参考文档 |
| `typescript` | TypeScript 源码 |
| `python` | Python 脚本 |
