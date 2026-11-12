# 事件联动、资源、定时与第三方

当一个动作成功后还要改变其他对象、启动后台工作或通知外部系统，用事件表达事实，再明确后续执行者。先决定哪些结果必须一起成功，哪些可以稍后完成。

## 让事件表达实际发生的事

命令的 emits 记录成功事实。事件字段只带下游需要的内容；多个对象 ID 或旧状态最好显式映射。例如采购取消事件保留 previousStatus，让释放反应知道此前是否持有资源。

映射在命令事务内执行和校验；失败使主命令回滚。事件已部署后要兼容旧 outbox：新增字段可选，改变不兼容含义使用新事件，并安排旧消费者处理。

## 调用另一个对象的命令

先做一个小例子：“便笺归档与归档记录必须一起成功”。以[便笺课程](../getting-started/first-feature.md)为基础，将[归档记录完整文件](../examples/note/archive-log.ts)放到 modules/note/archive-log.ts 并导出。文件定义 NoteArchived、NoteArchiveLog 和 recordNoteArchive。

在 note.ts 导入 kernel 的 emit 及同模块的 NoteArchived，为原有 archiveNote 增加 emits：

<!-- cage:example note-archive-emits -->
```ts
emits: [emit(NoteArchived, record => ({
  noteId: record.id,
  title: record.title,
  deptId: record.deptId,
}))],
```

映射取归档后的字段快照。归档记录文件中的反应调用真实命令完成第二个对象的写入：

<!-- cage:example log-note-archive -->
```ts
export const logNoteArchive = reaction(NoteArchived, {
  command: recordNoteArchive,
  tx: 'same',
  map: (event) => ({ noteId: event.noteId, title: event.title, deptId: event.deptId }),
});
```

成功时便笺为 archived，安全读取归档记录可找到相同 noteId；目标命令失败时两边都不提交。若业务允许稍后记录，可按需求改为 outbox，并通过 worker 终态验收。完整文件里的 recordNoteArchive 只接受 process 调用，不向浏览器生成写方法。

采购批准与库存锁必须共同成功，因此反应使用 same：

```ts
export const lockOnApprove = reaction(OrderApproved, {
  command: acquireLock,
  tx: 'same',
  acquires: 'inventory.lock',
  map: event => ({ id: event.orderId, orderId: event.orderId, items: event.items }),
});
```

这是[采购范例](../examples/purchase-example.md)的组合片段，OrderApproved 和 acquireLock 来自各自领域模块。目标命令真实创建锁；acquires 只提供图规则证据。

取消后的释放可异步执行，map 根据旧状态返回释放输入或 null。每条离开持有状态的路径都要检查释放或交接，页面还要能表达异步处理中或失败。不能靠标签自动产生库存变动。

多项同类调用用 reactionEach，提供 items、maxItems、唯一 orderBy 和 map；稳定排序后串行执行。多步骤有依赖时为同事件同 tx 全组提供不同 order。单个读取库存检查不保证多个订单并发扣减正确，库存数量竞争应由目标命令和并发设计落实。

## 定时任务仍然走命令

job 声明 cron、reads、calls 和 run。run 获得 query、call、now，只读取显式依赖并调用已声明命令，例如找出过期草稿再逐条取消。任务成功、失败与重复执行都要能从命令和运行记录观察。

假设本例的规则是“创建超过三十天且仍在使用中的便笺，每天最多归档 200 条”。将[任务完整文件](../examples/note/jobs.ts)放到同一领域模块并导出；archiveNote 的调用用途可明确写成 invokedBy: ['user', 'job']：

<!-- cage:example archive-old-notes -->
```ts
export const archiveOldNotes = job('archiveOldNotes', {
  description: '归档创建超过三十天的使用中便笺',
  cron: '0 2 * * *',
  reads: [Note],
  calls: [archiveNote],
  run: async ({ query, call, now }) => {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const records = await query.list(Note, { status: 'active', createdBefore: cutoff }, { limit: 200 });
    for (const record of records) await call(archiveNote, { id: record.id });
  },
});
```

这里判断创建时间，不是最后编辑时间；时区沿调度环境解释。每次 call 独立提交，后续失败不会撤回之前的归档；候选在调用前已被其他人归档时，命令状态检查仍会拒绝。本例的批量上限不表示一次处理全量。

所有声明从 domain 导出，API/worker 使用相同版本。默认 outbox、调度和连接器由 worker 执行；具体事务与停机边界见[执行参考](../reference/execution.md)。

## 与第三方系统交换

connector 定义允许的主机、密钥名称和操作；op 为每项操作声明 HTTP 方法、路径、request/response schema 及副作用等级。主机可以带端口，不能带协议和路径，操作 path 从 / 开始。

| 等级 | 业务前提 |
| --- | --- |
| read | 只读外部请求，不能作为 outbound 写映射 |
| retryableWrite | 对方按稳定幂等键去重，允许相同请求重投 |
| write | 无法安全重试；结果未知时隔离，等待核对 |

例如协议操作分别声明读、可去重写入和不可自动重试写入。op、connector 等来自 cage-connectors，z 来自 zod：

<!-- cage:check domain automation-operation-effects -->
```ts
export const readStatus = op({
  effect: 'read', method: 'GET', path: '/api/status',
  request: z.object({ externalId: z.uuid() }), response: z.object({ status: z.string() }),
});
export const retryableSave = op({
  effect: 'retryableWrite', method: 'POST', path: '/api/notes',
  request: z.object({ externalId: z.uuid() }), response: z.object({ receiptId: z.string() }),
});
export const nonRetryableSave = op({
  effect: 'write', method: 'POST', path: '/api/legacy-notes',
  request: z.object({ externalId: z.uuid() }), response: z.object({ receiptId: z.string() }),
});
```

read 不能作为 outbound 写映射；retryableSave 只有对方按稳定键去重时才成立；nonRetryableSave 超时后的结果需要先核对。

出站用 outbound(event, operation, { map, idempotencyKey, onSuccess })。map 为纯函数，可返回 null；幂等键跨重投稳定，运行时带租户前缀。成功回写调用 external 命令，保留状态的迟到回执可用 to: null，但仍声明允许的 from。

延续归档例子，将[连接器完整文件](../examples/note/archive-service.ts)放到 integrations/archive-service.ts 并从 domain 导出。它导入上面的 NoteArchived，并声明：

<!-- cage:example archive-service -->
```ts
export const archiveService = connector('archive-service', {
  hosts: { test: 'archive-sandbox.example.com', prod: 'archive.example.com' },
  secret: 'ARCHIVE_API_TOKEN',
  timeoutMs: 5000,
  operations: {
    save: op({
      effect: 'retryableWrite',
      method: 'POST',
      path: '/api/notes',
      request: z.object({ externalId: z.uuid(), title: z.string() }),
      response: z.object({ receiptId: z.string() }),
    }),
  },
});
```

主机是协议占位地址，需换成自己的实际服务；ARCHIVE_API_TOKEN 是密钥名称。只有对方确认相同幂等键会去重时，才使用 retryableWrite。事件到外部请求的接线为：

<!-- cage:example send-note-archive -->
```ts
export const sendNoteArchive = outbound(NoteArchived, archiveService.operations.save, {
  idempotencyKey: (event) => `note-archive-${event.noteId}`,
  map: (event) => ({ externalId: event.noteId, title: event.title }),
});
```

这里只发送 UUID 和标题，连接器保存实际回执；未声明 onSuccess，所以不另改业务字段。需要回填业务编号时，沿下面的采购范例使用 external 命令。

例如想把外部 receiptId 作为业务记录保存，可以新建回执聚合，并由 external 命令接收已验证响应；这个扩展复用上面的 archiveService：

<!-- cage:check domain automation-success-command -->
```ts
export const ArchiveReceipt = aggregate('ArchiveReceipt', {
  description: '外部归档回执',
  fields: {
    noteId: ref('Note').describe('所属便笺'),
    receiptId: text(120).describe('外部回执编号'),
    deptId: ref('Dept').describe('所属部门'),
  },
  states: states('active', { terminal: ['active'], labels: { active: '已记录' } }),
  scope: scope.deptSubtree('deptId'),
});
export const recordReceipt = command(ArchiveReceipt, {
  name: 'record', description: '保存外部归档回执', from: 'new', to: 'active', invokedBy: 'external',
  input: z.object({ noteId: z.uuid(), receiptId: z.string().max(120), deptId: z.uuid() }),
  handler: draft => draft,
});
export const sendAndRecordReceipt = outbound(NoteArchived, archiveService.operations.save, {
  idempotencyKey: event => `note-archive-${event.noteId}`,
  map: event => ({ externalId: event.noteId, title: event.title }),
  onSuccess: {
    command: recordReceipt,
    map: (response, event) => ({ noteId: event.noteId, receiptId: response.receiptId, deptId: event.deptId }),
  },
});
```

应以这个出站替换原 sendNoteArchive，不同时注册两套发送。外呼与本地回执写入分阶段，回写失败不能报告业务记录已保存。

入站用 inbound，将原始正文验签、schema 校验后的输入映射到领域命令。hmacSha256 默认检查 x-signature，接受 hex 或 sha256=hex；签名基于原始字节，不能重新序列化 JSON 后计算。

例如外部系统签名请求归档一条便笺，先定义只供 external 的实际命令，再让回调映射到它；归档仍发出本应用的事件：

<!-- cage:check domain automation-inbound -->
```ts
export const archiveFromWebhook = command(Note, {
  name: 'archiveFromWebhook', description: '接收外部归档请求', from: 'active', to: 'archived', invokedBy: 'external',
  emits: [emit(NoteArchived, record => ({ noteId: record.id, title: record.title, deptId: record.deptId }))],
  handler: draft => draft,
});
export const requestedArchive = inbound(archiveService, 'archiveRequested', {
  verify: hmacSha256('ARCHIVE_WEBHOOK_SECRET'),
  payload: z.object({ externalId: z.uuid() }), command: archiveFromWebhook,
  map: payload => ({ id: payload.externalId }),
});
```

签名例子：原正文的字节被签名后，不能先格式化成带空格的另一个字符串再验证；修改一个字节也应失败。密钥只通过部署注入。

完整接法可沿采购 integrations/erp.ts 阅读：批准事件出站 → 保存 ERP 回执 → external 命令回填 → 验签收货回调 → 收货命令及释放事件。字段、状态、权限和幂等规则均由当前业务明确。

## 从本地到真实联调

先用 fakeConnector 验证协议和回写，再配置测试/生产主机与实际密钥。CAGE_STAGE 决定普通连接器阶段；fake 的调用记录只证明本地链路。

例如在 worker 的 fake 分支中注册确定的回执。fakeConnector 属于 cage-connectors 运行入口，这段不放进领域 handler 或声明导入时执行：

<!-- cage:check domain automation-fake -->
```ts
export function registerLocalArchiveFake() {
  fakeConnector(archiveService, {
    save: request => ({ receiptId: `DEMO-${request.externalId}` }),
  });
}
```

真实联调至少核对重复投递、超时后对方是否已成功、响应格式变化、回写失败恢复、取消后的晚到回执及补偿。外呼成功和本地回写分别观察，unknown 不能直接重放。当前没有通用解除未知结果的管理 API。

例如同一业务键连续投递两次，对方应只有一条记录；把网络断在远端提交之后，本地不能把超时当成未提交；恢复应先核对外部记录和连接器回执，再确认最终本地状态。

普通业务 handler 不自行发 HTTP、开数据库池或编写扫表改状态脚本。声明表达不了的特殊情况需具体说明并评审；unsafe 记录原因和负责人，不增加执行权限。

[返回开发手册](../README.md)
