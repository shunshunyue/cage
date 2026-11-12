# HTTP、客户端与业务错误

一次失败可能有三层标识：CAGE-* 诊断指出声明或运行内部原因；HTTP code 表示接口结果；DOMAIN_ERROR 的 domainCode 表示项目定义的业务拒绝。先保留 requestId 与具体操作，再沿对应阶段排查。

## 服务端结果

| code / HTTP | 含义 | 页面下一步 |
| --- | --- | --- |
| UNAUTHENTICATED / 401 | 会话失效或认证未通过 | 恢复登录，保留原地址 |
| FORBIDDEN / 403 | 能力、调用身份、政策或 CSRF 拒绝 | 检查 detail 和实际授权 |
| NOT_FOUND / 404 | 不存在或不可见 | 核对 id、租户和范围，不泄露存在性 |
| INVALID_INPUT / 400 | schema、协议或数据库输入约束 | 按字段路径修正输入 |
| INVALID_TRANSITION / 409 | 当前状态/任务阶段不允许 | 重读并显示当前可用动作 |
| CONSTRAINT_VIOLATED / 403 | 职责分离、二次认证等硬约束 | 按规则改变操作或配置 |
| INVARIANT_VIOLATED / 409 | 最终对象不合法 | 修正变化，保留业务约束 |
| CONFLICT / 409 | 版本、唯一或并发冲突 | 重读、核对草稿与是否已提交 |
| DOMAIN_ERROR / 422 | handler 返回业务 fail | 使用 domainCode 展示业务说明 |
| RATE_LIMITED / 429 | 请求超出限流 | 有界等待，避免无限重试 |
| INTERNAL / 500 | 内部失败 | 用 requestId 查安全日志 |

有按钮不代表有权限，403 也不统一等于未登录。客户端仅在明确 CSRF 过期拒绝时刷新并沿用同一幂等键重试一次。

## 业务拒绝

handler 返回 fail('STOCK_SHORT', ['A-01']) 时，接口为：

```json
{ "code": "DOMAIN_ERROR", "domainCode": "STOCK_SHORT", "detail": ["A-01"] }
```

页面先检查 result.ok，再读取 code/domainCode；业务码由项目定义。可预期的业务拒绝使用 fail，异常留给实际程序或基础设施失败。

## 客户端等待失败

NETWORK、CANCELLED、TIMEOUT 可以由浏览器产生，status 为 0。它们说明没有取得完整可用结果，不证明服务端没有提交。

保留原输入和同次操作幂等键，先核对当前记录或任务。版本、幂等、hook 异常和会话缓存见[客户端参考](../development/reference/client.md)。

## 异步阶段另行判断

HTTP 202 表示任务接受；导入/导出需读取终态和报告，审批需等待 worker 产生待办，外部同步需核对执行与回执。

提交此前成功而 worker 后续失败是可能的。保留 task/outbox 标识，用时间线定位；unknown 外部写需要核对远端，不能直接解除隔离重发。

[按现象排错](../development/tools/troubleshooting.md) · [返回错误码册](README.md)
