# Markdown 与目录格式

## 数据目录布局

```text
data/
├── notes/
│   ├── 工作/
│   │   └── 0198dc0c-6d45-7aa8-a80c-2f8bf69fca27.md
│   └── 每日/
│       └── 0198dc18-24b2-7c19-b3cf-24cf3f51517a.md
├── attachments/
│   └── 0198.../
│       └── diagram.png
```

笔记路径由用户可见目录和稳定 ID 文件名组成；可读标题保存在 frontmatter，避免标题
变化导致同步身份变化。目录会归一化斜杠并移除首尾斜杠，拒绝 `.`、`..` 和中间空路径段。附件按笔记 ID 隔离，
正文使用相对链接。

## Frontmatter 契约

每篇笔记都包含以下 YAML frontmatter：

```yaml
---
bodyFormat: verbatim-v1
folder: 工作
id: 0198dc0c-6d45-7aa8-a80c-2f8bf69fca27
title: 项目计划
revision: 7
createdAt: 2026-08-02T02:40:00.000Z
updatedAt: 2026-08-02T03:12:00.000Z
tags:
  - 工作
  - 规划
favorite: false
deletedAt: null
---
```

- `id`：创建后永不改变，是重命名、移动和同步的身份依据。
- `revision`：每次服务端接受内容或元数据变化后递增。
- `createdAt` / `updatedAt` / `deletedAt`：UTC ISO 8601。
- `title`：显示标题，不必与文件名一致。
- `tags`：去重后的字符串数组。
- `favorite`：布尔值。

只接受普通 YAML，ID 必须是 UUID、revision 为正整数、时间可解析。`bodyFormat: verbatim-v1` 保留正文原有换行；旧格式兼容去除首尾各一个分隔换行。编辑保留未知 frontmatter 字段。

## 删除与恢复

删除是受保护操作：笔记仅设置 `deletedAt`，文件继续保留在原目录，同步事件仍保留其
稳定 ID 和路径。恢复会清除该字段，不发生不可逆文件删除。

## 外部变更

MVP 不承诺与外部编辑器实时双向编辑。手动重扫会：

1. 校验 frontmatter；缺少稳定 ID 的文件会报告错误并保持原文件不变。
2. 按 ID 更新或创建元数据。
3. 对重复 ID 报告错误，避免擅自改变外部数据。
4. 以当前磁盘文件重建同步事件、搜索与链接内存索引。

元数据数据库和搜索索引损坏不应阻止直接读取 vault。
