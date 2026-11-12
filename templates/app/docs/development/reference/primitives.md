# 声明原语参考

本页用于查字段、命令、事件和查询的声明规则。完整操作过程见[便笺课程](../getting-started/first-feature.md)。公开入口来自 @yss123/cage-kernel；参数有疑问时用 cage capabilities 查当前安装包的真实签名。

短例逐项说明一种写法，沿用便笺课程的 Note 等已声明符号；涉及原有命令的写法应按需求替换或扩展，不能把所有示例不加审查地并列注册。完整文件仍负责 import、中文注释和逐层导出。

## 聚合与状态

aggregate(name, definition) 定义一个对象。name 使用大驼峰，字段使用小驼峰。fields 放业务字段，states 放生命周期，scope 描述归属，invariants 校验最终快照，description 解释业务含义。

系统维护 id、version、status、createdAt、updatedAt 和数据库租户列，业务不能重复声明。未指定 states 时为 active/deleted，这不会自动生成 CRUD 命令。状态也可声明在 fields.status，两种位置只能选一处。

states 的 terminal 标记供检查和展示使用；哪些操作实际允许仍由命令 from/to 决定。每个状态用 labels 提供业务名称，名称不改变存储值。

例如一个有标题、归属和归档终态的完整对象声明如下。下面的领域短例沿用本页的 kernel 原语与 z；Note 相关例子使用便笺课程已有声明：

<!-- cage:check domain primitive-aggregate -->
```ts
export const Memo = aggregate('Memo', {
  description: '工作备忘',
  fields: { title: text(120).describe('标题'), createdBy: ref('User').describe('创建人') },
  states: states('active', 'archived', {
    terminal: ['archived'], labels: { active: '使用中', archived: '已归档' },
  }),
  scope: scope.self('createdBy'),
  invariants: { notBlank: record => record.title.trim().length > 0 },
});
```

系统列不用再定义。例如创建后响应中的 id/version/status 来自内核，字段声明只需 title；仅写上面的聚合还不会产生 create/update 方法，必须另导出命令。

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000", "title": "季度复盘", "status": "active", "version": 1 }
```

另一种状态声明位置是 fields.status。例如下面选用这个位置，就不再同时填写外层 states：

<!-- cage:check domain primitive-field-status -->
```ts
export const EmbeddedStatusMemo = aggregate('EmbeddedStatusMemo', {
  description: '在字段中声明状态的备忘',
  fields: {
    title: text(120).describe('标题'),
    status: states('active', 'archived', { terminal: ['archived'], labels: { active: '使用中', archived: '已归档' } }),
  },
});
```

## 字段

| 写法 | 值与存储含义 |
| --- | --- |
| text(max)，默认 500 | 有最大长度的字符串 |
| int() / number() | 整数 / 普通数值 |
| money() | 十进制金额字符串，数据库 numeric；金额单位由业务约定 |
| id() / ref('User') | UUID / 指向已导出聚合的 UUID 引用 |
| date() / datetime() | YYYY-MM-DD / 带时区的 ISO 时间字符串 |
| bool() / enumOf(...) | 布尔 / 枚举值 |
| list({ sku: text(), qty: int() }) | JSON 明细数组，非独立子表 |
| list(id()) | UUID 值数组，非持久关系声明 |
| json() | 键值 JSON 对象，业务仍需明确输入规则 |
| hasMany / manyToMany | 集合关系，见[关系指南](../guides/relations.md) |
| file / files | 受控文件 ID，见[文件指南](../guides/files.md) |

### 文本与数值

text 限定字符串长度；int 只接受整数，number 表示普通数值。下面每行对应一种字段，右侧注释给出业务值：

<!-- cage:check domain primitive-text-number -->
```ts
export const titleField = text(120).describe('标题');       // '季度复盘'
export const quantityField = int().describe('数量，单位件'); // 3
export const ratioField = number().describe('分摊比例');    // 0.25
```

money 的传输值是十进制字符串，单位需要业务说明；128.50 元写成 '128.50'，精度与正数规则仍由命令决定。

<!-- cage:check domain primitive-money -->
```ts
export const amountField = money().describe('报销金额，单位人民币元');
export const amountInput = z.object({ amount: z.string().regex(/^\d+\.\d{2}$/) });
const parsed = amountInput.parse({ amount: '128.50' });
```

### 标识与引用

id 只说明值是 UUID；ref 还说明目标聚合。目标必须被 domain 导出，不能把普通字符串名称当外键值。

<!-- cage:check domain primitive-id-ref -->
```ts
export const externalIdField = id().describe('外部记录 UUID');
export const applicantField = ref('User').describe('申请人 UUID');
```

### 日期与时间

date 表示日历日期，datetime 表示带时区的时刻。例如到期日没有小时，提交时间使用 UTC：

<!-- cage:check domain primitive-dates -->
```ts
export const dueDateField = date().describe('到期日');       // '2026-11-11'
export const submittedField = datetime().describe('提交时间'); // '2026-11-11T08:00:00Z'
```

### 布尔与枚举

bool 表示真假，enumOf 限定允许的机器值。中文名称不应直接替换已部署的枚举标识：

<!-- cage:check domain primitive-bool-enum -->
```ts
export const urgentField = bool().describe('是否加急'); // true
export const priorityField = enumOf('normal', 'urgent').describe('优先级'); // 'urgent'
```

### 明细、值数组与 JSON

list 的对象形状保存聚合内部快照，不建立明细聚合；list(id()) 保存值数组。json 接收键值对象，业务输入仍应定义明确结构：

<!-- cage:check domain primitive-containers -->
```ts
export const lineField = list({ sku: text(40), qty: int() }).describe('明细'); // [{ sku: 'A4', qty: 2 }]
export const selectedIdsField = list(id()).describe('选择的 UUID');          // UUID 字符串数组
export const extraField = json().describe('附加元数据');                    // { source: 'manual' }
```

### 关联与附件

hasMany 通过子对象外键反查，manyToMany 由来源对象维护成员集合；file/files 保存受控文件 ID。这些写法都直接放在 fields，不能嵌入上面的 JSON 明细：

<!-- cage:check domain primitive-relations-files -->
```ts
export const commentsField = hasMany('NoteComment', { mappedBy: 'noteId' }).describe('评论');
export const membersField = manyToMany('User').describe('协作成员');
export const coverField = file({ maxBytes: 1024 * 1024, accept: ['image/png'] }).optional().describe('封面');
export const pdfsField = files({ maxBytes: 20 * 1024 * 1024, maxCount: 3, accept: ['application/pdf'] }).describe('附件');
```

普通字段默认必填。.optional() 允许缺省和 null，公开值的缺省通常归一为 null；业务输入是否可以省略仍由命令 schema 决定。.unique() 生成租户内唯一约束，ref().unique() 表达至多一对一。.describe() 提供业务名称。

例如日期可缺省，业务编码租户内唯一，责任人至多被一条来源记录引用。字段可空与命令输入可省略分别写：

<!-- cage:check domain primitive-modifiers -->
```ts
export const optionalDate = date().optional().describe('未确定时为空的日期');
export const uniqueCode = text(40).unique().describe('租户内唯一编码');
export const oneOwner = ref('User').unique().describe('独占责任人');
export const inputWithOptionalDate = z.object({ dueOn: z.string().nullable().optional() });
```

.sensitive('phone') 等按类型掩码；当前种类为 phone、idCard、bankCard、email、name、address，以 SENSITIVE_KINDS 导出为准。.hidden() 从普通公开读取排除。前端隐藏控件不产生这些服务端效果。

例如有普通读取能力却无电话明文能力时，phone 仍经服务端掩码；internalMemo 不进入普通公开 DTO：

<!-- cage:check domain primitive-masking -->
```ts
export const phoneField = text(32).sensitive('phone').describe('联系电话');
export const memoField = text(500).hidden().describe('内部备注');
```

集合关系不使用 optional/unique/hidden/sensitive；文件也有自己的修饰限制。关系、文件不能嵌入 list，事件传递关联或文件时使用普通 ID 值。

下面是可放入 aggregate.fields 的费用字段组合。完整 import 一并给出；金额约定人民币元、数量单位为件，输入命令仍要校验正数和非空明细：

<!-- cage:example expense-fields -->
```ts
import { date, int, list, money, ref, text } from '@yss123/cage-kernel';

/** 费用聚合的字段组合；可空日期表示尚未发生，明细是对象内部快照。 */
export const expenseFields = {
  title: text(120).describe('费用标题'),
  amount: money().describe('含税金额，单位为人民币元'),
  incurredOn: date().optional().describe('发生日期，尚未发生时为空'),
  deptId: ref('Dept').describe('承担部门'),
  createdBy: ref('User').describe('创建人'),
  items: list({ sku: text(40), qty: int() }).describe('费用明细，数量单位为件'),
};
```

对应普通业务值例如 amount: '128.50'、incurredOn: null、items: [{ sku: 'PAPER-A4', qty: 2 }]。money 的传输值是十进制字符串，不能据此省略业务计算和精度规则。

## 命令

command(aggregate, options) 保存一次写入的规格，由 domain 导出后注册能力。显式 name 优先，否则使用顶层导出名；最终为 Aggregate.commandName。

| 选项 | 含义与默认行为 | 对应写法 |
| --- | --- | --- |
| from | new 表示创建；已有记录限定状态 | from: 'new'；from: ['active', 'archived'] |
| to | 目标状态；已有记录可保持 | to: 'active'；to: null |
| input | Zod 输入；省略时新建为空、已有记录仅 id | input: z.object({ id: z.uuid(), title: z.string() }) |
| reads | 别名到聚合的只读依赖 | reads: { notes: Note } |
| constraints | handler 前的硬约束 | constraints: [sod.notSameAs('createdBy')] |
| emits | 成功事务中保存事件 | emits: [emit(NoteArchived, record => ({ noteId: record.id, title: record.title, deptId: record.deptId }))] |
| invokedBy | 默认 user；其他为内部入口 | invokedBy: ['user', 'job'] |
| public | 默认 false；显式匿名与跳过能力检查，其他守卫保留 | public: true，不能据此绕过 Note 的范围 |
| description | 用途，进入能力目录和图谱 | description: '修改便笺标题' |
| handler | 计算字段变化，不自行持久化 | handler: (_draft, input) => ({ title: input.title }) |

### 修改字段并保持状态

下面是一个完整命令：只在 active 时接受修改，name 决定 Note.rename，to: null 保留状态。

<!-- cage:check domain primitive-command -->
```ts
export const rename = command(Note, {
  name: 'rename', description: '修改便笺标题', from: 'active', to: null,
  input: z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (_draft, input) => ({ title: input.title }),
});
```

public 是显式公开意图。例如下面这组选项只有业务已经决定允许匿名时才放入命令；它仍不关闭 from、版本、范围或不变量检查：

<!-- cage:check domain primitive-public-options -->
```ts
export const explicitlyPublic = { public: true, invokedBy: ['user'] as const };
```

已有记录的显式 input 必须包含 id。expectedVersion 是传输元数据，由内核在 schema 校验前剥离；缺省不做显式版本比较。前端方法形状见[客户端](client.md)。

例如通过已有生成契约修改时，第三个参数携带之前读取的版本，不往业务 input 重复定义 version：

<!-- cage:check web primitive-command-version -->
```ts
export const saveTitle = (record: Note, title: string) =>
  note.update(record.id, { title }, record.version);
```

handler(draft, input, deps, { now, actorUserId }) 可以修改草稿，或返回字段补丁、草稿、void、fail(业务码, detail)。返回补丁与草稿合并，最终状态、创建人和版本由内核维护；fail 表示 DOMAIN_ERROR 并回滚事务。

例如局部补丁只改标题；业务拒绝使用 fail，不返回假成功对象：

<!-- cage:check domain primitive-handler-results -->
```ts
export const checkedRename = command(Note, {
  name: 'checkedRename', description: '拒绝保留名称的标题修改', from: 'active', to: null,
  input: z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (_draft, input) => input.title === '保留名称'
    ? fail('TITLE_RESERVED', '此标题不可使用')
    : { title: input.title },
});
```

上例 title: '保留名称' 会得到 DOMAIN_ERROR/TITLE_RESERVED，原记录与版本不提交变化。handler 的 actorUserId 是可信操作者，下面只允许创建人修改：

<!-- cage:check domain primitive-handler-context -->
```ts
export const ownedRename = command(Note, {
  name: 'ownedRename', description: '创建人修改标题', from: 'active', to: null,
  input: z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (draft, input, _deps, { actorUserId }) =>
    draft.createdBy === actorUserId ? { title: input.title } : fail('OWNER_ONLY', '仅创建人可改'),
});
```

直接修改业务草稿并返回 void 也是合法写法；id/status/version 是内核维护的只读字段，不能仿照 title 修改：

<!-- cage:check domain primitive-mutate-draft -->
```ts
export const renameDraft = command(Note, {
  name: 'renameDraft', description: '通过草稿修改标题', from: 'active', to: null,
  input: z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (draft, input) => { draft.title = input.title; },
});
```

例如业务已确认“仅 UTC 上午可修改”，使用本次命令固定的 now；不接收客户端传来的“当前时间”：

<!-- cage:check domain primitive-fixed-now -->
```ts
export const renameBeforeNoon = command(Note, {
  name: 'renameBeforeNoon', description: 'UTC 上午修改标题', from: 'active', to: null,
  input: z.object({ id: z.uuid(), title: z.string().trim().min(1).max(120) }),
  handler: (_draft, input, _deps, { now }) => now.getUTCHours() < 12
    ? { title: input.title } : fail('EDIT_WINDOW_CLOSED', '已超过 UTC 上午修改时间'),
});
```

deps 只包含 reads 声明的别名：

| 方法 | 边界 |
| --- | --- |
| get(id) | 范围内对象或 null，无更新行锁 |
| find(where?, options?) | 等值条件；默认最多 1000，最多 5000，非完整集合保证 |
| findOne(where) | 默认顺序第一条或 null，不证明条件唯一 |
| count(where?) | 同租户、同范围内符合等值条件的数量 |

下面每个函数接收 reads 注入的 ReadRepo<typeof Note>，不自行创建数据库连接。get 按 ID 取当前范围内的一条记录或 null：

<!-- cage:check domain primitive-read-get -->
```ts
export const readParent = (notes: ReadRepo<typeof Note>, noteId: string) => notes.get(noteId);
```

find 读取有界候选。例如取最早创建的 20 条 active 便笺，不承诺已遍历所有记录：

<!-- cage:check domain primitive-read-find -->
```ts
export const readCandidates = (notes: ReadRepo<typeof Note>) =>
  notes.find({ status: 'active' }, { limit: 20, orderBy: 'createdAt', desc: false });
```

findOne 只取第一条。同标题仍可能有多条，不能把结果当成数据库唯一性证明：

<!-- cage:check domain primitive-read-first -->
```ts
export const firstNamedNote = (notes: ReadRepo<typeof Note>, title: string) => notes.findOne({ title });
```

count 返回符合等值条件的数量；不要用有上限的数组 length 代替总数：

<!-- cage:check domain primitive-read-count -->
```ts
export const countActive = (notes: ReadRepo<typeof Note>) => notes.count({ status: 'active' });
```

这些内部快照供服务端计算使用，不能作为绕过公开读侧掩码的响应。跨对象读取本身不保证后续并发写安全。

完整 reads、异步 handler、fail 和字段补丁的例子见[评论创建命令](../guides/relations.md#一对多外键属于子对象)，完整源码为[note-comments.ts](../examples/note/note-comments.ts)。其中输入只接收 noteId/body，部门通过 deps.notes.get 查到的父对象取得。

## 约束与不变量

constraints 判断“这次操作是否允许”，例如 sod.notSameAs('createdBy') 或 stepUp。invariants 判断“最终对象是否合法”，在结果合并和目标状态确定后检查。任一失败都回滚命令事务。

自定义 Constraint 使用公开类型与真实签名。输入校验、操作约束和最终不变量分别覆盖不同阶段，页面校验只能提供即时反馈。

例如只允许创建人归档，声明约束所用字段并检查可信 ctx，再把此值加入归档命令的 constraints：

<!-- cage:check domain primitive-custom-constraint -->
```ts
export const ownerOnly: Constraint = {
  name: 'ownerOnly', fields: ['createdBy'],
  check: (record, ctx) => record.createdBy === (ctx.onBehalfOf ?? ctx.userId)
    ? ok() : violation('仅创建人可执行'),
};
```

内置职责分离与二次认证表达不同规则。下面第一个禁止创建人处理自己的记录，第二个要求五分钟内完成二次认证：

<!-- cage:check domain primitive-built-in-constraints -->
```ts
export const separation = sod.notSameAs('createdBy');
export const recentAuthentication = stepUp(300);
```

例如[便笺源码](../examples/note/note.ts)的最终不变量为：

<!-- cage:example note-invariant -->
```ts
invariants: { titleNotBlank: (record) => record.title.trim().length > 0 },
```

它放在 aggregate 选项中，不放在 command.handler 里。职责分离的完整命令例子见[权限参考](authorization.md#把本次操作限制写进命令)。

## 事件与反应

event(name, fields, { description }) 定义大驼峰事实名称和载荷；命令通过 emits 发布。emit(event, (snapshot, input, previous) => payload) 显式生成载荷，previous 在创建时为 null。

例如归档事实只携带下游需要的 ID、标题和部门。声明本身不发消息：

<!-- cage:check domain primitive-event -->
```ts
export const MemoArchived = event('MemoArchived', {
  noteId: id(), title: text(120), deptId: id(),
}, { description: '备忘已归档' });
```

显式映射指出哪个 ID 是业务对象。下面使用便笺课程的 NoteArchived：

<!-- cage:check domain primitive-explicit-emit -->
```ts
export const archiveAndEmit = command(Note, {
  name: 'archiveAndEmit', description: '归档并发布事实', from: 'active', to: 'archived',
  emits: [emit(NoteArchived, record => ({ noteId: record.id, title: record.title, deptId: record.deptId }))],
  handler: draft => draft,
});
```

需要旧状态时使用 previous；例如归档事实同时保留主对象 ID 与旧状态，创建命令中的 previous 则为 null：

<!-- cage:check domain primitive-previous-snapshot -->
```ts
export const NoteStateChanged = event('NoteStateChanged', {
  noteId: id(), previousStatus: text().optional(),
}, { description: '便笺状态已变化' });
export const archiveWithPrevious = command(Note, {
  name: 'archiveWithPrevious', description: '归档并保留旧状态', from: 'active', to: 'archived',
  emits: [emit(NoteStateChanged, (record, _input, previous) => ({
    noteId: record.id, previousStatus: previous?.status ?? null,
  }))],
  handler: draft => draft,
});
```

裸事件的默认映射依次取快照同名字段、缺失的 *Id 字段取主对象 id、其余取输入同名值。具有多个对象 ID 或旧状态含义时，显式 emit 更清楚。载荷校验失败会回滚主命令。

例如 NoteCreated.noteId 不在便笺字段中，默认用主对象 id；title 取同名快照字段：

<!-- cage:check domain primitive-default-emit -->
```ts
export const NoteCreated = event('NoteCreated', { noteId: id(), title: text(120) }, { description: '便笺已创建' });
export const createAndEmit = command(Note, {
  name: 'createAndEmit', description: '创建并发布便笺事实', from: 'new', to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  emits: [NoteCreated], handler: draft => draft,
});
```

reaction(event, { command, map, tx, acquires, releases, order }) 把事实连接到命令。map 是纯映射，返回 null 跳过；tx 默认 outbox，same 共同提交。资源标签只描述配对，实际资源操作由目标命令完成。

例如标题以“内部”开头时不产生外部归档记录，其他归档按事件载荷调用现有记录命令：

<!-- cage:check domain primitive-reaction -->
```ts
export const selectivelyRecord = reaction(NoteArchived, {
  command: recordNoteArchive, tx: 'outbox',
  map: event => event.title.startsWith('内部') ? null : {
    noteId: event.noteId, title: event.title, deptId: event.deptId,
  },
});
```

reactionEach 再声明 items、maxItems、orderBy，按唯一、非空、同类型字符串或有限数值键升序串行调用。原始集合先检查上限，map 可跳过项。诊断的 originalIndex、sortedIndex、itemIndex 各指原位置、排序位置、实际执行位置，均从 0 开始。

例如一次批量事实包含最多 100 条归档项，按唯一 noteId 排序，再逐项调用记录命令：

<!-- cage:check domain primitive-reaction-each -->
```ts
export const NotesArchived = event('NotesArchived', {
  items: list({ noteId: id(), title: text(120), deptId: id() }),
}, { description: '一批便笺已归档' });
export const recordBatch = reactionEach(NotesArchived, {
  command: recordNoteArchive, tx: 'outbox', maxItems: 100, orderBy: 'noteId',
  items: event => event.items,
  map: item => ({ noteId: item.noteId, title: item.title, deptId: item.deptId }),
});
```

输入第 0 项的 noteId 排在另一项之后时，它的 originalIndex 仍为 0，sortedIndex 则改变；被 map 跳过的项没有实际命令调用。重复 noteId 或超过 100 项会拒绝，不静默裁掉。

同事件同 tx 分组一旦使用 order，全部步骤必须声明不同的非负整数。详细事务与失败语义见[执行边界](execution.md)，业务接法见[自动化](../guides/automation.md)。

例如同一批准事实先释放旧资源、再获取新资源，两条 same 反应分别取 order: 0 和 order: 1；第二条失败时两条和主命令一起回滚：

```text
OrderApproved → 释放旧占用（same，order: 0）→ 建立新占用（same，order: 1）
```

## 查询

普通 list/get 使用生成读取接口。复杂读取声明 query，reads 列出全部涉及聚合，input 校验查询参数，sql/build 二选一：

```ts
import { query } from '@yss123/cage-kernel';
import { z } from 'zod';
import { Note } from './note.js';

/** 按状态统计可见便笺，仅使用 Note 的安全视图；返回计数而非全库数量。 */
export const countNotes = query('countNotes', {
  description: '按状态统计便笺',
  reads: [Note],
  input: z.object({ status: z.enum(['active', 'archived']) }),
  sql: 'select count(*)::int as total from safe.note where status = :status',
});
```

sql 使用数据库 snake_case 列名和 :name 参数；build 使用只读 Kysely。两者均受 reads 的 read 能力、范围与掩码约束。联表需列齐依赖，页面调用生成的 queries 方法。

例如更适合类型化构建器的读取可改用 build；sql 与 build 二选一：

<!-- cage:check domain primitive-query-build -->
```ts
export const visibleNoteTitles = query('visibleNoteTitles', {
  description: '读取可见便笺标题',
  reads: [Note], input: z.object({ status: z.enum(['active', 'archived']) }),
  build: (db, input) => db.selectFrom('safe.note').select(['id', 'title'])
    .where('status', '=', input.status).orderBy('created_at', 'desc').limit(20),
});
```

已有 countNotes 生成后，页面调用真实查询契约，失败仍保留 CageResult：

<!-- cage:check web primitive-named-query-call -->
```ts
export const loadActiveCount = () => queries.countNotes({ status: 'active' });
```

可声明 audit: { purpose: '固定业务用途' }，可靠用途审计失败时拒绝交付数据。任意 SQL 的投影不会自动精确推断敏感对象，读审计按 reads 保守处理。

例如“月度归档核对”需要用途审计，purpose 使用固定业务用途，不拼接敏感正文：

<!-- cage:check domain primitive-query-audit -->
```ts
export const auditedCount = query('auditedCount', {
  description: '按月度用途统计归档便笺',
  reads: [Note], input: z.object({}),
  audit: { purpose: '月度归档核对' },
  sql: "select count(*)::int as total from safe.note where status = 'archived'",
});
```

## 其他声明

| 机制 | 公开入口 | 用法与边界 |
| --- | --- | --- |
| 审批绑定 | kernel 的 approval | [审批](../guides/approvals.md)；路由来自 cage-approval |
| 定时任务 | job(name, { cron, reads, calls, run }) | run 只读已声明依赖、调用 calls 命令 |
| 第三方 | cage-connectors 的 connector/op/outbound/inbound | [外部系统](../guides/automation.md#与第三方系统交换) |
| 原生 AI | cage-ai 的 ai；approval 的 step AI 重载 | [原生 AI](../guides/intelligence.md) |
| 业务阅读流程 | businessProcess | 引用真实声明供图谱解释，不调度命令，见[本体建模](../guides/ontology-modeling.md) |
| 特殊实现标记 | unsafe({ reason, owner }, callback) | 记录原因和负责人并进入预算，不授予额外权限，也不关闭 lint |

审批绑定例如将提交事件与领域结论接线；路由步骤来自 cage-approval，绑定原语来自 kernel：

<!-- cage:check domain primitive-approval-binding -->
```ts
export const requestProcess = approval(ReviewRequest, {
  process: 'department-request', start: ReviewRequestSubmitted, routable: ['deptId'],
  onApproved: approveReviewRequest, onRejected: rejectReviewRequest,
});
```

定时任务例如每轮最多找 20 条三十天前的 active 便笺，逐条调用原归档命令，不写裸 SQL 改状态：

<!-- cage:check domain primitive-job -->
```ts
export const archiveAgedNotes = job('archiveAgedNotes', {
  description: '分批归档三十天前的使用中便笺',
  cron: '0 2 * * *', reads: [Note], calls: [archiveNote],
  run: async ({ query, call, now }) => {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    for (const record of await query.list(Note, { status: 'active', createdBefore: cutoff }, { limit: 20 }))
      await call(archiveNote, { id: record.id });
  },
});
```

第三方协议的最小操作例子如下；后续 connector/outbound 的接线见自动化，effect 的含义取决于对方协议：

<!-- cage:check domain primitive-connector-operation -->
```ts
export const saveArchiveOp = op({
  effect: 'retryableWrite', method: 'POST', path: '/api/archive',
  request: z.object({ externalId: z.uuid() }), response: z.object({ receiptId: z.string() }),
});
```

原生 AI 的最小助理声明如下，main 是管理员配置的模型别名；具体消息与确认仍走客户端协议：

<!-- cage:check domain primitive-ai-runtime -->
```ts
export const noteIntelligence = ai({
  models: { main: managedModel('main') }, assistant: { model: 'main', confirmWrites: true },
});
```

业务阅读流程则引用已有命令，不生成运行调度。例如“创建 → 人工归档”的完整 businessProcess 写法就在[本体建模](../guides/ontology-modeling.md#解释完整业务主线)；其中 action: archiveNote 引用真实命令，mode: 'manual' 说明由用户触发。

例如调用已评审的历史解析器时，记录实际原因和责任人。这里接收已有的解析函数，不提供绕过 IO 门禁的新入口：

<!-- cage:check domain primitive-unsafe -->
```ts
export function useReviewedLegacyParser<T>(parse: () => T): T {
  return unsafe({ reason: '兼容已评审的历史报文解析器', owner: '集成维护组' }, parse);
}
```

[返回开发手册](../README.md)
