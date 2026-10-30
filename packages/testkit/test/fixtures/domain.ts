// 测试用业务声明：采购单 + 库存 + 库存锁（与设计文档附录一致的结构）
import {
  aggregate, ceiling, command, emit, event, fail, id, int, list, money, query, reaction, ref, scope, sod, states, text,
} from '@yss123/cage-kernel';
import { approval, daysAgo, job } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import { connector, hmacSha256, inbound, op, outbound } from '@yss123/cage-connectors';
import { z } from 'zod';
export * from '@yss123/cage-admin/domain';

export const Inventory = aggregate('Inventory', {
  fields: { sku: text(64).unique(), available: int() },
  scope: scope.none(),
});

export const createInventory = command(Inventory, {
  name: 'create', from: 'new', to: 'active',
  input: z.object({ sku: z.string(), available: z.number().int() }),
  handler: (o) => o,
});

export const InventoryLock = aggregate('InventoryLock', {
  fields: { orderId: id(), items: list({ sku: text(64), qty: int() }) },
  states: states('held', 'released', { terminal: ['released'] }),
  scope: scope.none(),
});

export const POStatus = states('draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled', { terminal: ['received', 'rejected', 'cancelled'] });

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
export const OrderApproved = event('OrderApproved', { orderId: id(), items: list({ sku: text(64), qty: int() }) });
export const OrderCancelled = event('OrderCancelled', { orderId: id(), previousStatus: text() });
export const OrderReceived = event('OrderReceived', { orderId: id() });

const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

export const create = command(PurchaseOrder, {
  from: 'new', to: 'draft',
  input: z.object({ amount: z.string(), items: itemsInput, supplierPhone: z.string().optional(), deptId: z.string().uuid().optional() }),
  handler: (o) => o,
});

export const submit = command(PurchaseOrder, {
  from: 'draft', to: 'pending_approval',
  emits: [OrderSubmitted],
  handler: (o) => (o.items.length === 0 ? fail('NO_ITEMS') : o),
});

export const approve = command(PurchaseOrder, {
  from: 'pending_approval', to: 'approved',
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

export const reject = command(PurchaseOrder, { from: 'pending_approval', to: 'rejected', invokedBy: 'process', handler: (o) => o });

export const cancel = command(PurchaseOrder, {
  from: ['draft', 'pending_approval', 'approved'], to: 'cancelled',
  emits: [emit(OrderCancelled, (o, _i, prev) => ({ orderId: o.id, previousStatus: prev.status }))],
  handler: (o) => o,
});

export const acquireLock = command(InventoryLock, {
  name: 'acquire', from: 'new', to: 'held', invokedBy: 'process',
  input: z.object({ id: z.string().uuid(), orderId: z.string().uuid(), items: itemsInput }),
  handler: (o) => o,
});

export const releaseLock = command(InventoryLock, { name: 'release', from: 'held', to: 'released', invokedBy: 'process', handler: (o) => o });

export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock, tx: 'same', acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});

export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock, releases: 'inventory.lock',
  map: (e) => (e.previousStatus === 'approved' ? { id: e.orderId } : null),
});

export const poByStatus = query('poByStatus', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  sql: `select dept_id, count(*)::int as n from safe.purchase_order where status = :status group by dept_id`,
});

export const recordErpNo = command(PurchaseOrder, {
  from: 'approved', to: 'approved', invokedBy: 'external',
  input: z.object({ id: z.string().uuid(), erpNo: z.string() }),
  handler: (_o, input) => ({ erpNo: input.erpNo }),
});

export const markReceived = command(PurchaseOrder, {
  from: 'approved', to: 'received', invokedBy: 'external',
  input: z.object({ id: z.string().uuid() }),
  emits: [OrderReceived],
  handler: (o) => o,
});

export const releaseOnReceive = reaction(OrderReceived, {
  command: releaseLock, releases: 'inventory.lock',
  map: (e) => ({ id: e.orderId }),
});

export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval', start: OrderSubmitted, cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'], onApproved: approve, onRejected: reject,
});

export const poRoute = route('po-approval', [
  step('部门经理审批', approver.deptLeader('deptId')),
  when(gt('amount', 50000), step('财务审批', approver.role('finance'), { mode: 'any' })),
]);

export const erp = connector('erp', {
  hosts: { test: 'erp-sandbox.example.com', prod: 'erp.example.com' },
  secret: 'ERP_API_TOKEN',
  timeoutMs: 5000,
  operations: {
    pushOrder: op({
      effect: 'retryableWrite', method: 'POST', path: '/api/purchase-orders',
      request: z.object({ externalId: z.string(), lines: z.array(z.object({ sku: z.string(), qty: z.number() })) }),
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

export const expireStaleOrders = job('expireStaleOrders', {
  cron: '0 2 * * *', reads: [PurchaseOrder], calls: [cancel],
  run: async ({ query, call }) => {
    const stale = await query.list(PurchaseOrder, { status: 'draft', createdBefore: daysAgo(30) });
    for (const po of stale) await call(cancel, { id: po.id });
  },
});
