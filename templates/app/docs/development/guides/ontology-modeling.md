# 让声明准确表达业务

Cage 的本体由已注册声明抽取。字段、状态、对象关系与触发链同时服务于运行和理解；图谱帮助检查它们的含义，不能代替领域实现。

## 从业务事实确定边界

先说明对象是什么、是否有独立身份和生命周期，再说明关联对象及关系方向、基数、可空与修改责任。页面、表格和自然语言都能提供需求线索，但“所属部门”可能是引用，也可能只是历史名称，需要结合规则判断。

状态要表达业务事实，命令说明从什么条件进入什么结果。不变量决定最终对象必须满足什么；授权决定谁能对哪些记录操作。规则选择见[业务设计](recipes.md)。

例如评论属于便笺：noteId 应在评论上声明 ref('Note')，便笺 hasMany 反查。评论部门是否跟随便笺、归档后能否评论，要由评论命令读取和检查；外键本身不继承这些规则。

对应字段写法如下；这说明引用方向，并没有替业务实现“部门自动随父对象变化”：

<!-- cage:check domain modeling-reference-direction -->
```ts
export const commentReference = ref('Note').describe('所属便笺'); // NoteComment.fields.noteId
export const commentCollection = hasMany('NoteComment', { mappedBy: 'noteId' }).describe('便笺评论');
```

## 名称写在哪里

| 内容 | 框架识别的位置 |
| --- | --- |
| 聚合、命令、查询、任务 | options.description |
| 字段与引用 | .describe('业务含义') |
| 集合关系 | .describe 或工厂 options.description |
| 每个状态 | states 的 labels |
| 事件 | event 第三个参数的 description |
| 业务阅读流程和阶段 | title、description，阶段可有 actor |
| 显示覆盖或无描述选项节点 | cage.config.json 的 graph.labels，使用完整 key |

机器标识用于表、接口、能力和引用；业务名称用于理解。翻译文案不需要重命名既有标识。普通 JSDoc 和前端 statusLabel 不会自动成为图谱名称。

例如：

```ts
states('active', 'archived', {
  terminal: ['archived'],
  labels: { active: '使用中', archived: '已归档' },
});
```

graph.labels 可用 state:Note.archived、field:Note.deptId、command:Note.archive 等完整 key 覆盖显示。它优先于声明名称，但不改变真实关系、权限或页面文案。

## 区分几种连线

| 关系 | 能证明什么 |
| --- | --- |
| ref / hasMany / manyToMany | 对象引用或集合关系 |
| reads | 读取依赖 |
| from/to | 一次命令允许的状态迁移 |
| emits → reaction → command | 有声明依据的后续调用，map 还可能返回 null |
| approval start/cancelOn/结论 | 领域事实与流程的接线 |
| invokedBy | 允许的调用身份 |
| 文本或名称匹配 | 候选线索，需要阅读源码确认 |

从一个状态能进入下一个状态，不代表系统会自动推进；读了库存，也不代表会扣库存。重要联动需要找到真实执行链和事务选择，再用业务结果验证。

例如下面两种关系只能支持不同结论，不能互换：

```text
approve --reads--> Inventory：批准时可读取库存，不证明会扣减
approve --emits--> OrderApproved --reaction--> acquireLock：声明了后续命令，仍检查 map 与事务
```

## 解释完整业务主线

跨多个对象的流程可以用 businessProcess，把阶段 action 指向真实命令、事件、审批、反应、任务或连接器。subject 引用主聚合，stages 定义阶段，transitions 说明人工、自动或等待。

manual 指向用户可调用动作；automatic 需要真实触发路径；wait 表示等待外部或定时事实。related 引用真实对象和 via 声明，只解释关联，不参与调度。阅读流程本身不调用命令、不选审批人，也不授予权限。

单对象的简单生命周期通常无需额外包装。完整写法可读采购 workflows/purchase-process.ts，位置说明见[采购导读](../examples/purchase-example.md)。

下面用便笺展示最小构造形状；只有确需独立流程阅读板块时才添加。将[完整文件](../examples/note/note-process.ts)放到 workflows/note-process.ts 并导出，其中 Note/createNote/archiveNote 来自领域模块公开入口：

<!-- cage:example note-lifecycle -->
```ts
export const noteLifecycle = businessProcess('note-lifecycle', {
  title: '便笺生命周期',
  description: '说明便笺创建与人工归档的阅读主线',
  area: { id: 'collaboration', title: '部门协作', description: '部门内资料协作与保留' },
  subject: Note,
  entry: 'create',
  stages: {
    create: { title: '创建便笺', description: '保存标题和归属', actor: '有创建能力的用户', action: createNote },
    archive: { title: '归档保留', description: '保留历史并关闭编辑', kind: 'end', action: archiveNote },
  },
  transitions: [{ from: 'create', to: 'archive', mode: 'manual', label: '有权用户决定归档' }],
});
```

这里 manual 说明用户触发，end 说明阅读主线结束；真正归档仍调用 archiveNote。把 mode 改成 automatic 不会替应用生成调度或事件反应。

## 先检查结构，再检查业务

```powershell
pnpm exec cage check
pnpm gen
```

需要浏览声明模型时可运行 cage graph，需要梳理关联入口时可运行 cage context；两者按问题选用，局部实现可直接阅读源码。

CAGE-ONTOLOGY-001 检查当前项目可定位的聚合、字段、状态、命令、事件、查询和任务是否有非空名称。依赖包无本地位置的节点不在同一覆盖范围内；字段和状态可能定位到所属聚合。

默认缺名为警告，新模板使用 graph.naming: 'required' 作为门禁。已有项目补齐后合并该选项，保留既有 title/labels。它验证名称存在，不验证用词准确或任意业务关系正确。

按已明确规则核对对象、方向、基数、状态、调用和权限，再运行成功及关键反例。检索命中和图中有箭头，只能作为继续查证的起点。

[本体工具](../tools/ontology-context.md) · [返回开发手册](../README.md)
