// 采购单声明集中列出状态、范围、不变量、命令和事件。
// handler 只读声明的依赖；数据库写入、版本检查、审计由内核完成。
import {
  aggregate,
  ceiling,
  command,
  emit,
  event,
  fail,
  id,
  int,
  list,
  money,
  ref,
  scope,
  sod,
  states,
  text,
} from '@yss123/cage-kernel';
import { z } from 'zod';
import { Inventory } from './inventory.js';

export const POStatus = states('draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled', {
  terminal: ['received', 'rejected', 'cancelled'],
});

export const PurchaseOrder = aggregate('PurchaseOrder', {
  fields: {
    deptId: ref('Dept'),
    createdBy: ref('User'),
    supplierPhone: text(32).sensitive('phone').optional(),
    amount: money(),
    items: list({ sku: text(64), qty: int() }),
    erpNo: text(64).optional(),
  },
  states: POStatus,
  scope: scope.deptSubtree('deptId'),
  invariants: {
    amountPositive: (o) => Number(o.amount) > 0,
    hasItems: (o) => o.items.length > 0,
  },
});

export const OrderSubmitted = event('OrderSubmitted', { orderId: id(), amount: money(), deptId: id() });
export const OrderApproved = event('OrderApproved', {
  orderId: id(),
  items: list({ sku: text(64), qty: int() }),
});
export const OrderCancelled = event('OrderCancelled', { orderId: id(), previousStatus: text() });
export const OrderReceived = event('OrderReceived', { orderId: id() });

const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

export const create = command(PurchaseOrder, {
  from: 'new',
  to: 'draft',
  input: z.object({
    amount: z.string(),
    items: itemsInput,
    supplierPhone: z.string().optional(),
    deptId: z.string().uuid().optional(),
  }),
  handler: (o) => o,
});

export const submit = command(PurchaseOrder, {
  from: 'draft',
  to: 'pending_approval',
  emits: [OrderSubmitted],
  handler: (o) => (o.items.length === 0 ? fail('NO_ITEMS') : o),
});

export const approve = command(PurchaseOrder, {
  from: 'pending_approval',
  to: 'approved',
  invokedBy: 'process',
  constraints: [sod.notSameAs('createdBy'), ceiling('amount')],
  reads: { stock: Inventory },
  emits: [OrderApproved],
  handler: async (o, _input, { stock }) => {
    const short = [];
    for (const i of o.items) {
      const s = await stock.findOne({ sku: i.sku });
      if (!s || s.available < i.qty) short.push(i.sku);
    }
    return short.length ? fail('STOCK_SHORT', short) : o;
  },
});

export const reject = command(PurchaseOrder, {
  from: 'pending_approval',
  to: 'rejected',
  invokedBy: 'process',
  handler: (o) => o,
});

export const cancel = command(PurchaseOrder, {
  from: ['draft', 'pending_approval', 'approved'],
  to: 'cancelled',
  emits: [emit(OrderCancelled, (o, _i, prev) => ({ orderId: o.id, previousStatus: prev.status }))],
  handler: (o) => o,
});

// 仅连接器能回写 ERP 单号和收货结论，浏览器无法直接调用这两个命令。
export const recordErpNo = command(PurchaseOrder, {
  // ERP 推送可能早于取消发出、晚于取消返回；收货回调也可能先于推送应答到达。
  // 这里只记录外部回执，保留当前生命周期，保证 outbox 后续的解锁事件能够继续投递。
  from: ['approved', 'received', 'cancelled'],
  to: null,
  invokedBy: 'external',
  input: z.object({ id: z.string().uuid(), erpNo: z.string() }),
  handler: (_o, input) => ({ erpNo: input.erpNo }),
});

export const markReceived = command(PurchaseOrder, {
  from: 'approved',
  to: 'received',
  invokedBy: 'external',
  input: z.object({ id: z.string().uuid() }),
  emits: [OrderReceived],
  handler: (o) => o,
});
