# 把业务含义写进本体声明

[返回学习入口](../README.md) · [业务澄清](business-collaboration.md) · [能力选择](recipes.md) · [本体查询](../tools/ontology-context.md)

Cage 的本体来自实际注册的领域声明。对象是什么、状态表示什么、对象之间如何关联、操作后影响谁，都应落实到这些声明及其实现中。图谱用来检查和解释它们；不另建一份与运行代码分离的本体配置来代替领域设计。

用户可以通过自然语言、业务文档、已有系统、表格或原型表达需求。原型只能提供其中一部分线索：页面上的“所属部门”可能是对象引用，也可能只是历史名称快照，必须结合业务含义判断。模板和参考例子提供框架用法，不能替用户决定对象、关系或流程。

## 编码前，把相关业务说清楚

新建或修改领域时，沿[Skill 的实现映射](../skills/cage-development/SKILL.md#4-写代码前说明实现映射)，说明本次涉及的对象、关系、动作与结果。小改动用几句话即可；已有清楚的业务文档直接引用，不要求每次另建文档或让用户逐项填表。

| 要说清楚什么 | 应落实到哪里 | 如何核对 |
| --- | --- | --- |
| 对象代表什么，是否有独立身份和生命周期 | aggregate、fields、states、不变量 | 不按页面数建表，不把独立业务对象藏进任意 JSON |
| 谁属于谁，双方各能关联几个，关系可否为空 | ref、unique、optional、hasMany、manyToMany 或关系聚合 | 外键方向、基数、目标声明、mappedBy 和实际查询一致 |
| 状态表示什么，哪些操作允许进入或离开 | states 的 labels、terminal、command 的 from/to | 状态名称和允许操作符合用户规则，保留状态的操作用 to: null |
| 谁能执行，能作用于哪些记录 | 能力、scope、invokedBy、constraints | 页面隐藏按钮和审批选人不能代替服务端授权 |
| 操作完成后，其他对象或系统怎样变化 | emits、reaction、approval、job、connector 及执行代码 | 明确触发、输入映射、事务、失败和重试；读取依赖不等于自动联动 |
| 怎样才算业务完成 | 已确认规则及成功、失败例子 | 独立读取结果，验证关键反例，区分静态声明和实际执行 |

涉及取舍时按[业务澄清](business-collaboration.md)提出疑点及选项。例如“一个员工是否允许同时有两个有效任职”“删除父对象后子记录如何处理”不能由字段名推断。已明确的规则直接采用，普通技术用法由 agent 查证。

## 名称写在真实 API 中

机器标识负责存储、能力点、路由和代码引用，业务名称负责让用户与 agent 理解它们。中文业务用中文名称，其他语言的应用用对应业务用语；不要为翻译而改已有状态值、表名或能力点。

| 内容 | 结构化填写位置 | 边界 |
| --- | --- | --- |
| 业务对象 | `aggregate('Note', { description: '部门便笺', ... })` | 说明对象含义；长篇规则仍由代码、JSDoc 和业务文档解释 |
| 字段及引用 | `text(120).describe('便笺标题')`、`ref('Dept').describe('所属部门')` | 描述不能代替 ref 关系、输入校验或 scope |
| 集合关系 | `.describe(...)` 或工厂选项 `description` | `hasMany` 仍需真实的 `mappedBy`，`manyToMany` 不会自动生成有业务状态的关系对象 |
| 每个状态 | `states(..., { labels: { active: '使用中', archived: '已归档' } })` | 每个状态都应有业务名；初态、终态和可达性单独声明/检查 |
| 业务操作 | `command(对象, { description: '归档便笺', ... })` | 用业务意图命名，实际条件由 from、constraints、handler 等落实 |
| 事件 | `event('NoteArchived', { ... }, { description: '便笺已归档' })` | 描述已发生的事实；没有下游需求时不必添加事件 |
| 查询、定时任务 | 各自选项中的 `description` | reads/calls、SQL 或 run 才表达实际依赖和处理 |
| 完整业务阅读流程 | `businessProcess` 的 `title/description`，阶段的 `title/description/actor` | action 和连接引用真实实现；阅读规格本身不会执行命令或补出缺失联动 |
| 板块、角色、无通用描述选项的协作节点、短标题覆盖 | `cage.config.json` 的 `graph.labels`，键为完整节点 key | 属于显示覆盖；不会修正错误关系，也不会自动成为其他界面的文案 |

优先把名称与领域声明一起维护。已有项目可用 `graph.labels` 适配：`state:Note.archived`、`field:Note.deptId`、`command:Note.archive`。配置覆盖优先于声明文案；字段也能使用本体属性里的 description。不要为每个节点发明不存在的 `label` 或 `description` 选项，先用 `cage capabilities` 核对公开签名。

普通源码注释和前端的 `statusLabel` 映射不会自动被抽取。仅在注释写“archived 表示已归档”，或者仅在页面翻译 archived，图谱仍缺少该状态的业务名。`graph.labels` 只作用于 CLI 图谱及上下文；页面文案与领域状态含义仍需核对一致，前端不得为读取文案导入 domain。

完整可编译示例见[便笺领域声明](../examples/note/note.ts)。其中 active/archived 保持机器标识，labels 写“使用中/已归档”，字段和命令分别填写自己的业务名称。便笺不需要审批和事件，不为凑齐图谱节点而添加它们。

## 对象关系要落到声明与执行

参考[关系指南](relations.md)选择方向与保存方式。例如“每条评论属于一条便笺”：

- 评论上的 `noteId: ref('Note').describe('所属便笺')` 表达真正引用；普通 `id()`、`text()` 或命名为 noteId 的字段不会自动建立引用。
- 便笺上的 `hasMany('NoteComment', { mappedBy: 'noteId', description: '便笺评论' })` 只是反查。修改归属仍执行评论命令，不能写父对象的只读集合。
- 评论是否沿用便笺部门、便笺归档后能否评论，分别由评论命令的 reads、handler 和允许规则落实；ref 不会自动继承权限、状态或删除行为。

跨对象动作也要有真实执行链。“批准后占用资源”应能找到命令发事件、反应接收、调用目标命令的完整声明，以及数据映射与事务选择。`reads` 箭头只证明读取，`from/to` 只证明允许的迁移，`invokedBy: 'process'` 只证明调用身份；它们都不能独自证明审批或自动执行。

业务阅读确实跨多个对象时，可以声明 `businessProcess` 解释完整主线并引用真实实现；简单对象生命周期不必额外包一层流程。图谱看起来有连线不能代替实际业务用例。

## 检查名称，再按业务验收

在应用根目录执行：

```sh
pnpm exec cage check
pnpm gen
pnpm exec cage graph
pnpm exec cage context "本次业务用语" --format json
```

`CAGE-ONTOLOGY-001` 报告当前项目有源码位置的聚合、字段、状态、命令、事件、查询和任务缺少非空结构化名称。字段和状态的位置指向所属聚合，不是假装精确的成员行号。来自依赖包且没有本地声明位置的节点不在本检查范围；协作节点没有统一的 description API，也不纳入该完整性规则。

旧配置默认产生警告；新脚手架启用以下门禁，也可在已有应用补齐名称后启用：

```json
{
  "graph": {
    "naming": "required"
  }
}
```

将 naming 合并进原有 graph 配置，保留 title 和 labels。required 让缺名阻止 check/gen/verify；图谱仍会展示可抽取的图及诊断，便于修复。默认警告并不表示业务文案已经完成，应在交付中说明仍缺什么。

静态检查只能验证名称存在和框架可识别的结构，不能判断中文是否准确，也不能判断一条外键是否符合任意用户需求。检查后逐项返回编码前的规则：对象含义、关系方向与基数、状态迁移、触发链及权限是否一致？成功和关键失败例子是否得到预期结果？按这些证据报告完成程度，不把“命名门禁通过”当作“理解了业务”。
