# 维护框架、范例与模板

本页用于框架内部开发，业务应用先用[开发手册](../development/README.md)。包边界和验证与根 AGENTS.md 一起生效。

## 找到最小修改位置

| 能力 | 主要位置与责任 |
| --- | --- |
| 原语、事务、读侧、迁移、worker、传输 | packages/kernel/src，保持业务无关 |
| HTTP、认证、CSRF、OpenAPI | packages/http/src，协议适配并调用内核 |
| 私有字节、上传会话与清理 | packages/files/src；字段与事务绑定仍在 kernel |
| 组织、角色、防提权、系统管理 | packages/admin/src |
| 审批路由、引擎、待办与流转 | packages/approval/src；结论回到命令 |
| 外部协议与执行 | packages/connectors/src |
| 网络、hooks、界面能力 | packages/client/src |
| AI 执行、本体、浏览器协议 | packages/ai、ontology、ai-protocol；运行时不进入浏览器 |
| 抽取、图规则、生成、脚手架 | packages/cli/src；不复制运行时逻辑 |
| 测试数据库和依赖规则 | packages/testkit、packages/lint |
| 标准业务消费方式 | examples/purchase-admin，遵守其 AGENTS.md |
| 采购/空白分发 | templates/app 从范例同步；templates/blank 领域与页面独立维护 |

需求属于业务时优先修改业务声明或界面；内核确需扩展时说明必要性，增加行为回归，发布前由架构负责人评审。原有设计提案只作为背景，API 以当前公开导出与执行代码为准。

## 沿调用链查证

从入口导出开始，确认注册表、生成器、运行时与消费者怎样使用该规格。写清输入输出、状态/权限、事务、失败及兼容行为，再修改。

领域含义变化先保存图基线，重新生成并审查契约和迁移；旧迁移与已有事件兼容性需单独考虑。所有手写源码同步维护[中文注释](../development/reference/commenting.md)。

## 验证与分发

按改动运行包类型与测试，必要时使用独立 PostgreSQL 验证事务、范围、并发、迁移和恢复。范例用于证明消费方式，fake 不证明真实第三方完成，静态门禁不证明浏览器可用。

能力和指引变化依次处理：

1. 更新公开导出与真实用法，修改 CLI capabilities/sync 的检索和项目提示。
2. 同步范例 AGENTS，生成并审查范例契约。
3. 更新当前教材和错误码源资料。
4. 同步模板，检查学习资料和示例编译。
5. 构建 CLI，使分发副本包含新资料。

不直接修改 CLI 的模板副本。两模板共享配置由同步脚本拥有，空白业务和历史迁移保持自己的来源。

## 交付

说明改变的行为、为何需要框架级修改、受影响包、兼容性、验证结果及未完成的外部联调。通过、跳过、未执行分开报告；发布属于单独授权动作，流程见[npm 发布](npm发布说明.md)。

[文档维护](documentation.md) · [文档目录](../README.md)
