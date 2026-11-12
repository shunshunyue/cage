# @yss123/create-cage-app

cage create 的简短入口，用模板创建 TypeScript + React 业务项目，框架由同版本 @yss123/cage-* 依赖提供。无需全局安装，本包没有业务运行时 API。

## 创建

需要 Node.js 24+、pnpm 10：

```powershell
pnpm create @yss123/cage-app my-app --template blank
pnpm create @yss123/cage-app purchase-demo --template purchase
```

也可省略参数交互选择，取消不会创建项目。目标目录应尚不存在；复现某次创建时显式指定版本。

blank 提供登录、组织、权限和系统管理，采购源码仅在 docs 中供参考。purchase 带采购、审批、库存锁、ERP fake 与业务页面。

## 创建后

按本地启动指南配置已有 PostgreSQL，再 init、构建/生成、审查迁移、bootstrap 并 dev。初始凭据通过新受限文件交付，已有账号不重置；数据库服务由使用者环境提供。

项目含 AGENTS.md、CLAUDE.md、.agents/skills/cage-development、本地 docs/development 和 docs/errors。人从开发手册学习，AI 读取项目约束与 Skill，客户规则留在托管区外。

已有项目升级需审查对应版本资料；cage sync 只更新 AGENTS 区块，不自动覆盖教材或客户业务。普通 npm 创建不使用源码 framework-path 或本机链接。

[启动指南](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/start.md) · [开发手册](https://github.com/shunshunyue/cage/blob/main/docs/development/README.md)
