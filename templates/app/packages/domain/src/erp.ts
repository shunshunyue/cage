// ERP 的两个边界：出站只发送声明允许的字段，入站回调必须通过 HMAC 验签。
// 本地由 worker 注册 fake；这里始终只写声明，不发送请求或读取环境变量。
import { z } from 'zod';
import { connector, hmacSha256, inbound, op, outbound } from '@yss123/cage-connectors';
import { OrderApproved, recordErpNo, markReceived } from './purchase-order.js';

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

export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, {
  idempotencyKey: (e) => `po-${e.orderId}`,
  map: (e) => ({ externalId: e.orderId, lines: e.items.map((i) => ({ sku: i.sku, qty: i.qty })) }),
  onSuccess: { command: recordErpNo, map: (res, e) => ({ id: e.orderId, erpNo: res.erpNo }) },
});

export const erpReceived = inbound(erp, 'goodsReceived', {
  verify: hmacSha256('ERP_WEBHOOK_SECRET'),
  payload: z.object({ externalId: z.string().uuid() }),
  command: markReceived,
  map: (p) => ({ id: p.externalId }),
});
