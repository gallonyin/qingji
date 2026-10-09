# 轻记 · Qingji

一个面向个人的轻量 Markdown 笔记网页应用。浏览器缓存笔记并支持离线编辑，服务端提供检索、历史版本和 S3 备份。部署为一个服务端、一个独立备份前缀，可在多台电脑的浏览器中使用。

## 功能

- Markdown 编辑与预览、目录树、标签、收藏、内部链接和反向链接。
- 浏览器 IndexedDB 缓存、离线创建/编辑/删除、恢复联网后增量同步；并发修改保留冲突副本。
- 服务端中文检索、回收站、单篇历史版本预览与恢复、完整导出。
- S3 内容寻址增量快照、变更合并触发、保留数量清理、校验与后台恢复、任务观测。
- Docker Compose 部署，Nginx 压缩与静态资源缓存。

当前是**单用户笔记库**。登录名只用于显示，不隔离用户数据。仓库中的 Tauri 壳是实验代码，尚未验证桌面发布包；主要交付形态为 B/S。

## 本地启动

要求 Node.js **20.19+**，推荐 Node.js 22；Python 3 仅用于迁移及其测试。

```bash
npm ci
cp .env.example .env
# 编辑 .env：将 MYNOTE_PASSWORD 改为自己的密码，示例密码不能启动服务
npm run dev
```

访问 <http://localhost:5173>。服务端监听 8787，网页通过 `/api` 代理访问。启动入口读取根目录 `.env`，已有进程环境变量优先。配置修改后重启服务。

```bash
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/tests
npm audit --registry=https://registry.npmjs.org
```

## 部署

```bash
cp .env.example .env
# 修改密码；将 MYNOTE_ORIGIN 改为实际访问网页的完整 origin
# 使用 HTTPS 时设置 MYNOTE_COOKIE_SECURE=true
docker compose up -d --build
```

默认网页端口 8080，宿主机 `./data` 挂载为服务端数据目录。公网访问应在前方配置 HTTPS 反向代理；Service Worker 只在 HTTPS 或 localhost 安全上下文启用。普通 HTTP 远端页面不能依赖离线刷新。

升级前先停服务并备份整个 `data/`，前后端应一起升级。一个数据目录只能由一个服务进程写入，一个 S3 前缀只能有一个服务端负责。不要对运行中的笔记文件做外部原地修改。

## 应用设置

登录后点击左下角齿轮，可修改应用名称和图片 Logo，并配置可选 S3 备份。支持连接权限测试、自动备份与保留数量设置，保存后实时生效。账号区和关于页提供 [GitHub 项目入口](https://github.com/gallonyin/qingji)。详见 [设置说明](docs/settings.md)。

## 数据与备份

```text
data/
├── notes/                       # Markdown 当前笔记，包含回收站内容
├── attachments/                 # 原始附件
├── settings.json                # 外观和 S3 配置（含密钥，首次保存后生成）
├── metadata.sqlite              # 历史版本、会话、索引与同步记录
├── backup-jobs.json            # 后台任务
├── backup-cache.sqlite           # 增量备份缓存
└── backup-observability.sqlite   # 任务统计
```

Markdown 与附件保存当前内容。历史版本、会话和同步状态还依赖 SQLite；丢失数据库只能重建当前笔记索引，不能重建全部历史。

S3 是后端异地备份，与浏览器到服务端同步分开。默认关闭；可在设置页填写独立桶或前缀并启用，也可首次通过环境变量设置 `S3_BACKUP_ENABLED=true`，自动备份还需 `S3_BACKUP_SCHEDULE_ENABLED=true`。默认修改静默 60 秒后备份，持续修改最长等 10 分钟；每 24 小时检查待备份变更，无变化跳过。每 168 小时到期后在下一次备份中全量核对，不是每天全桶扫描。

默认保留最近 30 个普通快照，受保护快照额外保留；发布成功并验证清单后清理未引用对象。S3 当前仅包含 `notes/` 和 `attachments/`，**不包含历史数据库**。完整冷备需要停止服务后复制整个 `data/`，包括存在的 SQLite WAL/SHM 文件。恢复冷备也应停服务后整体替换，不能只替换运行中的数据库文件。

详见 [S3 备份](docs/s3-backup.md)、[恢复保护](docs/backup-safety.md)、[历史版本](docs/note-history.md)、[Joplin 迁移](docs/migration-run.md)。

## 已知边界

- 首台设备必须在线登录和初始化。离线附件上传暂不支持；正文编辑可以离线使用。缓存过的内容仍占用浏览器存储，退出登录不会自动清空缓存，公用电脑需另行清除站点数据。
- 不是多人协作工具，不提供权限隔离、公开分享、CRDT 或端到端加密。多个浏览器并发修改同篇笔记可能生成冲突副本。
- 默认 JSON 请求上限约 1 MiB，单附件上传上限 25 MiB；部分文件操作整文件读入内存，大附件和超大笔记不是当前优化目标。
- 搜索当前使用服务端内存扫描，首次同步需下载目录元数据。规模和性能应结合实际数据测量，不承诺任意数量笔记下恒定延迟。
- 备份建立本地一致快照时短暂排队写入，上传时可继续编辑；整库恢复期间服务端禁止写入。没有共享目录多进程锁或完整断电事务保证。

本轮发布准备的检查与限制见 [审核记录](docs/publication-review.md)。

参见 [安全边界](SECURITY.md)、[参与开发](CONTRIBUTING.md)、[文件格式](docs/data-format.md)、[同步协议](docs/sync-protocol.md)。

## 许可证与兼容性

采用 [MIT](LICENSE) 许可证。展示名为轻记（Qingji）；已有 `MYNOTE_*` 配置、`@mynote/*` 工作区名、浏览器数据键及 S3 `mynote/` 前缀保留兼容，无需为改名迁移数据。
