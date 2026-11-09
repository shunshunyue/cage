// ERP 的两个边界：出站只发送声明允许的字段，入站回调必须通过 HMAC 验签。
// 本地由 worker 注册 fake；这里始终只写声明，不发送请求或读取环境变量。
import { z } from 'zod';
import { connector, hmacSha256, inbound, op, outbound } from '@yss123/cage-connectors';
import { OrderApproved, recordErpNo, markReceived } from '../modules/purchase/index.js';

/**
 * ERP 出站协议限定主机、五秒超时、环境密钥名称和请求/响应字段，导入本文件不会发起网络访问。
 * pushOrder 声明 retryableWrite 的前提是远端接受稳定幂等键；生产接入应落实 ERP 去重协议。
 * externalId 是 Cage 采购单 ID，lines 只含物料编码与件数，不把电话、用途或附件隐式发送到第三方。
 */
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

/**
 * 审批提交后由 worker 消费批准事件，使用订单 ID 构成稳定幂等键，重试不会主动生成另一张外部单据键。
 * 请求只从事件快照映射；成功响应再以 external 身份调用 recordErpNo，不能直接更新采购表。
 * IO 与领域命令不共享数据库事务，可靠执行与回执记录负责恢复；迟到响应由目标命令保留当前终态。
 */
export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, {
  idempotencyKey: (e) => `po-${e.orderId}`,
  map: (e) => ({ externalId: e.orderId, lines: e.items.map((i) => ({ sku: i.sku, qty: i.qty })) }),
  onSuccess: { command: recordErpNo, map: (res, e) => ({ id: e.orderId, erpNo: res.erpNo }) },
});

/**
 * 第三方收货入口先用 ERP_WEBHOOK_SECRET 对原始请求体做 HMAC 校验，再验证订单 UUID。
 * 映射只定位采购单，收货合法状态、事件、审计和版本由 markReceived 的完整流水线负责。
 * 签名密钥名称可公开，真实值只能由部署环境注入；回调不能用来绕过命令直接释放库存。
 */
export const erpReceived = inbound(erp, 'goodsReceived', {
  verify: hmacSha256('ERP_WEBHOOK_SECRET'),
  payload: z.object({ externalId: z.string().uuid() }),
  command: markReceived,
  map: (p) => ({ id: p.externalId }),
});
