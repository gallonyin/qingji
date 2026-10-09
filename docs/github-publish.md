# GitHub 发布 SOP

公开仓库：https://github.com/gallonyin/qingji 。提交身份：`gallonyin <gallonyin@gmail.com>`。

## 首次发布

1. 用 `gh auth status` 确认当前 GitHub 账号为 `gallonyin`。可复用 Mac 钥匙串中的 GitHub CLI 登录；不要复制、打印或提交访问令牌。
2. 检查工作区和跟踪文件，确认不包含真实 `.env`、笔记、附件、数据库、S3 密钥、迁移报告或私人截图。
3. 执行类型检查、测试、构建、Python 迁移测试和依赖审计，参考根 README 的命令。
4. 在独立目录通过 `git archive HEAD` 导出已提交源码，初始化一个新的 Git 仓库。原工作仓库有私人历史，不能直接推送其历史到公开仓库。
5. 在发布目录设置本仓库提交身份，建立公开初始提交，添加远程地址并执行 `git push -u origin main`。
6. 核对远端提交 SHA 和首次 GitHub Actions CI 结果。

## 后续更新

以公开仓库历史为基础提交更新。可以在首次发布的独立目录继续操作，或另行克隆：

```bash
gh repo clone gallonyin/qingji qingji-public
cd qingji-public
git config user.name gallonyin
git config user.email gallonyin@gmail.com
git pull --ff-only
```

将审核后的源码修改同步到公开 checkout，包含新增文件及有意删除的文件；不要复制原仓库的 `.git`、运行数据或凭证。确认 diff，执行检查，再提交和推送：

```bash
git status --short
git diff --check
git diff
npm ci
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s scripts/tests
npm audit --registry=https://registry.npmjs.org --audit-level=moderate
git add <本次审核过的文件路径>
git commit -m "描述本次修改"
git push origin main
gh run list --repo gallonyin/qingji --branch main --limit 3
```

不要从旧私有仓库合并历史，不要强制推送。推送代码不会自动部署应用。

## 需要账号所有者协助的情况

- 登录失效时，在本机执行 `gh auth login --hostname github.com --web` 完成浏览器授权，无需把令牌发给协作者。
- 仓库权限不足或启用了分支保护时，授予相应权限或改用 Pull Request。
- 实际部署需要另行提供目标服务器、域名及部署方式；真实密码和 S3 凭证保留在运行环境中。
