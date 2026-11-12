# Cage 空白业务项目

本项目已有登录、用户/部门/角色、权限与系统管理，业务模型从你的需求开始。框架由 @yss123/cage-* 提供。

## 启动

在项目根目录按[启动指南](docs/development/getting-started/start.md)安装依赖、配置已有 PostgreSQL、init、构建/生成、审查迁移、bootstrap 后运行 dev。初始凭据通过新受限文件交付，交付后移除。

首次超级管理员可管理当前及以后新增能力，普通角色需明确授权。登录 /login，工作台 /workspace，组织成员列表 /directory/users 和详情 /directory/users/:id 使用真实 User 模型及读取范围。

## 添加自己的业务

按[便笺课程](docs/development/getting-started/first-feature.md)走通一个功能：在 domain/modules 声明并逐层导出，check/gen，审查迁移，配置权限，再在 Web modules 使用生成契约，通过 app 注册 URL。

完整导航见[开发手册](docs/development/README.md)。编程 AI 读取 [AGENTS.md](AGENTS.md) 和本地 Skill；长期业务约定放托管区外。

docs/examples/purchase-admin 是离线阅读源码，不参与运行、编译或迁移，不代表已启用采购或 AI。使用[采购导读](docs/development/examples/purchase-example.md)参考组合方式。

## 日常修改

pnpm dev 启动进程，pnpm gen 更新契约与草稿，pnpm migrate 执行审查后的结构，pnpm verify 汇总门禁。生成物从声明维护，已执行迁移保留；前端不直接导入 domain 或数据库。

structure: modular 约束模块归属和依赖，代码按[目录规范](docs/development/reference/project-structure.md)组织。页面与配置的真实验证见[路由](docs/development/guides/routing.md)和[排错](docs/development/tools/troubleshooting.md)。
