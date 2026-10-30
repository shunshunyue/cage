# 版本记录

## 0.1.0（2026-10-30）

- 首次以 `@yss123/cage-*` 发布框架包，创建工具为 `@yss123/create-cage-app`。
- 提供声明内核、PostgreSQL 数据边界、HTTP、组织权限、审批、连接器、异步任务和前端 SDK。
- 提供 CLI、中文本体图谱、采购范例、独立项目模板、派生测试和错误码说明。
- 包和范例的许可证为 MIT，源码仓库为 <https://github.com/shunshunyue/cage>。
- 修复脚手架安装到 `node_modules` 后误过滤模板根目录、生成空项目的问题；发布验证使用实际 tarball 在仓库外创建和构建项目。

十个 npm 包已公开发布，已通过从 npm 创建独立项目、安装、构建与声明检查。源码 GitHub 同步状态见 [发布记录](docs/release-0.1.0.md)。这是用于业务试用的首个版本，尚未完成的设计能力与生产验收见 [设计实现对照表](docs/design-coverage.md)。
