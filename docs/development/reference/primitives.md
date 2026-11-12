# 声明原语参考

本页用于查字段、命令、事件和查询的声明规则。完整操作过程见[便笺课程](../getting-started/first-feature.md)。公开入口来自 @yss123/cage-kernel；参数有疑问时用 cage capabilities 查当前安装包的真实签名。

## 聚合与状态

aggregate(name, definition) 定义一个对象。name 使用大驼峰，字段使用小驼峰。fields 放业务字段，states 放生命周期，scope 描述归属，invariants 校验最终快照，description 解释业务含义。

系统维护 id、version、status、createdAt、updatedAt 和数据库租户列，业务不能重复声明。未指定 states 时为 active/deleted，这不会自动生成 CRUD 命令。状态也可声明在 fields.status，两种位置只能选一处。

states 的 terminal 标记供检查和展示使用；哪些操作实际允许仍由命令 from/to 决定。每个状态用 labels 提供业务名称，名称不改变存储值。

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

普通字段默认必填。.optional() 允许缺省和 null，公开值的缺省通常归一为 null；业务输入是否可以省略仍由命令 schema 决定。.unique() 生成租户内唯一约束，ref().unique() 表达至多一对一。.describe() 提供业务名称。

.sensitive('phone') 等按类型掩码；当前种类为 phone、idCard、bankCard、email、name、address，以 SENSITIVE_KINDS 导出为准。.hidden() 从普通公开读取排除。前端隐藏控件不产生这些服务端效果。

集合关系不使用 optional/unique/hidden/sensitive；文件也有自己的修饰限制。关系、文件不能嵌入 list，事件传递关联或文件时使用普通 ID 值。

## 命令

command(aggregate, options) 保存一次写入的规格，由 domain 导出后注册能力。显式 name 优先，否则使用顶层导出名；最终为 Aggregate.commandName。

| 选项 | 含义与默认行为 |
| --- | --- |
| from | new 表示创建；已有记录指定一个或多个允许状态 |
| to | 目标状态；已有记录允许 null 保持状态，新建必须有真实目标 |
| input | Zod schema；省略时新建为空对象，已有记录为 UUID id |
| reads | 别名到聚合的只读依赖，默认空 |
| constraints | handler 前的硬约束列表，默认空 |
| emits | 事件或 emit 映射，默认空；成功事务中持久化 |
| invokedBy | 默认 user，可声明 process/job/external 或数组 |
| public | 默认 false；true 允许显式匿名主体并跳过该命令能力检查，其他守卫继续执行 |
| description | 命令意图和边界，供图谱与能力目录使用 |
| handler | 业务计算，不自行提交持久化或执行外部 IO |

已有记录的显式 input 必须包含 id。expectedVersion 是传输元数据，由内核在 schema 校验前剥离；缺省不做显式版本比较。前端方法形状见[客户端](client.md)。

handler(draft, input, deps, { now, actorUserId }) 可以修改草稿，或返回字段补丁、草稿、void、fail(业务码, detail)。返回补丁与草稿合并，最终状态、创建人和版本由内核维护；fail 表示 DOMAIN_ERROR 并回滚事务。

deps 只包含 reads 声明的别名：

| 方法 | 边界 |
| --- | --- |
| get(id) | 范围内对象或 null，无更新行锁 |
| find(where?, options?) | 等值条件；默认最多 1000，最多 5000，非完整集合保证 |
| findOne(where) | 默认顺序第一条或 null，不证明条件唯一 |
| count(where?) | 同租户、同范围内符合等值条件的数量 |

这些内部快照供服务端计算使用，不能作为绕过公开读侧掩码的响应。跨对象读取本身不保证后续并发写安全。

## 约束与不变量

constraints 判断“这次操作是否允许”，例如 sod.notSameAs('createdBy') 或 stepUp。invariants 判断“最终对象是否合法”，在结果合并和目标状态确定后检查。任一失败都回滚命令事务。

自定义 Constraint 使用公开类型与真实签名。输入校验、操作约束和最终不变量分别覆盖不同阶段，页面校验只能提供即时反馈。

## 事件与反应

event(name, fields, { description }) 定义大驼峰事实名称和载荷；命令通过 emits 发布。emit(event, (snapshot, input, previous) => payload) 显式生成载荷，previous 在创建时为 null。

裸事件的默认映射依次取快照同名字段、缺失的 *Id 字段取主对象 id、其余取输入同名值。具有多个对象 ID 或旧状态含义时，显式 emit 更清楚。载荷校验失败会回滚主命令。

reaction(event, { command, map, tx, acquires, releases, order }) 把事实连接到命令。map 是纯映射，返回 null 跳过；tx 默认 outbox，same 共同提交。资源标签只描述配对，实际资源操作由目标命令完成。

reactionEach 再声明 items、maxItems、orderBy，按唯一、非空、同类型字符串或有限数值键升序串行调用。原始集合先检查上限，map 可跳过项。诊断的 originalIndex、sortedIndex、itemIndex 各指原位置、排序位置、实际执行位置，均从 0 开始。

同事件同 tx 分组一旦使用 order，全部步骤必须声明不同的非负整数。详细事务与失败语义见[执行边界](execution.md)，业务接法见[自动化](../guides/automation.md)。

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

可声明 audit: { purpose: '固定业务用途' }，可靠用途审计失败时拒绝交付数据。任意 SQL 的投影不会自动精确推断敏感对象，读审计按 reads 保守处理。

## 其他声明

| 机制 | 公开入口 | 用法与边界 |
| --- | --- | --- |
| 审批绑定 | kernel 的 approval | [审批](../guides/approvals.md)；路由来自 cage-approval |
| 定时任务 | job(name, { cron, reads, calls, run }) | run 只读已声明依赖、调用 calls 命令 |
| 第三方 | cage-connectors 的 connector/op/outbound/inbound | [外部系统](../guides/automation.md#与第三方系统交换) |
| 原生 AI | cage-ai 的 ai；approval 的 step AI 重载 | [原生 AI](../guides/intelligence.md) |
| 业务阅读流程 | businessProcess | 引用真实声明供图谱解释，不调度命令，见[本体建模](../guides/ontology-modeling.md) |
| 特殊实现标记 | unsafe({ reason, owner }, callback) | 记录原因和负责人并进入预算，不授予额外权限，也不关闭 lint |

[返回开发手册](../README.md)
