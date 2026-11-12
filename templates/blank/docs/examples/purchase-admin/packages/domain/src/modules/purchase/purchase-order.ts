/**
 * 采购单声明集中列出申请材料、专业复核名单、状态、范围、命令和事件，由 API、worker 和生成器统一消费。
 * 草稿可编辑专业复核名单，提交重新核对协作名录；handler 仅读取声明依赖，数据库写入、版本与审计由内核完成。
 * 审批结论仍以 process 命令执行职责分离和库存检查；选入名录或路由不授予权限。
 */
import {
  aggregate,
  bool,
  command,
  emit,
  event,
  fail,
  files,
  id,
  int,
  list,
  money,
  ref,
  scope,
  sod,
  states,
  text,
  type ReadRepo,
} from '@yss123/cage-kernel';
import { z } from 'zod';
import { Inventory } from '../inventory/index.js';
import { ApprovalMember } from './approval-members.js';

/**
 * 采购单生命周期：草稿提交后等待审批，通过后等待外部收货；退回修改重新进入草稿。
 * received/rejected/cancelled 是流程终点，终点标记供图谱检查；记录迟到 ERP 回执仍由专门命令显式允许。
 */
export const POStatus = states('draft', 'pending_approval', 'approved', 'received', 'rejected', 'cancelled', {
  terminal: ['received', 'rejected', 'cancelled'],
});

/**
 * 采购主对象保存申请材料、流程状态和外部回执；不在此聚合直接维护库存占用记录。
 * 所有写入都要求正金额和非空明细；部门字段提供范围依据，实际可见部门由当前角色授权决定。
 * 金额和附件在数据库提交前由字段原语校验，用户不能通过修改前端界面绕过约束。
 */
export const PurchaseOrder = aggregate('PurchaseOrder', {
  fields: {
    /** 归属部门；创建输入省略时使用操作者部门，也是审批选人与部门子树范围的依据。 */
    deptId: ref('Dept'),
    /** 创建人由内核设置，用于本人范围与审批职责分离，客户端不提供该身份。 */
    createdBy: ref('User'),
    /** 可缺省的供应商电话；普通读侧按 phone 策略掩码，明文读取需要单独授权和审计。 */
    supplierPhone: text(32).sensitive('phone').optional(),
    /** 采购总额，以十进制金额字符串传输，最多两位小数；范例按元解释，不存整数分。 */
    amount: money(),
    /** 可为空的用途说明；创建可先存草稿，AI 预审会判断是否足以支撑审批。 */
    reason: text(2000).optional(),
    /** 是否增加专业会签；旧记录 null/缺省按 false，不改变已经启动的审批实例。 */
    needsSpecialistReview: bool().optional(),
    /** 提交快照的专业复核用户 UUID；旧记录可为空，启用复核时必须为 1–5 个不同且非创建人的有效名录用户。 */
    reviewerIds: list(id()).optional(),
    /** 申请明细快照：sku 为物料编码，qty 为整数件数；输入额外要求每行数量为正。 */
    items: list({ sku: text(64), qty: int() }),
    /** ERP 成功响应后回填的外部单号，尚未同步时为空；不作为采购单生命周期状态。 */
    erpNo: text(64).optional(),
    /** 最多十个私有文件 ID；每个上限 2 GiB，命令提交时才把 ready 上传与本单事务绑定。 */
    attachments: files({ maxCount: 10, maxBytes: 2 * 1024 ** 3, accept: ['application/pdf', 'image/jpeg', 'image/png', 'text/plain'] }),
  },
  states: POStatus,
  scope: scope.deptSubtree('deptId'),
  invariants: {
    amountPositive: (o) => Number(o.amount) > 0,
    hasItems: (o) => o.items.length > 0,
  },
});

/** 提交快照供审批启动：orderId 关联主对象，金额和部门供声明过的路由条件使用。 */
export const OrderSubmitted = event('OrderSubmitted', { orderId: id(), amount: money(), deptId: id() });
/** 审批通过时固定需要占用/推送的物料明细，同一份事件驱动同事务建锁和异步 ERP 推送。 */
export const OrderApproved = event('OrderApproved', {
  orderId: id(),
  items: list({ sku: text(64), qty: int() }),
});
/** 取消记录原状态，使释放反应只处理此前已经批准、实际持锁的采购单。 */
export const OrderCancelled = event('OrderCancelled', { orderId: id(), previousStatus: text() });
/** 外部收货确认后发出，后台据此释放采购占用；不携带可直接写库的库存指令。 */
export const OrderReceived = event('OrderReceived', { orderId: id() });

/** 命令输入比持久化 int 原语更具体：至少一行且每行数量为正，避免零数量申请进入审批。 */
const itemsInput = z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1);

/**
 * 在设置和提交时核对专业复核名单，防止界面被绕过、名录退役或重复账号减少会签人数。
 * disabled/范围/批准能力仍由审批运行时处理；此处只按当前命令声明的名录读依赖判断业务成员 active。
 * 关闭专业复核必须传空名单；旧记录 null 等价 false/[]。最多五人使逐人查询有明确上限。
 */
async function validateReviewers(needsReview: boolean | null | undefined, ids: string[] | null | undefined, creator: string, members: ReadRepo<typeof ApprovalMember>) {
  const selected = ids ?? [];
  if (!needsReview) return selected.length ? fail('REVIEWERS_NOT_REQUIRED', '未启用专业复核时请清空复核人员') : undefined;
  if (selected.length < 1 || selected.length > 5) return fail('REVIEWERS_REQUIRED', '专业复核需选择 1–5 位协作人');
  if (new Set(selected).size !== selected.length) return fail('DUPLICATE_REVIEWERS', '同一人不能重复承担专业会签');
  if (selected.includes(creator)) return fail('REVIEWER_IS_APPLICANT', '提单人不能担任本单专业复核人');
  for (const userId of selected) {
    if (!await members.findOne({ userId, status: 'active' })) return fail('REVIEWER_UNAVAILABLE', '所选专业复核人不在有效协作名录中');
  }
}

/**
 * 保存草稿；金额格式、字段长度和不变量由内核随后统一校验，handler 无额外副作用。
 * deptId 可指定但仍须满足创建范围；attachments 为已完成上传 ID，省略时初始化为空集合。
 * 此处不提交审批、不调用 ERP，便于用户先完成材料整理。
 */
export const create = command(PurchaseOrder, {
  from: 'new',
  to: 'draft',
  input: z.object({
    amount: z.string(),
    items: itemsInput,
    supplierPhone: z.string().optional(),
    reason: z.string().max(2000).optional(),
    needsSpecialistReview: z.boolean().optional(),
    reviewerIds: z.array(z.string().uuid()).max(5).optional(),
    deptId: z.string().uuid().optional(),
    attachments: z.array(z.string().uuid()).max(10).optional(),
  }),
  // 草稿允许先保存未选完的复核需求；提交才要求完整名单，新记录统一 false/[]，旧记录兼容 null。
  handler: (o) => ({ ...o, needsSpecialistReview: o.needsSpecialistReview ?? false, reviewerIds: o.reviewerIds ?? [] }),
});

/**
 * 在 draft 中调整本单专业复核需求和名单；需要 PurchaseOrder.setReviewers，不能直接修改待审批快照。
 * 输入保存前核对 1–5 位不同且非提单人的 active 名录成员；关闭时用 false/[]，失败整次回滚。
 * 提交还会重新查询名录，以拒绝保存后退役的成员；名录不授予对单据的读取或批准能力。
 */
export const setReviewers = command(PurchaseOrder, {
  name: 'setReviewers', description: '设置采购单专业复核需求和人员', from: 'draft', to: null,
  input: z.object({ id: z.string().uuid(), needsSpecialistReview: z.boolean(), reviewerIds: z.array(z.string().uuid()).max(5) }),
  reads: { members: ApprovalMember },
  handler: async (draft, input, { members }) => {
    const invalid = await validateReviewers(input.needsSpecialistReview, input.reviewerIds, draft.createdBy, members);
    return invalid ?? { needsSpecialistReview: input.needsSpecialistReview, reviewerIds: input.reviewerIds };
  },
});

// 退回后的说明只在草稿状态修改，保留提交时的版本校验和原始审计。
/** 只更新用途并保留 draft 状态；trim 后至少一个字符，修改结果与版本递增、审计一起提交。 */
export const explainPurpose = command(PurchaseOrder, {
  from: 'draft', to: null,
  description: '补充采购用途与必要性，保存后可以重新提交审核',
  input: z.object({ id: z.string().uuid(), reason: z.string().trim().min(1).max(2000) }),
  handler: (_draft, input) => ({ reason: input.reason }),
});

/** 审批流程将材料不足的单据退回草稿；process 专用，浏览器不能绕过待办直接调用。 */
export const returnForChanges = command(PurchaseOrder, {
  from: 'pending_approval', to: 'draft', invokedBy: 'process',
  description: '审核材料不足时退回修改，重提后重新进行 AI 和人工审核',
  handler: (draft) => draft,
});

// 附件变更与其他业务写入一样受状态、版本、范围和审计约束；审批后不能替换原始材料。
/** 替换完整附件 ID 集合，空数组表示移除全部；上传归属检查、绑定和解绑由同一命令事务落实。 */
export const setAttachments = command(PurchaseOrder, {
  from: 'draft', to: null,
  input: z.object({ id: z.string().uuid(), attachments: z.array(z.string().uuid()).max(10) }),
  handler: (_draft, input) => ({ attachments: input.attachments }),
});

/**
 * 提交前重查专业复核名单，避免草稿保存后退役的成员进入新流程；缺省旧字段按无需复核处理。
 * 成功只改变状态并记录 OrderSubmitted，实例由 worker 消费后创建；HTTP 成功不表示审批完成。
 */
export const submit = command(PurchaseOrder, {
  from: 'draft',
  to: 'pending_approval',
  emits: [OrderSubmitted],
  reads: { members: ApprovalMember },
  handler: async (o, _input, { members }) => {
    if (o.items.length === 0) return fail('NO_ITEMS');
    return await validateReviewers(o.needsSpecialistReview, o.reviewerIds, o.createdBy, members) ?? o;
  },
});

/**
 * 审批终结命令必须同时满足创建人与审批人分离，以及声明的库存只读检查。
 * stock 是 reads 绑定的受范围约束仓储；找不到 SKU 或登记数量不足时返回 STOCK_SHORT 并回滚。
 * 该检查不扣减 available；真正占用由 OrderApproved 的同事务反应创建 InventoryLock。
 * 范例展示资源配对，不实现多订单累计扣减、仓库出入库或价格核算。
 */
export const approve = command(PurchaseOrder, {
  from: 'pending_approval',
  to: 'approved',
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

/** 人工审批拒绝后进入终态；此时尚未批准建锁，因此不需要发出库存释放事件。 */
export const reject = command(PurchaseOrder, {
  from: 'pending_approval',
  to: 'rejected',
  invokedBy: 'process',
  handler: (o) => o,
});

/**
 * 草稿、待审批和已批准单据均可取消；显式事件映射使用提交前快照保留 previousStatus。
 * 待审批取消会关闭对应审批，已批准取消会异步释放锁；两者都由订阅声明处理。
 */
export const cancel = command(PurchaseOrder, {
  from: ['draft', 'pending_approval', 'approved'],
  to: 'cancelled',
  emits: [emit(OrderCancelled, (o, _i, prev) => ({ orderId: o.id, previousStatus: prev.status }))],
  handler: (o) => o,
});

// 仅连接器能回写 ERP 单号和收货结论，浏览器无法直接调用这两个命令。
/** 接受可能迟到的 ERP 回执，只补单号并递增版本；to:null 明确保留 approved/received/cancelled 原状态。 */
export const recordErpNo = command(PurchaseOrder, {
  // ERP 推送可能早于取消发出、晚于取消返回；收货回调也可能先于推送应答到达。
  // 这里只记录外部回执，保留当前生命周期，保证 outbox 后续的解锁事件能够继续投递。
  from: ['approved', 'received', 'cancelled'],
  to: null,
  invokedBy: 'external',
  input: z.object({ id: z.string().uuid(), erpNo: z.string() }),
  handler: (_o, input) => ({ erpNo: input.erpNo }),
});

/** 只允许已批准单据确认收货；验签后的 external 调用触发事件，库存释放需等待 worker 消费。 */
export const markReceived = command(PurchaseOrder, {
  from: 'approved',
  to: 'received',
  invokedBy: 'external',
  input: z.object({ id: z.string().uuid() }),
  emits: [OrderReceived],
  handler: (o) => o,
});
