# 沿一张采购单阅读完整框架

采购范例把领域、审批、库存锁、ERP、附件和助理组合成可运行应用。它演示如何消费框架，采购规则属于范例，不自动成为其他项目需求。

## 先找到实际源码

| 所处项目 | 本文源码路径从哪里起算 |
| --- | --- |
| 框架仓库 | examples/purchase-admin |
| purchase 模板 | 当前应用根目录 |
| blank 模板 | docs/examples/purchase-admin，只有阅读源码 |

下文 domain 路径相对 packages/domain/src，Web 路径相对 apps/web/src。blank 的采购参考不参与注册、构建或迁移；要运行完整演示可创建 purchase 项目。

例如下面两份同名领域文件的角色不同：purchase 项目中的 packages/domain/src/modules/purchase/purchase-order.ts 会运行；blank 项目中 docs/examples/purchase-admin/packages/domain/src/modules/purchase/purchase-order.ts 只是参考，编辑它不会改变当前应用。

## 第一遍只读主链

1. domain index.ts 统一导出组织、业务、workflows 和 integrations。
2. modules/purchase/purchase-order.ts 定义 PurchaseOrder、命令和事件。
3. modules/purchase/approvals.ts 绑定提交/取消及结论，定义审核路线。
4. workflows/purchase-inventory.ts 连接批准、取消和收货的资源动作。
5. integrations/erp.ts 定义外部操作、出站、回写与入站验签。

先回答“谁让下一步发生”，再去看对应页面和工具。读依赖、状态相接和资源标签各有含义，真正执行链需落实到命令、事件与反应。

例如实际根入口把模块与联动统一导出，CLI、API 和 worker 从同一入口取得它们：

<!-- cage:example purchase-domain-exports -->
```ts
export * from '@yss123/cage-admin/domain';
export * from './modules/inventory/index.js';
export * from './modules/purchase/index.js';
export * from './workflows/purchase-inventory.js';
export * from './workflows/purchase-process.js';
export * from './integrations/erp.js';
export * from './integrations/intelligence.js';
```

## 保存和提交

PurchaseOrder 保存金额字符串、明细、部门、创建人、用途、专业复核需求、候选人员和附件 ID。金额必须为正、明细非空，输入再限制行数量。

例如聚合的两个最终不变量直接对应这两条规则，以下摘录位于 aggregate 选项内：

<!-- cage:example purchase-invariants -->
```ts
invariants: {
  amountPositive: (o) => Number(o.amount) > 0,
  hasItems: (o) => o.items.length > 0,
},
```

create 保存草稿。setReviewers 调整专业需求和名单，提交时重新核对名录：需要复核时为 1–5 个不同、非提单人的有效用户。协作名录记录业务资料，不授予批准能力。

submit 成功后记录 OrderSubmitted；worker 消费并启动流程。提交响应证明主事务完成，实际待办需进一步读取。

例如真实提交命令先检查明细及专业人员，然后才让事件随事务保存。members 来自显式 reads，不在 handler 内另建查询连接：

<!-- cage:example purchase-submit -->
```ts
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
```

## 审核路线和结论

当前路线为 AI 材料预审 → 部门经理 → 可选专业会签 → 严格大于 50000 元的财务候选池。恰好 50000 元跳过财务。专业会签需全部人通过，财务先领取。

例如实际专业与财务条件使用两个独立 when，分别读取 routable 中的业务字段：

<!-- cage:example purchase-conditional-review -->
```ts
when(eq('needsSpecialistReview', true), step('专业人员会签', approver.field('reviewerIds'), {
  mode: 'all', actions: { transfer: true, delegate: true, addSign: true },
})),
when(gt('amount', 50000), step('财务候选受理', approver.role('finance'), {
  assignment: 'candidate', mode: 'any', actions: { transfer: true, delegate: true, addSign: true },
})),
```

AI 的 main 模型和自动角色需真实配置，材料不足退回修订，不确定或模型失败按策略人工接管。修订后重新提交新轮次。人工经理、专业与财务节点可按政策转办、委派及前后/并行加签，旧实例沿用快照。

approve/reject/returnForChanges 是 process 命令，最后决定人需能力、范围及职责分离。批准还读取库存并做业务检查；被选中或进入名录不免除这些条件。

## 批准与资源占用共同提交

OrderApproved 同时驱动库存锁命令和 ERP 后续。库存锁反应使用 same，锁失败使批准回滚。acquires/releases 为静态资源配对，真正记录由 InventoryLock 命令保存。

例如实际批准建锁代码如下，event 的固定明细交给 acquireLock：

<!-- cage:example purchase-lock-reaction -->
```ts
export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock,
  tx: 'same',
  acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});
```

取消和收货后异步释放。取消事件带 previousStatus，草稿取消不会尝试释放未取得资源；新增其他离开持有状态的路径也需要核对释放。

例如旧状态为 approved 才释放，其他取消直接返回 null；没有显式 tx，所以采用默认 outbox：

<!-- cage:example purchase-release-reaction -->
```ts
export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock,
  releases: 'inventory.lock',
  map: (e) => (e.previousStatus === 'approved' ? { id: e.orderId } : null),
});
```

Inventory.available 是演示台账，库存锁用于演示生命周期，不提供完整仓库级并发扣减、实物库存、退货核算。

## ERP 在本地提交之后

出站将事件映射到固定操作，远端幂等依赖协议。成功回执通过 external 命令 recordErpNo 回填；to: null 保留取消或收货后的当前状态，仍检查允许的 from。

例如出站明确区分请求映射与成功回写，不直接更新采购表：

<!-- cage:example purchase-erp-outbound -->
```ts
export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, {
  idempotencyKey: (e) => `po-${e.orderId}`,
  map: (e) => ({ externalId: e.orderId, lines: e.items.map((i) => ({ sku: i.sku, qty: i.qty })) }),
  onSuccess: { command: recordErpNo, map: (res, e) => ({ id: e.orderId, erpNo: res.erpNo }) },
});
```

recordErpNo 的实际选项允许晚到回执，保持当前状态；这不会把已取消单据重新变成 approved：

<!-- cage:example purchase-erp-receipt-options -->
```ts
from: ['approved', 'received', 'cancelled'],
to: null,
invokedBy: 'external',
input: z.object({ id: z.string().uuid(), erpNo: z.string() }),
handler: (_o, input) => ({ erpNo: input.erpNo }),
```

入站基于原始 JSON 的 HMAC-SHA256 验签，成功调用收货命令，再发事件释放锁。fake 证明本地映射和回写，真实 ERP 联调需单独验证；取消目前只改变本地状态与资源，尚无远端撤销补偿。

例如回调仍落到 markReceived 领域命令，签名密钥名称可写进声明，实际值不在源码中：

<!-- cage:example purchase-erp-inbound -->
```ts
export const erpReceived = inbound(erp, 'goodsReceived', {
  verify: hmacSha256('ERP_WEBHOOK_SECRET'),
  payload: z.object({ externalId: z.string().uuid() }),
  command: markReceived,
  map: (p) => ({ id: p.externalId }),
});
```

## 页面和原生 AI

app 组合路由、会话、布局和跨模块链接。采购列表为 /procurement/orders，详情为 /procurement/orders/:id，审批 /approvals，库存 /inventory。页面从 @app/contracts 调用，不执行领域 handler。

integrations/intelligence.ts 启用模型和助理；shared/ui/assistant-panel.tsx 展示流式回复、进度和确认。业务页提供对象、筛选、选择和草稿语义。框架提供执行，应用提供策略与界面。

例如采购项目的导航使用实际业务 URL；普通详情可以直接打开，不依赖列表中的内存选中项：

<!-- cage:check web purchase-navigation -->
```tsx
export function PurchaseLinks({ id }: { id: string }) {
  return <nav>
    <Link to="/procurement/orders">采购列表</Link>
    <Link to={`/procurement/orders/${encodeURIComponent(id)}`}>当前采购详情</Link>
    <Link to="/approvals">审批</Link>
    <Link to="/inventory">库存</Link>
  </nav>;
}
```

## 运行时怎样验收

按本应用 README 启动；准备采购员、不同的部门负责人、专业人员及 finance 角色，分别配置能力与范围。登记真实台账后，从创建到批准、ERP 回写、取消或收货逐步检查。

还要覆盖退回重提、自审批、缺能力、范围外、库存不足、版本冲突、候选领取、加签等待和外部失败。声明检查、派生测试、项目业务测试、浏览器、模型与真实 ERP 各自报告，历史记录不能替代本次执行。

例如前置节点处理完成后，金额 50000 的单据跳过财务，50000.01 进入 finance 候选池；对后者先领取再批准。再故意让库存建锁失败，应确认批准状态和库存锁均没有提交，而不是只观察按钮报错。

开始自己的业务时复用声明模式和薄壳，替换对象、规则与界面；按[业务设计](../guides/recipes.md)确定范围，保留已执行迁移。

[返回开发手册](../README.md)
