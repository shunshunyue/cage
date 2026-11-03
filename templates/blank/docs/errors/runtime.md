# HTTP 运行时错误与业务码

[返回错误码册](README.md) · [排错方法](../ai/troubleshooting.md)

框架诊断分三层：`CAGE-APPR-007` 等内部/工具码、HTTP 响应的通用 `code`、业务拒绝的 `domainCode`。同一次失败可以同时涉及几层；例如审批人配置问题出现在 worker 死信，前端提交此前可能已成功。

## 接口错误

| code | HTTP | 含义 | 业务前端/AI 应怎么做 |
| --- | --- | --- | --- |
| UNAUTHENTICATED | 401 | 会话不存在/失效或认证未通过 | 重新登录；回调先核对验签，不跳过认证 |
| FORBIDDEN | 403 | 无能力、身份不允许，或 CSRF 拒绝等 | 看 detail 与当前授权；不能只因有按钮就认为有权。客户端会刷新过期 CSRF 令牌重试 |
| NOT_FOUND | 404 | 记录不存在或超出范围 | 用当前用户检查 id/租户/范围，不泄漏范围外数据 |
| INVALID_INPUT | 400 | Zod/协议输入错误、外键或检查约束等 | 按输入 schema 修正字段和格式，不直接扩大 schema |
| INVALID_TRANSITION | 409 | 当前状态不允许该命令 | 刷新记录，按真实生命周期显示允许操作 |
| CONSTRAINT_VIOLATED | 403 | 职责分离、额度、二次认证、防提权等拒绝 | 看约束原因，调整业务操作或由有权管理员配置；不删除约束 |
| INVARIANT_VIOLATED | 409 | 命令结果不满足聚合不变量 | 修正输入或 handler，保持合法结果 |
| CONFLICT | 409 | 版本、唯一性、数据库串行化/死锁等冲突 | 看 detail、重新读取再决定是否重试；不要盲目重复创建 |
| DOMAIN_ERROR | 422 | handler 返回 fail | 读取 domainCode，展示业务文案和必要 detail |
| RATE_LIMITED | 429 | 请求超过限流 | 按提示等待，避免页面无限重试 |
| INTERNAL | 500 | 未分类内部错误 | 用 requestId 查服务端日志，向用户显示通用失败；不返回堆栈/密钥 |
| NETWORK（仅客户端） | 0 | 请求未取得可用网络响应 | 检查连接与服务状态；保留同次操作幂等键，避免误认为服务端一定未执行 |

网络失败和超时不证明服务端事务未提交。通用重试与人工重试都需考虑幂等与当前状态，不能先写 SQL 回滚业务再重发。

## 业务码用法

领域 handler 返回：

```ts
return fail('STOCK_SHORT', ['A-01']);
```

HTTP 响应形状为：

```json
{ "code": "DOMAIN_ERROR", "domainCode": "STOCK_SHORT", "detail": ["A-01"] }
```

客户端方法返回可区分结果，先判断 `result.ok`；失败时看 `result.code`，业务错误再看 `result.domainCode`。不要假设 code 直接等于 STOCK_SHORT，也不要把所有 403 当作“请重新登录”。

业务码由项目定义并在页面翻译；字段 schema、不变量、硬约束和业务 fail 各有职责。正常业务拒绝不要伪装成普通异常导致 INTERNAL。

## 异步任务与死信

导入/导出 HTTP 202 只表示任务已接受，任务详情另有 queued/processing/retrying/completed/failed/expired。检查 task.errorCode/result 和导入报告，完成后才提供成功提示或下载。

outbox 消费失败可能重试或进死信；修复内层错误后重放，查看同一聚合后续消息是否继续。使用管理接口处理，不直接更新 sys.outbox 或业务状态。

当前实现定义位于框架源码 `packages/kernel/src/errors.ts` 与客户端包；实际 API 响应为准。生成契约会列出命令可能的通用错误与能抽取到的业务码，但不代表任何错误都已被实际测试覆盖。
