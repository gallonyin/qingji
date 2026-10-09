# 从 Joplin 本地数据迁移

脚本读取已完成同步、已解密的 Joplin 本地 profile，不访问或改写原来的 S3。只接受 Markdown 笔记；加密资源或其他正文格式须先处理。建议退出 Joplin 后运行，避免资源在迁移时变化。

```bash
python3 scripts/import-joplin.py \
  --source /path/to/joplin-profile \
  --destination /path/to/new-import
```

目标目录必须不存在且与源目录分离，脚本拒绝覆盖现有目录。通过只读 SQLite 在线备份取得一致数据库，再复制附件并校验大小、前后 SHA-256。原 profile 保持原样，目标文件不是原附件的硬链接。

输出包括 `vault/notes`、`vault/attachments`、`source-archive`、ID 映射、文件清单、未解决链接与 report.json。保留目录层级、标题、标签、回收站状态；Joplin 内部链接转为稳定 UUID，缺失链接原样保留并报告。重名目录加源 ID 后缀区分。

只有 report.json 为 complete 才是完成迁移。失败目录保留供审查，不要将其直接用于服务。迁移报告和归档包含个人数据，不得提交 Git。

首次导入空实例：停止服务并备份原数据目录，将已验证的 vault/notes 与 vault/attachments 放入独立数据目录，启动后核对目录、数量、正文与附件。不要覆盖有现存笔记的实例；本脚本不提供合并策略。

原 Joplin 数据库留在 source-archive 中供核对；待办扩展字段保留，但应用不展示全部 Joplin 功能，也不导入其历史版本。先在隔离实例验收，再配置新桶或独立前缀进行 S3 备份和恢复测试。
