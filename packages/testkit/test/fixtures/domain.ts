// 测试用业务声明：采购单 + 库存 + 库存锁（与设计文档附录一致的结构）
// 此夹具服务内核/HTTP 的稳定回归，不等同于采购范例当前全部功能；字段和状态刻意保持最小。
// 所有 handler/map 都保持纯声明形状，真实事务、授权和事件消费由测试环境中的框架执行。
import {
  aggregate, command, emit, event, fail, id, int, list, money, query, reaction, ref, scope, sod, states, text,
} from '@yss123/cage-kernel';
import { approval, daysAgo, job } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import { connector, hmacSha256, inbound, op, outbound } from '@yss123/cage-connectors';
import { z } from 'zod';
/** 同时注册用户、部门和角色，测试使用真实组织能力与范围，不能用虚构身份绕过授权。 */
export * from '@yss123/cage-admin/domain';

/** SKU 台账：sku 为唯一编码，available 为整数件数；不按部门分范围，也不实现实际出入库扣减。 */
export const Inventory = aggregate('Inventory', {
  fields: { sku: text(64).unique(), available: int() },
  scope: scope.none(),
});

/** 创建 active 台账，通过真实字段校验与唯一索引准备审批所需库存。 */
export const createInventory = command(Inventory, {
  name: 'create', from: 'new', to: 'active',
  input: z.object({ sku: z.string(), available: z.number().int() }),
  handler: (o) => o,
});

/** 占用记录保存来源 orderId 及 SKU/件数快照；held 持有，released 保留终态历史。 */
export const InventoryLock = aggregate('InventoryLock', {
  fields: { orderId: id(), items: list({ sku: text(64), qty: int() }) },
  states: states('held', 'released', { terminal: ['released'] }),
  scope: scope.none(),
});

/** 采购状态覆盖草稿、审批、收货及拒绝/取消终点，供迁移合法性和终态检查复用。 */
export const POStatus = states('draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled', { terminal: ['received', 'rejected', 'cancelled'] });

/** 核心授权夹具：部门子树与自动创建人同时支持本人、部门、下级及全部范围的交叉断言。 */
export const PurchaseOrder = aggregate('PurchaseOrder', {
  fields: {
    /** 归属部门，缺省取操作者部门，也是审批选人的路由依据。 */
    deptId: ref('Dept'),
    /** 内核维护的创建人，供本人范围与职责分离约束使用。 */
    createdBy: ref('User'),
    /** 可为空电话，普通响应和审计掩码，明文读取需 phone 的 unmask 能力。 */
    supplierPhone: text(32).sensitive('phone').optional(),
    /** 最多两位小数的金额字符串，以元为单位，供采购流程路由使用。 */
    amount: money(),
    /** SKU 与整数件数列表；命令输入额外要求非空及正数量。 */
    items: list({ sku: text(64), qty: int() }),
    /** 可为空的第三方单号，仅由 external 回写命令设置。 */
    erpNo: text(64).optional(),
  },
  states: POStatus,
  scope: scope.deptSubtree('deptId'),
  invariants: {
    amountPositive: (o) => Number(o.amount) > 0,
    hasItems: (o) => o.items.length > 0,
  },
});

/** 提交事件携带对象 ID、金额和部门，用于审批启动与路由变量快照。 */
export const OrderSubmitted = event('OrderSubmitted', { orderId: id(), amount: money(), deptId: id() });
/** 批准事件携带物料快照，同时驱动同事务占用和异步 ERP 推送。 */
export const OrderApproved = event('OrderApproved', { orderId: id(), items: list({ sku: text(64), qty: int() }) });
/** 取消保留原状态，区分已批准持锁单与从未持锁的草稿/待审批单。 */
export const OrderCancelled = event('OrderCancelled', { orderId: id(), previousStatus: text() });
/** 收货完成只需对象 ID，后续释放反应按此 ID 定位占用。 */
export const OrderReceived = event('OrderReceived', { orderId: id() });

/** 输入边界与持久化字段分开：最少一行且数量为正，供采购和占用创建共同使用。 */
const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

/** 保存草稿，不发起审批；系统列、范围与聚合不变量由内核补齐和检查。 */
export const create = command(PurchaseOrder, {
  from: 'new', to: 'draft',
  input: z.object({ amount: z.string(), items: itemsInput, supplierPhone: z.string().optional(), deptId: z.string().uuid().optional() }),
  handler: (o) => o,
});

/** 草稿进入待审批并写提交事件；审批实例需通过 worker 消费后出现。 */
export const submit = command(PurchaseOrder, {
  from: 'draft', to: 'pending_approval',
  emits: [OrderSubmitted],
  handler: (o) => (o.items.length === 0 ? fail('NO_ITEMS') : o),
});

/** process 专用批准：验证职责分离与显式 stock 读依赖；库存不足返回 SKU 列表且不提交。 */
export const approve = command(PurchaseOrder, {
  from: 'pending_approval', to: 'approved',
  invokedBy: 'process',
  constraints: [sod.notSameAs('createdBy')],
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

/** 审批拒绝落到终态，禁止普通用户绕过流程直接调用。 */
export const reject = command(PurchaseOrder, { from: 'pending_approval', to: 'rejected', invokedBy: 'process', handler: (o) => o });

/** 取消任一未结束阶段，事件映射取提交前 status，供后续条件释放判断。 */
export const cancel = command(PurchaseOrder, {
  from: ['draft', 'pending_approval', 'approved'], to: 'cancelled',
  emits: [emit(OrderCancelled, (o, _i, prev) => ({ orderId: o.id, previousStatus: prev.status }))],
  handler: (o) => o,
});

/** 用采购单 ID 作为占用主键，重复创建产生冲突，可验证同事务反应回滚。 */
export const acquireLock = command(InventoryLock, {
  name: 'acquire', from: 'new', to: 'held', invokedBy: 'process',
  input: z.object({ id: z.string().uuid(), orderId: z.string().uuid(), items: itemsInput }),
  handler: (o) => o,
});

/** 流程将占用推进 released，不修改台账 available，也不删除历史记录。 */
export const releaseLock = command(InventoryLock, { name: 'release', from: 'held', to: 'released', invokedBy: 'process', handler: (o) => o });

/** 批准与占用共同提交；acquires 供静态资源配对，实际副作用来自 acquireLock 命令。 */
export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock, tx: 'same', acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});

/** 默认异步释放，只有原状态 approved 才有锁；null 映射验证合法跳过而非消费失败。 */
export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock, releases: 'inventory.lock',
  map: (e) => (e.previousStatus === 'approved' ? { id: e.orderId } : null),
});

/** 安全视图按 status 参数统计部门行数；验证手写查询同样需要 read 能力与当前数据范围。 */
export const poByStatus = query('poByStatus', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  sql: `select dept_id, count(*)::int as n from safe.purchase_order where status = :status group by dept_id`,
});

/** 本最小夹具只允许 approved 回写 ERP 单号；测试须先消费批准事件再取消，避免制造无关死信。 */
export const recordErpNo = command(PurchaseOrder, {
  from: 'approved', to: 'approved', invokedBy: 'external',
  input: z.object({ id: z.string().uuid(), erpNo: z.string() }),
  handler: (_o, input) => ({ erpNo: input.erpNo }),
});

/** 验签后以 external 身份确认收货，产生释放所需事件；浏览器没有该命令路由。 */
export const markReceived = command(PurchaseOrder, {
  from: 'approved', to: 'received', invokedBy: 'external',
  input: z.object({ id: z.string().uuid() }),
  emits: [OrderReceived],
  handler: (o) => o,
});

/** 收货后的异步释放路径，与取消释放共同覆盖资源生命周期。 */
export const releaseOnReceive = reaction(OrderReceived, {
  command: releaseLock, releases: 'inventory.lock',
  map: (e) => ({ id: e.orderId }),
});

/** 提交启动、取消终止审批；只把 amount/deptId 公开给路由，最终结论仍调用领域命令。 */
export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval', start: OrderSubmitted, cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'], onApproved: approve, onRejected: reject,
});

/** 部门负责人先审，金额严格大于 50000 时追加财务任一人审批；选人本身不授予命令能力。 */
export const poRoute = route('po-approval', [
  step('部门经理审批', approver.deptLeader('deptId')),
  when(gt('amount', 50000), step('财务审批', approver.role('finance'), { mode: 'any' })),
]);

/** ERP 协议夹具：固定主机、五秒超时和请求字段；测试环境注册 fake，不访问示例远端。 */
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

/** 使用订单稳定键推送外部 ID/SKU/数量，成功后经命令回填 erpNo；不发送电话或直接写领域表。 */
export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, {
  idempotencyKey: (e) => `po-${e.orderId}`,
  map: (e) => ({ externalId: e.orderId, lines: e.items.map((i) => ({ sku: i.sku, qty: i.qty })) }),
  onSuccess: { command: recordErpNo, map: (res, e) => ({ id: e.orderId, erpNo: res.erpNo }) },
});

/** 入站验证原始载荷 HMAC 和外部订单 UUID，再映射收货命令，用于合法签名与拒绝分支回归。 */
export const erpReceived = inbound(erp, 'goodsReceived', {
  verify: hmacSha256('ERP_WEBHOOK_SECRET'),
  payload: z.object({ externalId: z.string().uuid() }),
  command: markReceived,
  map: (p) => ({ id: p.externalId }),
});

/** 每日调度查询三十天前仍为草稿的单据，只调用已声明 cancel；每条取消独立经过命令事务。 */
export const expireStaleOrders = job('expireStaleOrders', {
  cron: '0 2 * * *', reads: [PurchaseOrder], calls: [cancel],
  run: async ({ query, call }) => {
    const stale = await query.list(PurchaseOrder, { status: 'draft', createdBefore: daysAgo(30) });
    for (const po of stale) await call(cancel, { id: po.id });
  },
});
