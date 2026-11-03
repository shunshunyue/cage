# 原语与最小业务

[返回学习入口](README.md) · [开发步骤](workflow.md)

本页代码使用当前公开导出。完整文件示例可直接放入应用；标为“片段”的代码需要结合采购范例已有符号使用。不要把片段中的变量名当成新的框架 API。

文件字段使用 `file({ maxBytes, accept }).optional()` 或 `files({ maxBytes, accept, maxCount })`。字段保存文件 ID，上传/续传先获得临时文件，最终通过业务命令绑定；完整流程、限制和存储配置见[文件指南](files.md)。

## 最小的增、查、改、归档业务

下面是完整的 `packages/domain/src/modules/note/note.ts`。它演示带部门范围的便笺，不影响采购范例原有业务；需要此业务时才添加文件。

```ts
import { aggregate, command, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120),
    deptId: ref('Dept'),
    createdBy: ref('User'),
  },
  states: states('active', 'archived', { terminal: ['archived'] }),
  // 指明部门字段。最终能看哪个部门，由角色的数据范围决定。
  scope: scope.deptSubtree('deptId'),
  invariants: { titleNotBlank: (o) => o.title.trim().length > 0 },
});

export const createNote = command(Note, {
  // 使用独立导出名避免多个文件 export * 时 create 重名；能力仍叫 Note.create。
  name: 'create',
  from: 'new',
  to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  // 新建草稿已有输入字段；deptId 和 createdBy 由内核按当前主体填入。
  handler: (draft) => draft,
});

export const updateNote = command(Note, {
  name: 'update',
  from: 'active',
  to: null,
  input: z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(120) }),
  // 只返回业务变化，状态、版本及审计仍由内核维护。
  handler: (_draft, input) => ({ title: input.title }),
});

export const archiveNote = command(Note, {
  name: 'archive',
  from: 'active',
  to: 'archived',
  // 省略 input 时，已有记录命令默认使用 { id: uuid }。
  handler: (draft) => draft,
});
```

先在 `packages/domain/src/modules/note/index.ts` 写 `export * from './note.js';`，再在 `packages/domain/src/index.ts` 保留组织模型及已有模块，加入新模块：

```ts
export * from '@yss123/cage-admin/domain';
export * from './modules/note/index.js';
```

随后 `pnpm exec cage check`、`pnpm gen`，审查迁移后 `pnpm migrate`。管理员给目标角色配置 `Note.create / Note.update / Note.archive / Note.read` 和 `Note` 数据范围；前端使用生成的 `note.create({ title })`、`note.update(id, { title }, version)`、`note.archive(id, version)`、`note.list()`、`note.get(id)`。

这里的删除选择“归档”这一业务命令，没有硬删表行。读侧列表默认行为以生成契约与实际过滤参数为准，页面要按需求选择是否展示归档记录。系统默认状态并不意味着自动拥有完整 CRUD 命令。

## 字段速查

| 字段工厂 | TypeScript 值/用途 | 注意 |
| --- | --- | --- |
| `text(max?)` | 字符串 | 最大长度；非空、格式等业务输入规则用 Zod 明确表达 |
| `int()`、`number()` | 整数、普通数值 | 金额不要用普通浮点运算代替业务金额规则 |
| `money()` | 十进制字符串 | 输入如 `'1200.00'`，PG numeric 读出仍是字符串 |
| `id()` | UUID 字符串 | 业务引用没有声明关系时的 UUID 字段 |
| `ref('Dept')` | 引用聚合的 UUID | 用字符串名可避免循环导入；目标聚合需从入口导出 |
| `ref('User').unique()` | 租户内至多一对一 | 外键加租户复合唯一索引；不要求目标一定被引用 |
| `hasMany('NoteComment', { mappedBy: 'noteId' })` | 一对多反查 | 只读集合，外键在目标上；不占主表列 |
| `manyToMany('User', { description: '协作成员' })` | 多对多关联 | 命令草稿为 ID 数组；中间表由框架生成，读取独立分页 |
| `date()`、`datetime()` | 日期/时间字符串 | 遵守字段 schema，计算时明确时区 |
| `bool()`、`enumOf(...)` | 布尔、枚举 | 有状态迁移语义时用 `states` 而非普通枚举代替 |
| `list({ sku: text(), qty: int() })` | 对象列表 | 可以表达单据明细；不是自动生成独立子表 |
| `json()` | 结构不固定的 JSON 对象 | 用于结构化扩展；输入规则用命令 Zod 表达，不要把全部领域结构藏进任意 JSON |

字段可链式使用 `.optional()`、`.unique()`、`.sensitive('phone')`、`.hidden()` 等。可用敏感种类以包导出的 `SENSITIVE_KINDS` 为准；hidden 字段不会作为普通公开读字段，sensitive 字段按权限掩码。不要通过前端隐藏来替代它们。

集合关系也放在 `fields` 中，但不是普通 SQL 列，不支持上述四种修饰。完整声明、成员命令、分页接口、权限与迁移见[对象关系指南](relations.md)。纯关联不手写 NoteMember 聚合，具有职位、状态等业务属性的关联仍应建业务聚合。

不要定义 `id/version/status/createdAt/updatedAt/tenantId` 同名业务字段。聚合名和事件名用大驼峰，字段、命令、查询和任务名用小驼峰，状态名用小写下划线。

## 命令的几个关键选项

| 选项 | 当前用法 | AI 常见错误 |
| --- | --- | --- |
| `from` | `'new'` 或已有状态/状态数组 | 直接在 handler 改状态，绕过生命周期 |
| `to` | 声明的状态；已有记录可用 `null` 保留状态 | 新建用 `null`，或误认为 null 不检查状态 |
| `input` | Zod schema；已有记录必须包含 id | 用聚合字段 schema 当成任意命令输入 |
| `name` | 能力和接口中的命令名覆盖 | 混淆导出变量名与最终 `Aggregate.command` |
| `invokedBy` | 默认 user；可声明 process/job/external 或数组 | 为了从前端审批而给内部结论加 user |
| `reads` | `{ 别名: 聚合 }` | 不声明依赖，直接读仓库或连接数据库 |
| `constraints` | 执行前的硬约束 | 在页面上判断一次就认为后端安全 |
| `emits` | 事件或 `emit(事件, 映射)` | 已提交后另写消息，失去事务一致性 |

handler 参数依次是 `draft, input, deps, { now, actorUserId }`。可返回草稿、部分业务字段或 void；`return fail('STOCK_SHORT', detail)` 表示业务拒绝，整个事务回滚。

片段：采购审批读取已声明的库存依赖。

```ts
reads: { stock: Inventory },
handler: async (order, _input, { stock }) => {
  for (const item of order.items) {
    const row = await stock.findOne({ sku: item.sku });
    if (!row || row.available < item.qty) return fail('STOCK_SHORT', [item.sku]);
  }
  return order;
},
```

使用 `deps.stock.get/findOne/find` 读取声明的依赖；不要将其扩展为写仓库。这个片段只是单次库存检查，不保证多订单并发扣减安全；生产扣减需要专门设计库存命令和并发控制。

## 约束与不变量

```ts
// 片段：放在采购 approve 的配置中。
invokedBy: 'process',
constraints: [sod.notSameAs('createdBy'), ceiling('amount')],
```

`sod` 防止提单人审批自己；`ceiling` 读取审批人该能力上的额度参数，没有额度也拒绝。管理员在 `/admin` 给角色配置 `PurchaseOrder.approve` 的 `ceiling`，不是把额度写死进页面。

不变量写在 `aggregate(..., { invariants: { 名称: 对象 => boolean } })`，在最终结果合并和目标状态确定后检查。例如 `Number(o.amount) > 0`。约束回答“这次操作允许吗”，不变量回答“结果对象合法吗”。可用 `Constraint` 类型定义自定义约束对象；先核对公开导出，不假设所有内部 helper 都是公共 API。

## 事件与资源反应

片段来自采购范例，完整版本见 `modules/purchase/purchase-order.ts`、`workflows/purchase-inventory.ts`（相对 domain src）。

```ts
// 事件中只放下游真正需要的信息；不要拷贝整个对象。
export const OrderCancelled = event('OrderCancelled', {
  orderId: id(),
  previousStatus: text(),
});

// 命令中通过 emit 显式提供旧状态，用它判断此前是否持有资源。
emits: [emit(OrderCancelled, (order, _input, previous) => ({
  orderId: order.id,
  previousStatus: previous.status,
}))],
```

```ts
export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock,
  tx: 'same',
  acquires: 'inventory.lock',
  map: (e) => ({ id: e.orderId, orderId: e.orderId, items: e.items }),
});

export const releaseOnCancel = reaction(OrderCancelled, {
  command: releaseLock,
  releases: 'inventory.lock',
  // 草稿取消时从未建锁，不应对不存在的锁调用释放命令。
  map: (e) => e.previousStatus === 'approved' ? { id: e.orderId } : null,
});
```

`map` 是纯映射，可返回 null 表示此次不执行；不能在映射中调用 HTTP。每条离开持有状态的迁移都应释放资源，或进入同样持有资源的状态。新增“撤回”时别只复制状态迁移，还要检查释放路径。

事件默认载荷映射的具体命名规则见真实 `event.ts` 与范例；映射不明确时使用 `emit` 显式声明。已部署事件只做兼容扩展，新增字段设 optional；不兼容含义用新事件并考虑旧 outbox 消费，不能只改消费者。

### 有界集合与步骤顺序

同一事件需要对 20 台设备调用相同命令时，用 `reactionEach` 声明一次。下面为局部片段，`EquipmentAllocated` 事件含 `assets: [{ assetId }]`，`acquireAsset` 为已导出的目标命令：

```ts
import { reactionEach } from '@yss123/cage-kernel';

export const acquireAllocatedAssets = reactionEach(EquipmentAllocated, {
  command: acquireAsset,
  items: event => event.assets,
  maxItems: 20,
  orderBy: 'assetId',
  order: 20,
  tx: 'same',
  acquires: 'asset.use',
  map: (item, _event, _index) => ({ id: item.assetId }),
});
```

`maxItems` 是执行上限，输入 schema 也应表达业务上限。`orderBy` 必须是各项真实存在、非空、同类型且唯一的字符串或有限数值键；按键升序串行执行，以稳定资源锁顺序。`map` 收到排序后的索引，可返回 null 跳过；映射和选择器都是纯函数。

失败诊断中的 `itemIndex` 是跳过 null 后的实际执行输入索引；`sortedIndex` 是排序后原项位置，`originalIndex` 是事件数组原位置，`itemKey` 是稳定排序键，均使用零基索引。诊断不附完整项载荷。

多个跨对象步骤用 `order` 表达预算 → 设备 → 占用明细等依赖。同事件同 `tx` 分组一旦使用 order，所有步骤必须提供互不重复的非负整数。普通 `reaction` 也支持 order；不要靠导出变量的编号表达流程顺序。

`tx: 'same'` 的集合仍走每一条目标命令的授权、约束、审计与版本流水线，任一失败使主命令及整个同事务链回滚。默认 outbox 集合由 worker 串行调用并随该消费者事务提交；重试与死信仍按事件处理。图谱和 context 展示目标、上限、排序键、顺序和事务。框架不替业务决定整单或分批：配发整单可用一个命令及其同事务集合，分批归还则每次提交的一批共同回滚。

## 两种查询写法

下面两段均为完整声明，可选择需要的写法。它们都走只读连接与安全视图；调用人需要 `PurchaseOrder.read`，并受其范围与掩码限制。

```ts
import { query } from '@yss123/cage-kernel';
import { z } from 'zod';
import { PurchaseOrder } from './purchase-order.js';

export const poByStatus = query('poByStatus', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  sql: `select dept_id, count(*)::int as n
        from safe.purchase_order where status = :status group by dept_id`,
});
```

```ts
import { query } from '@yss123/cage-kernel';
import { z } from 'zod';
import { PurchaseOrder } from './purchase-order.js';

export const recentOrders = query('recentOrders', {
  reads: [PurchaseOrder],
  input: z.object({ status: z.string() }),
  build: (db, input) => db.selectFrom('safe.purchase_order')
    .select(['id', 'amount', 'status'])
    .where('status', '=', input.status)
    .orderBy('created_at', 'desc')
    .limit(20),
});
```

`sql` 与 `build` 必须二选一。SQL 用数据库的 snake_case 列名和 `:参数名`；不要拼接输入，也不要查询 `core.*`/`sys.*` 基表。`reads` 列出所有涉及的聚合，不能漏掉 join 的对象。业务前端调用生成的 `queries.*`，不复制查询 SQL。

有目的级审计要求时，在 query 中声明 `audit: { purpose: '月度结算核对' }`。目的应为固定说明，不包含敏感输入。查询会先可靠写入用途审计再交付结果；潜在敏感明文还按 `reads` 保守审计，不假定任意 SQL 投影能精确推导字段和对象。审计故障返回 `CAGE-AUDIT-001`，不交付查询数据。完整保证见[审计矩阵](architecture.md#审计保证)。

通用列表参数要求正安全整数 page/pageSize；数值筛选必须有限并满足字段 schema，布尔只接受 true/false，日期必须合法，排序字段必须来自公开字段。非法值返回字段级 `INVALID_INPUT`，不会把任意非 true 字符串转成 false。当前仍采用 offset 分页及精确计数，大规模分页成本需按实际数据测量。

## 审批绑定与选人

下面是完整的采购路由文件形状，使用同目录现有的采购符号：

```ts
import { approval } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import { PurchaseOrder, OrderSubmitted, OrderCancelled, approve, reject } from './purchase-order.js';

export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval',
  start: OrderSubmitted,
  cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'],
  onApproved: approve,
  onRejected: reject,
});

export const poRoute = route('po-approval', [
  step('部门经理审批', approver.deptLeader('deptId')),
  when(gt('amount', 50000), step('财务审批', approver.role('finance'), { mode: 'any' })),
]);
```

`approval` 绑定事件与结论命令；`route` 决定步骤与人；`routable` 限制交给路由的数据字段。`onApproved/onRejected` 必须属于同一聚合，且允许 process 调用。

内置选人器是 `approver.deptLeader(字段名)`、`approver.role(角色code)`、`approver.user(用户id)`。条件使用 `gt/gte/lt/lte/eq/ne/isIn` 等封闭表达式。`mode: 'any'/'all'` 描述一步内的人如何完成，不表示任意并行分支。可以在代码组合这些能力；任意函数选人、转签和加签需框架扩展或外部审批适配器，当前不能直接写成现成 API。

被选中的审批人还要具备结论命令所需能力、范围和额度。部门负责人为空会产生 `CAGE-APPR-007`，详见[排错](troubleshooting.md)。

## 连接器、定时任务和逃生口

| 能力 | 声明结构 | 标准范例 |
| --- | --- | --- |
| 连接器 | `connector(name, { hosts, secret: 密钥名, operations: { 操作: op(...) } })` | `integrations/erp.ts` |
| 出站 | `outbound(事件, 操作, { map, idempotencyKey, onSuccess })` | ERP 推单，成功用 external 命令回写 |
| 入站 | `inbound(连接器, 事件名, { verify, payload, command, map })` | HMAC 验签的收货回调 |
| 定时任务 | `job(name, { cron, reads, calls, run })` | `jobs.ts` 过期草稿取消 |
| 逃生口 | `unsafe({ reason, owner }, () => ...)` | 仅用于声明无法表达且评审过的特殊情况 |

连接器 host 写主机名而非完整 URL，操作 path 从 `/` 开始，request/response 均用 schema 白名单，密钥只写环境变量名。`effect: 'retryableWrite'` 仍需要第三方幂等协议，不是承诺远端恰好一次。

job 的 `run({ query, call, now })` 只能读 `reads` 和调用 `calls` 中的命令。用户命令可以被显式声明了它的系统任务调用；仅允许内部身份的命令还需包含 job 身份。最终仍走写流水线。不要通过新增脚本直接扫表改业务状态。

`unsafe` 只记录原因和负责人并进入预算，不自动授予数据库、网络或用户权限，也不让 lint 边界失效。能用声明表达的普通业务不应使用它。
