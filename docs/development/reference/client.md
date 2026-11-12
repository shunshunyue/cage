# 客户端、结果与并发

业务页面从 @app/contracts 使用生成的对象方法和 hooks。@yss123/cage-client 处理 Cookie、CSRF、网络结果、会话及通用协议；浏览器无需导入 domain、数据库或服务端内核。

## 读取和写入的方法形状

便笺课程生成的方法示例：

```ts
await note.list({ page: 1, pageSize: 20, sort: '-createdAt' });
await note.get(id);
await note.create({ title });
await note.update(id, { title }, version);
await note.archive(id, version);
```

具体输入、版本与最后的 RequestOptions 参数以当前生成契约为准。只允许 user 的写入才向浏览器生成方法；流程批准通过待办协议完成，不能假设一定有对象的 approve 方法。

list/related 返回 items、total、page、pageSize，total 是当前权限和筛选范围内数量。页码默认 1、每页默认 20，普通读取最多 200。status 可逗号分隔；sort 前缀 - 表示降序，默认 -createdAt，另按 id 保持稳定。

createdAfter 包含下界，createdBefore 不含上界。普通过滤是允许字段的等值条件；JSON、集合、隐藏和敏感字段不能任意作为普通过滤字段。非法布尔、日期、数值、页码或排序字段返回 INVALID_INPUT。当前使用 offset 和精确计数，大规模成本需要实际评测。

## 处理 CageResult

底层方法成功返回 { ok: true, data }，失败返回 ok: false 及 code、domainCode、detail、status、requestId 等信息。先判断 ok，再使用 data。

DOMAIN_ERROR 的业务含义看 domainCode；CONFLICT 需要重新读取并核对；NOT_FOUND 也可能表示范围外。NETWORK、CANCELLED、TIMEOUT 可以由客户端产生，status 为 0。

useCageQuery/useCageList 失败抛 CageQueryError。useCageCommand 成功返回业务数据，失败抛 CageCommandError，因此 mutation.isSuccess 表示业务成功；只有成功才触发所配置的查询失效。是否等待重新读取完成，由页面流程决定。

## 版本、幂等与重试

修改已有记录时传读取到的 version，防止旧页面覆盖新值。冲突后保留用户草稿，刷新当前记录并让用户确认下一步。

RequestOptions 支持 signal、timeoutMs、idempotencyKey。每次独立 post 默认生成新幂等键；业务要恢复同一次操作时，需要保存原输入和键。当前页面的提交锁可以避免重复点击，但不能替代跨刷新或跨设备去重。

网络失败不自动重放写入。仅明确 CSRF 拒绝时刷新令牌并沿用同一键重试一次。取消或超时结束的是客户端等待，服务端可能已经提交；重试前核对结果。内核幂等缓存有期限，长期业务去重需要业务标识或专门回执。

## 会话与缓存

CageClient 实例各自保存身份与能力。默认 client、loadMe、currentUser、can 和 hooks 使用约定实例；需要多实例时显式传入当前公开 API 支持的实例参数。

应用启动先恢复会话，再显示登录区域。通过 client.subscribe 处理 logout、401、account-switch 等事件，取消旧身份请求并清理应用的查询缓存。SDK 的 revision 防止迟到响应恢复旧身份，应用自己的业务缓存仍需清理。

## 通用能力

| 任务 | 客户端入口与指南 |
| --- | --- |
| 审批待办和任务动作 | client.approvalTasks、decideApprovalTask 等，[审批指南](../guides/approvals.md) |
| 导入导出 | client.importCsv、transfer、useTransfer，[数据传输](../guides/transfers.md) |
| 附件 | beginUpload、upload、uploadSession、fileInfo 等，[文件指南](../guides/files.md) |
| 随页助理 | client.ai、useAssistant、useAiPageContext，[原生 AI](../guides/intelligence.md) |

前端 Zod 校验提供即时提示。可执行 refine、transform 等规则不能完整复制到契约，服务端仍决定是否接受；生成警告 CAGE-GEN-003 指出无法完整表达的位置。

[页面与路由](../guides/routing.md) · [返回开发手册](../README.md)
