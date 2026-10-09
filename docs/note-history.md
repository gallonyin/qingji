# 笔记历史版本

入口：选择笔记 → 右侧「整理」→「历史版本」。按时间查看、分页加载旧版本、预览标题/正文/目录/标签，并恢复指定版本。恢复生成新的 revision，原有版本保留；正文不做 HTML 执行或外部资源加载。

服务端成功保存的版本才会留档，离线编辑在同步成功后形成版本。恢复前先保存并同步本地修改；未同步修改或冲突存在时阻止覆盖。服务端同时检查 vaultEpoch 和当前 revision，防止并发编辑被静默覆盖；重复恢复请求最多一个成功。

历史保存于 metadata.sqlite 的独立 note_history 表。首次升级将已有 revisions 导入一次，当前版本以正式 Markdown 文件为准；重建检索/同步索引、整库恢复不会清除此表。恢复使用稳定历史记录 ID，不会因 revision 编号在整库恢复后重用而指向错误记录。永久删除笔记会同时清除此笔记的历史。

当前范围：标题、正文、目录、标签、收藏；恢复保留笔记 ID 和创建时间。附件文件没有独立版本管理，旧正文引用的附件若已永久删除，不能通过正文历史重新生成。Joplin 未迁入的历史无法补出。

本轮未将历史库纳入 S3 清单：现有 S3 快照仍备份 notes 和 attachments。单篇历史保存在服务器数据库，与异地灾难恢复是两项能力；备份数据库时须包含 note_history。自动备份是否启用由环境配置决定。

接口：
- GET /notes/:id/history?before=<historyId>&limit=20
- GET /notes/:id/history/:historyId
- POST /notes/:id/history/:historyId/restore，body 为 {revision: 当前服务端版本}，携带认证及 x-vault-epoch。
