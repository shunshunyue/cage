# @yss123/cage-connectors

Cage 的外部系统连接层。声明允许的主机、操作、请求/响应 schema、密钥名称和重试策略，把领域事件映射为出站请求，并把成功回执或验签回调映射回领域命令。适用于 ERP、外部接口和模型适配器的 IO 边界。

## 安装

需要 Node.js 24+，与其他 Cage 包保持同版本。在 domain 包安装：

```powershell
pnpm add @yss123/cage-connectors zod
```

## 声明外部协议

以下文件可放入 `packages/domain/src/integrations/erp.ts`。声明时不访问网络或读取密钥；`example.com` 主机需要替换为实际服务，并验证远端幂等协议。

```ts
/** ERP 协议声明；只列出允许传出的字段，实际 IO 交给 worker。 */
import { connector, op } from '@yss123/cage-connectors';
import { z } from 'zod';

/** 外部单据写操作；retryableWrite 要求对方按请求幂等键去重。 */
export const erp = connector('erp', {
  hosts: { test: 'erp-sandbox.example.com', prod: 'erp.example.com' },
  secret: 'ERP_API_TOKEN',
  timeoutMs: 5000,
  operations: {
    pushOrder: op({
      effect: 'retryableWrite',
      method: 'POST',
      path: '/api/purchase-orders',
      request: z.object({
        externalId: z.string(),
        lines: z.array(z.object({ sku: z.string(), qty: z.number() })),
      }),
      response: z.object({ erpNo: z.string() }),
    }),
  },
});
```

在采购模板中可以继续加入事件映射；这里的事件和命令来自现有采购模块：

```ts
import { outbound } from '@yss123/cage-connectors';
import { OrderApproved, recordErpNo } from '../modules/purchase/index.js';

/** 审批事件提交后出站，回执通过 external 命令回写，不直接改表。 */
export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, {
  idempotencyKey: (event) => `po-${event.orderId}`,
  map: (event) => ({
    externalId: event.orderId,
    lines: event.items.map((item) => ({ sku: item.sku, qty: item.qty })),
  }),
  onSuccess: {
    command: recordErpNo,
    map: (response, event) => ({ id: event.orderId, erpNo: response.erpNo }),
  },
});
```

将声明从 domain 根入口导出，运行 `cage check/gen`，按需迁移后启动 API 与 worker。部署通过环境或 `SecretProvider` 提供 `ERP_API_TOKEN` 的真实值；源码只保留密钥名称。

## 本地 fake 与真实环境

worker 启动入口注册模拟实现，业务声明仍使用同一协议：

```ts
import { fakeConnector, stage } from '@yss123/cage-connectors';
import * as domain from '@app/domain';

// 仅 fake 阶段使用固定响应；test/prod 阶段按声明连接真实主机。
if (stage() === 'fake') {
  fakeConnector(domain.erp, {
    pushOrder: (request) => ({ erpNo: `DEMO-${request.externalId}` }),
  });
}
```

通过 `CAGE_STAGE` 选择阶段。fake 不代表第三方联调通过，生产必须验证协议、验签、超时和幂等性。密钥与本机日志不提交到源码。

## 公开入口与保证范围

| 入口 | 用途 |
| --- | --- |
| `connector`、`op` | 主机白名单、操作 schema、超时、限流和重试声明 |
| `outbound` | 领域事件到事务外操作的映射，成功回写调用命令 |
| `inbound`、`hmacSha256` | 原始正文验签、载荷校验及外部命令调用 |
| `fakeConnector`、`fakeCalls` | 注册模拟处理器与检查模拟调用 |
| `SecretProvider`、`setSecretProvider` | 替换服务端密钥来源，不能在浏览器调用 |
| `call`、`streamJson` | 受控服务端适配器的外呼与流读取，不用于业务 handler 直接 IO |
| `ConnectorError` | 区分外部协议、网络和执行失败 |

`effect: 'read'`、`'retryableWrite'`、`'write'` 分别表示读取、远端支持幂等的可重试写、不可安全重试写。不要为方便重试而把任意写标为 `retryableWrite`。

出站 IO 与业务数据库不共享事务，框架保存执行租约和回执以支持恢复，但不能回滚远端。结果未知的不可安全重试写会隔离；当前没有通用确认远端回执或解除 unknown 的管理接口，普通死信重放不能替代业务核对。连接器限流是每进程预算，多实例共享限流需另行设计。

## 文档

- [事件、出站与事务边界](https://github.com/shunshunyue/cage/blob/main/docs/ai/architecture.md)
- [采购 ERP 完整声明](https://github.com/shunshunyue/cage/blob/main/examples/purchase-admin/packages/domain/src/integrations/erp.ts)
- [排错方法](https://github.com/shunshunyue/cage/blob/main/docs/ai/troubleshooting.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
