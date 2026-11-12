# @yss123/cage-client

浏览器网络、会话与 React hooks：Cookie、CSRF、类型化结果、取消、超时、幂等键、查询/命令、上传和 AI 流式协议。生成的 contracts 在本包之上提供业务对象方法。

## 使用

安装 pnpm add @yss123/cage-client react @tanstack/react-query zod，框架保持同版本。脚手架已配置 Provider 和共享 client。

```ts
import { configureClient, loadMe } from '@yss123/cage-client';

/** 站点前缀不额外附加 /api；恢复失败由应用区分未登录与网络问题。 */
configureClient({ baseUrl: '', timeoutMs: 30_000 });
const result = await loadMe();
if (!result.ok) console.error(result.code, result.requestId);
```

业务从 @app/contracts 调用已生成方法，例如 note.create。底层先检查 result.ok；useCageCommand 成功解包 data，失败抛 CageCommandError，mutation.isSuccess 才表示业务成功。

## 并发和会话

已有对象传读取版本，RequestOptions 支持 signal/timeoutMs/idempotencyKey。独立请求默认不同键，同次恢复需由应用保留输入与键；网络失败不自动重放写入，取消等待不证明服务端没提交。

应用订阅 client.subscribe，在退出/401/账号切换时清理查询缓存与用户状态。can/useCan 只用于呈现，不产生授权。不同 CageClient 实例各自管理会话。

上传 task 的 start/pause/cancel/dispose 和 client.ai 的会话/流式接口按指南组合；界面与业务策略由应用实现。浏览器不导入 domain、数据库或 AI 服务端。

[客户端参考](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/client.md) · [随页 AI](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md)
