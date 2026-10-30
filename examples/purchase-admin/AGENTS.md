<!-- cage:begin v0.1.0 -->
## Cage 框架约定

1. 先声明聚合、状态、命令、约束和事件，再实现 handler、查询与页面。
2. 修改后运行 cage check、cage gen、cage verify；用 cage impact --base-file 旧本体图.json 查看影响。
3. domain 的声明必须是模块顶层 export const，并从 index.ts 导出。
4. handler 的读依赖写入 reads；写入只走命令，第三方 IO 通过连接器。
5. 前端从 @app/contracts 导入契约；生成物通过 cage gen 更新。
6. 不得手写 HTTP 路由、拼接 SQL 或嵌入密钥；unsafe 必须注明 reason、owner。
7. 迁移草稿需审查，已发布的迁移不可修改；新增能力点由管理员授权。
8. 错误码见 docs/errors；完整示例见框架仓库 examples/purchase-admin。
<!-- cage:end -->

