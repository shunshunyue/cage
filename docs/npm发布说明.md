# Cage 的 npm 发包步骤

更新日期：2026-10-30。本文针对本仓库的十个 npm 包，使用 PowerShell、Node.js 24 和 pnpm 10。

## 1. 已确定的发布信息

| 项目 | 值 |
| --- | --- |
| GitHub 源码 | <https://github.com/shunshunyue/cage> |
| npm 账号 | `yss123` |
| 框架包前缀 | `@yss123/cage-` |
| 创建工具 | `@yss123/create-cage-app` |
| 首版版本 | `0.1.0` |
| 发布可见性 | public，公开包免费，任何人都可下载 |
| 许可证 | MIT |

GitHub 保存源码、范例、模板、测试和文档；npm 保存经过构建的分发包。两者账号可以不同。用户通过 npm 使用框架，不需要下载维护者的源码目录。

本仓库原来使用 `@cage/*` 作为设计名称，发布时统一改为账号有权使用的 `@yss123/cage-*`。原设计文档中的名称保留供对照。

## 2. 发哪些包

| npm 包 | 职责 |
| --- | --- |
| `@yss123/cage-kernel` | 声明、命令流水线、数据库边界、worker |
| `@yss123/cage-http` | HTTP、认证、路由、API/worker 装配 |
| `@yss123/cage-admin` | 组织、角色、授权与系统管理页面 |
| `@yss123/cage-approval` | 审批路由、待办和适配 |
| `@yss123/cage-connectors` | 第三方出入站与连接器运行时 |
| `@yss123/cage-client` | 前端请求、权限判断和 hooks |
| `@yss123/cage-cli` | cage 命令、图谱、生成、模板和错误码 |
| `@yss123/cage-testkit` | 测试数据库与测试辅助能力 |
| `@yss123/cage-lint` | ESLint 与依赖边界规则 |
| `@yss123/create-cage-app` | 创建项目的简短入口 |

根工程、采购范例以及 `@app/*` 包是 private，不发布到 npm。各发布包的 `files` 是分发白名单；`.env`、数据库、本机日志、`node_modules` 和 `.cage` 不属于发布内容。

## 3. 首次登录 npm

在自己的终端执行：

```powershell
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

第一条会引导浏览器登录；第二条应输出 `yss123`。网页已经登录不等于终端已经登录。账号应完成邮箱验证并开启 npm 发布所需的双重认证。

浏览器认证、密码、验证码由账号持有人完成；不要把 token 放进仓库 `.npmrc`、源码或聊天中。根 `.npmrc` 只有 pnpm 的依赖安装选项，因此 npm 命令偶尔提示未知 pnpm 配置，不影响账号识别。

## 4. 准备实际发布包

在框架根目录执行：

```powershell
cd F:/cage
pnpm install --frozen-lockfile
pnpm release:prepare
```

`release:prepare` 按顺序完成：

1. 构建框架 CLI，使生成器使用当前源码。
2. 同步范例的 AGENTS 托管区，重新生成范例契约。
3. 将范例薄壳同步到 `templates/app`，更新错误码文档。
4. 构建框架、范例 API 和 Web，将模板、图谱与错误码打包进 CLI。
5. 将根 MIT 许可证复制到各 npm 包，执行 `pnpm pack`。
6. 检查 tarball 内实际存在的入口、资源、依赖版本及本地文件排除情况。

产物保存在：

```text
.cage/releases/0.1.0/
├─ yss123-cage-kernel-0.1.0.tgz
├─ yss123-cage-cli-0.1.0.tgz
├─ yss123-create-cage-app-0.1.0.tgz
├─ ……其他包
└─ manifest.json
```

`manifest.json` 记录包名、版本、文件数、路径与 SHA-512 完整性摘要。这一步仅在本机生成压缩包，不向 npm 上传。

我们使用 `workspace:*` 维护内部依赖。pnpm 在 pack/publish 时将其转换成实际版本；不要直接用 `npm publish packages/kernel` 发布带 workspace 引用的源码目录。

## 5. 发布前验证一次

```powershell
pnpm release:smoke
```

该命令在仓库外的系统临时目录安装真实 tarball，运行创建项目、安装、构建、声明检查和生成一致性检查，不使用 `--framework-path` 或源码 `link:`。

由于首版尚未在 npm 上，验证项目用临时依赖覆盖指向已打包的 `.tgz`；这是发包前的分发验证，不等同于“npm 注册表安装已通过”。临时路径会打印并保留供查看，不会写回正式模板。

框架改动的发布验收按范围运行一次：

```powershell
# Docker Desktop 就绪后执行，使用真实 PostgreSQL。
pnpm test:docker
pnpm example:verify
node packages/cli/bin/cage.js budget
```

`release:prepare` 已包含构建，不必再单独重复完整构建。普通文档调整不需要重复数据库测试；发布记录分别写明通过、跳过和未执行项。

## 6. 上传源码到 GitHub

仓库已初始化为 `main`，origin 指向用户提供的仓库：

```powershell
git remote -v
git status --short
git add .
git diff --cached --stat
git diff --cached --check
git commit -m "Prepare Cage 0.1.0 release"
git push -u origin main
```

首次使用 Git 时可能需要浏览器完成 GitHub 登录。提交前检查文件列表：应包括源码、锁文件、模板、文档和包的 README/LICENSE，不包括 `.env`、运行数据或发布压缩包。

如果 Windows 浏览器可访问 GitHub，而 Git 连不上，检查是否使用了系统代理。当前机器观察到的本地代理为 `127.0.0.1:7897`；可针对一次命令指定：

```powershell
git -c http.proxy=http://127.0.0.1:7897 push -u origin main
```

只有这台机器的代理仍运行时才使用该地址；不要把它写进 CI 配置或当作所有使用者的默认代理。

本机还已验证可以通过 GitHub 的 SSH 443 端口认证为 `shunshunyue`。HTTPS 不通时，可针对这一次推送使用同仓库的 SSH 地址，不修改 origin 的 HTTPS 配置：

```powershell
git -c core.sshCommand=C:/Windows/System32/OpenSSH/ssh.exe -c remote.origin.pushurl=ssh://git@ssh.github.com:443/shunshunyue/cage.git push -u origin main
```

这条 Windows 命令显式使用系统 OpenSSH，本机 Git 自带的 SSH 曾无法解析域名；它依赖本机已经配置且获 GitHub 授权的 SSH 身份，不是所有新机器都能直接使用。标签同理，将末尾 `main` 换成 `v0.1.0`。

## 7. 首版手动发到 npm

确认账号、版本、构建和检查结果后，预览发布：

```powershell
pnpm --filter "./packages/*" -r publish --dry-run --access public --registry=https://registry.npmjs.org/
```

正式发布：

```powershell
pnpm --filter "./packages/*" -r publish --access public --registry=https://registry.npmjs.org/ --report-summary
```

这是对十个框架包的批量公开发布，不会发布 private 工作区。终端需要双重认证时按 npm 提示完成；浏览器未确认时不要把命令退出或等待状态当作发布成功。

首版直接发布可能为每个包分别打开一次认证。建议账号持有人在自己的可见终端执行，出现 `Press ENTER to open in the browser` 就按回车，完成当前页面认证后返回终端等待下一步。认证链接属于当次请求，旧链接出现 404 时先看终端是否已经进入下一个包，不要反复打开旧链接。

源码应已经提交并推送，保留 pnpm 的 Git 工作区检查。不要用 `--force` 掩盖发布失败，也不要尝试覆盖相同版本。

若 GitHub 网络暂时不可用，但本地源码已提交、版本和分发检查已完成，维护者明确选择先发 npm 时可追加 `--no-git-checks`。这只跳过 Git 状态检查，不跳过 npm 登录或 2FA；发布记录需注明 GitHub 尚未同步，恢复网络后补推源码。

批量发包不是原子操作：若中途失败，部分包可能已上传。先用 `npm view 包名@版本 version` 核对；修好认证/网络问题后重新运行 pnpm 递归发布，会跳过已经存在的版本。已经发出的错误包不能用同版本覆盖，应修复后提升版本。

`--report-summary` 的 `pnpm-publish-summary.json` 是本地发布回执，不提交为源码；实际结果以 npm 查询为准。

## 8. 确认别人可以安装

先查注册表：

```powershell
npm view @yss123/cage-kernel@0.1.0 version --registry=https://registry.npmjs.org/
npm view @yss123/cage-cli@0.1.0 version --registry=https://registry.npmjs.org/
npm view @yss123/create-cage-app@0.1.0 version --registry=https://registry.npmjs.org/
```

然后在框架目录之外，用**尚不存在**的项目名创建：

```powershell
cd F:/
pnpm create @yss123/cage-app@0.1.0 cage-npm-demo
cd F:/cage-npm-demo
pnpm install
pnpm build:app
pnpm exec cage check
```

这里不加 `--framework-path`，也不增加 `.tgz` 覆盖，才证明普通使用者可以从 npm 获取全部框架依赖。

要继续启动数据库和页面，按 [使用说明](使用说明.md) 设置独立端口，再执行 `db setup`、`db up`、`db init` 和 `dev`。

首版发布验证完成后，更新 CHANGELOG 的“准备发布”状态，提交记录，并为发布对应源码打标签：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## 9. 后续如何升级版本

例如准备 `0.1.1`：

```powershell
cd F:/cage
pnpm release:version 0.1.1
pnpm install
pnpm release:prepare
pnpm release:smoke
```

`release:version` 同步十个包的版本，不自动提交或发布。CLI、upgrade、AGENTS 托管区和模板都从包版本读取当前版本；修改版本后仍需运行 prepare 生成对应分发资源。

更新 `CHANGELOG.md`、做本次改动所需验证、提交并推送后，再发布。同一个包的同一个版本只能发布一次。

预发布版本如 `0.2.0-beta.1` 应使用 `--tag next`，不要把试用版放到默认 `latest`。正式 `0.1.1` 则使用默认 `latest`。

## 10. 后续改用 GitHub 自动发布

仓库提供 `.github/workflows/release.yml`，只支持手动触发，不会在普通源码 push 时自动发包。流程先复用框架验收，再构建、检查 tarball、做仓库外安装，最后使用 npm Trusted Publishing 上传。

首版包存在后，在 npm 网站**每一个包**的 Settings → Trusted Publisher 配置：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `shunshunyue` |
| Repository | `cage` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

GitHub 仓库 Settings → Environments 可为 `npm` 环境设置所需的发布审核规则。此配置在网站侧完成，工作流文件本身不会自动添加审核人。

后续版本先提交并推送对应 `v版本` 标签，然后在 Actions → Publish npm packages → Run workflow 中选择该标签。工作流要求标签与 CLI 版本相同，并使用 GitHub OIDC 发布，不需要在仓库保存长期 npm token。

此路径使用官方支持的 GitHub 托管 runner、Node.js 24 和 npm 11。第一次本机发布不等于 Trusted Publisher 已配置完成；首次 CI 成功运行前，自动发布仍属于待验收状态。

## 11. 常见错误

| 错误/现象 | 处理 |
| --- | --- |
| `ENEEDAUTH` | 在本机重新执行 npm login，再用 whoami 确认是 yss123 |
| `EOTP` 或浏览器认证提示 | 由账号持有人完成 npm 双重认证，等待命令结束 |
| `E403` | 核对账号、scope 权限、邮箱和 2FA；确认不是尝试覆盖已有版本 |
| 注册表查不到某个包 | 看批量发布是否中途失败，不以其他包发布成功推断全部成功 |
| `workspace:` 安装失败 | 使用 pnpm pack/publish，检查是否误用了 npm 发布源码目录 |
| 模板还依赖旧版本 | 执行 release:prepare，不单独修改 CLI 的旧分发副本 |
| Git 检查失败 | 先提交/推送正确分支，查看工作区改动，不直接关闭检查 |
| npm 警告未知 pnpm 配置 | 仓库 .npmrc 的 pnpm 专用项所致；不等同于发布失败 |

官方参考：[npm 公开包](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)、[pnpm publish](https://pnpm.io/cli/publish)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)。
