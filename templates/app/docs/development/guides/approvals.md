# 审批任务流转、并行分支与流程时效

## 第一次接入审批

审批负责谁在什么步骤作出决定，业务状态由领域结论命令落实。先完成下列最小链路，再按需要阅读后面的并行、加签与时效选项。普通自动状态变化直接使用命令和反应，无需套审批。

1. 业务对象有草稿、待审批和相应结论状态。提交命令声明 emits 并成功发出提交事件；通过/拒绝等结论声明为 process 命令。
2. approval 绑定提交事件、结论命令和取消事件，route 定义步骤与选人；两者都从 domain 入口导出。routable 只包含选路和任务需要的业务快照字段。
3. 配置实际负责人/角色成员，并分别授予所需能力、范围和额度；声明 role code 不会创建角色或分配人员。检查迁移和运行中的 worker。
4. 页面先通过业务契约提交，再读取真实待办，通过公开任务接口携带当前 revision 作出决定。业务列表中的“待审批”不等于当前用户拥有待办。
5. 观察提交事件、待办、决定与领域最终状态；用不合格主体验证拒绝，按需求验证撤回。缺少待办时按[排错方法](../tools/troubleshooting.md)查具体断点，不直接把单据改成通过。

完整跨文件参考见[采购导读](../examples/purchase-example.md)，基础声明见[审批绑定与选人](../reference/primitives.md#审批绑定与选人)。本页后续的客户端操作是接入片段，业务符号与 UI 需来自当前应用。

[返回学习入口](../README.md) · [审批原语](../reference/primitives.md) · [AI 审批](intelligence.md)

本页描述 Cage 原生审批引擎的顺序/条件/结构化 AND 并行、字段选人、候选领取/释放、转办、委派归还、前后/并行必签、操作记录，以及框架通用的自然分钟时限、站内提醒和申请人催办。它参考 Flowable 的任务责任划分和并行汇合语义，不表示支持全部 BPMN 或与 Flowable XML 兼容。

## 声明选人和节点操作

人工步骤默认 `assignment: 'direct'`，为每位选中的人分别建立已分配任务。`mode: 'any'` 表示至少一位原审批人通过，`mode: 'all'` 表示全部原审批人通过。转办、委派和加签通过 `actions` 逐项开放，未写的动作关闭。

以下是局部步骤片段，需放进应用已经导出的 `route`，并与自己的 `approval` 绑定配合：

```ts
import { approver, step } from '@yss123/cage-approval';

// 为角色中的每位审批人直派一票；任一原票通过后仍需等待所有追加的必签票。
step('部门审核', approver.role('reviewer'), {
  mode: 'any',
  actions: { transfer: true, delegate: true, addSign: true },
});

// reviewers 必须是本聚合的公开字段并列入 approval.routable；领取成功不产生新的业务权限。
step('专业审核', approver.field('reviewers'), {
  assignment: 'candidate',
  actions: { transfer: true, delegate: true, addSign: true },
});
```

`assignment: 'candidate'` 只创建一项 `assigneeId: null` 的共享任务，候选人必须先领取才能决定。它独立开放 `claim/unclaim`，无需在 `actions` 中增加字段；即使没有其他动作政策也能领取/释放。候选池只支持 `any`，`candidate + all` 在声明时拒绝；逐人会签使用默认的 `direct`。

流程启动时保存选人规则、分配方式和动作政策的步骤快照。新 `step` 在 `actions.addSign: true` 时自动记录 `signPositions: ['parallel', 'before', 'after']`，应用无需另传签序配置。修改代码不会改变在途实例政策，也不会把旧直派任务合并为候选池。角色和部门规则在候选列表及领取时查询当前组织数据，字段选人使用提交时保存的路由变量；规则快照不等于冻结一份候选成员名单。AI 步骤的人工接管仍使用原来的直派方式，不开放任务管理动作。

### 按单据字段选人

`approver.field('reviewers')` 支持单个 UUID 字符串或原数组长度为 1–200 的 UUID 数组，重复人员去重。字段必须存在、不是 hidden，并列入对应 `approval.routable`；不满足时声明检查报 `CAGE-APPR-001`。数组可用 `list(id())` 声明，单人可用已有的 UUID 或用户引用字段；选人器不执行任意 JS、SQL 或字符串表达式。

字段缺失或为 `null` 时解析为空候选，开启节点报 `CAGE-APPR-007`；空数组、非法 UUID、数组中包含非字符串或超过 200 项报 `INVALID_INPUT`。开启字段选人或候选节点时，所有选中的 ID 必须属于当前租户且账号 active，否则整批失败，不静默去掉无效人员或默认批准。旧的固定用户/部门负责人直派规则保持原有开启行为。

开启节点的账号校验不会替用户授予批准/read 能力或数据范围。领取、转办、委派、加签和实际决定仍按当时的权限核验；配置了有效用户也不代表其最终额度、职责分离等业务硬约束一定满足。

## 结构化并行分支与 AND 汇合

`parallel(title, ...branches)` 声明同时推进的分支组，`branch(title, ...nodes)` 声明其中一条具名分支。分支内部可以有多个顺序步骤、条件和嵌套并行组；所有实际展开的分支都完成后，才开启组后面的节点。下例是应用路由片段，需要从 domain 入口导出，并绑定自己的 `approval`；`requiresLegal` 必须列入该绑定的 `routable`，角色与相应业务权限由应用明确配置。

```ts
import { approver, branch, eq, parallel, route, step, when } from '@yss123/cage-approval';

/**
 * 材料审核后同时推进业务与专业两条线；专业线的法务条件在提交时求值。
 * 各线均完成才创建最终确认待办，结论仍由 approval 绑定的领域命令落实。
 */
export const documentRoute = route('document-review', [
  step('材料审核', approver.role('reviewer')),
  parallel('联合审查',
    branch('业务线',
      step('业务复核', approver.role('business-reviewer')),
      step('预算核对', approver.role('budget-reviewer')),
    ),
    branch('专业线',
      step('专业评估', approver.role('specialist')),
      when(eq('requiresLegal', true),
        step('法务审查', approver.role('legal-reviewer')),
      ),
    ),
  ),
  step('最终确认', approver.role('final-reviewer')),
]);
```

业务复核通过后即可进入预算核对，无需等待专业评估；专业线也独立前进。只有两条线均通过，最终确认才出现。节点内 `mode: 'all'` 是同一节点的多人会签，`addSign` 的 `placement: 'parallel'` 是同一节点的追加必签，两者都不会创建流程分支；它们可以继续用于某条分支中的人工节点。

条件只在实例启动时依据提交变量求值，执行中不重新读取单据来改变路线。声明中的容器不能为空；如果某条分支的全部条件均不满足，展开后该分支直接通过汇合，不生成虚假任务。如果整个路由没有展开出任何办理节点，则明确拒绝启动。每个并行组要求 2–16 条名称不重复的分支；整份声明最多 128 个人工/AI 办理节点、512 个结构节点和 8 层容器。条件不满足不会绕过声明结构校验。

拒绝、退回或取消结束整个审批轮次，关闭其他分支中的活动节点和 pending/waiting 任务；尚未开启的后续节点不再创建。正常推进在实例锁内检查持久前驱状态，节点唯一键防止并发分支重复创建同一汇合后继。若同一次启动或推进中的任一新节点无法开启，整个本次事务回滚，不留下部分成功的分支入口。已经在较早事务中通过的票仍保留。

最终业务结论仍以实际推进完成的办理人身份调用领域命令。并行组后没有明确的最终审批节点时，最后完成分支的人可能承担该身份；额度、职责分离或状态约束不满足会回滚本次决定。需要固定最终责任人时，应像上例一样在 AND 汇合后声明明确的最终节点。

### 快照、历史和界面定位

执行计划保存在既有 `flow.approval_instance.steps` JSON 中，每个叶子步骤附带 `execution.schema/dependsOn/branchPath/definitionVersion`。`dependsOn` 是本实例内的前驱索引，全部前驱 approved 才能开启当前节点；数组中的声明遍历顺序不是实际完成顺序。`branchPath` 按外层到内层记录并行组及分支名称，普通主线为空数组。无需为这次并行能力新增 DDL 迁移；仍需完成当前版本已发布的 AI、任务流转和时效迁移，并让 API/worker 使用同一版本。

`definitionVersion` 是流程名、路由节点和催办政策等路由声明的 SHA256 内容指纹，不包含领域命令实现。它用于识别实例启动时保存的路线，不能替代完整的定义发布、版本回滚、领域命令版本绑定或在途迁移。代码更新不重算已有实例的依赖和政策；没有 `execution` 的历史快照仍按相邻顺序执行，历史版本指纹为 null，不追溯伪造。

任务摘要提供 `branchPath`；`client.approvalHistory(aggregate, id)` 提供 `currentSteps`、`definitionVersion` 及各步骤的 `branchPath/dependsOn`，仍遵守当前单据与详情读取权限。`currentSteps` 是完整活动节点集合，包含排队、运行、人工接管和待诊断的失败节点；只有通过状态满足后继依赖。`currentStep` 只保留最小活动索引作为旧客户端摘要，不能代表整轮只有一个节点，也不能据此判断其他分支是否前进。申请列表另有 `activeSteps`，提供各活动节点的名称、截止时间和分支路径。

`cage graph` 递归展示条件和 AND 分叉/汇合；节点编号只定位声明，图中分列的分支才表达并发关系。它展示已声明的结构，不是运行时设计器，也不直接证明某个实例已完成。当前只支持这种有界结构树，不支持任意连线、循环、OR/包容网关、事件竞争、指定节点跳转或在途实例迁移。

## 迁移和部署

通过应用原有 `pnpm migrate` 执行系统迁移，再将 API 与 worker 切换到同一版本：

| 系统迁移 | 数据含义 |
| --- | --- |
| `cage:approval_task_actions_001` | 任务 revision、委派责任、original/additional 和追加式动作历史；旧任务保持 original、revision=0 |
| `cage:approval_task_stages_002` | 新增 assignment、父任务和签序；仅候选任务允许持有人为空，旧任务保持 direct |
| `cage:approval_deadlines_003` | 节点截止/临期/扫描时间、实例催办政策与冷却、持久站内提醒及已读；旧值为 null，不自动开始计时 |

已发布的审批 DDL 和旧迁移没有改写。旧原票及旧版并行加签的 `parentTaskId/signPosition` 为空；升级不伪造旧签序或历史操作。升级后新创建的加签票保存父任务和签序。旧快照不会自动增加 actions、assignment 或 signPositions；升级前已经保存 `addSign: true` 但没有 signPositions 的节点只允许 parallel，before/after 返回 FORBIDDEN。没有 addSign 政策的旧实例仍完全禁止加签。不能把旧库基线测试中可创建直派任务理解为支持新版 API/worker 在未迁移数据库上运行。

## 六种操作的区别

| 操作 | 结果 | 边界 |
| --- | --- | --- |
| claim 领取 | 未分配候选任务归当前用户处理，离开可领取列表 | 实时检查候选资格、active、批准/read 和单据范围；一个任务只能有一位持有人 |
| unclaim 释放 | 当前持有人清空分配，任务重新进入候选池 | 仅 candidate；委派未归还或存在未完成子票时拒绝；保留已完成子票和历史 |
| transfer 转办 | 接收人成为当前审批人，原审批人失去该任务决定权 | 双方须有单据 read/范围及批准能力；不转移角色授权 |
| delegate 委派 | 保存原负责人，将待办交受托人处理 | 受托人只能 resolve；不能批准、拒绝、退回、再次转办/委派/加签或释放 |
| resolve 归还 | 返回服务端保存的原负责人，等待其审批 | 不推进节点；原负责人停用或失去批准/read 时拒绝 |
| addSign 加签 | 当前节点添加独立必签任务，按 placement 控制签署顺序 | 仅原始任务可发起，每次 1–20 人、每节点累计最多 20 人；不创建新流程节点 |

领取后移出候选角色不会自动取消已经承担的任务责任。只要仍有当前批准/read 权限和单据范围，该持有人可以正常决定或释放；失去这些业务权限后会拒绝操作。候选任务可以在动作政策允许时转办给有业务权限的非候选人，转办后仍保留 candidate 属性，新持有人也能按规则释放。没有管理员强制释放或无可用人员的通用恢复入口，不能在文档中以直接改表代替恢复功能。

接收人不能是本人或同节点其他任务的当前/保留负责人，包括已经决定的人。候选领取也不能领取本人已经承担另一票的节点原票；例如完成前签的人不能在原票被释放后再领原票。转办或释放不能把独立会签名额压缩为同人多票。

## 前签、后签和并行必签

`addSign` 的 `placement` 省略时为 `parallel`，已有客户端保持原来的并行含义。请求的位置还必须包含在当前实例的 signPositions 中，客户端不能仅凭新版声明替旧实例开放前后签。同一次追加的多位签署人彼此并行，不表示按 `userIds` 顺序逐人串签。

| placement | 创建时 | 何时恢复或激活 |
| --- | --- | --- |
| `parallel` | 原票和新加签票均可处理 | 原票通过仍须等待全部追加票 |
| `before` | 父任务变为 waiting，新加签票为 pending | 全部前签批准后，仍在 waiting 的父任务恢复为 pending |
| `after` | 父任务可处理，新加签票为 waiting | all 等自己的父票批准；any 等本节点任意原票批准 |

waiting 任务只能查看，不能决定或执行任务管理动作。前签完成恢复父票、后签从 waiting 激活为 pending 时都会增加该任务的 revision；原来等待页面保存的版本不可直接提交。

`any` 需要至少一张原票和全部追加票通过。其他原审批人先批准时，其余 pending/waiting 原票会 skipped，已经创建的前签、并行签、后签全部保留为必签；全部 waiting 后签此时激活。前签随后完成不会复活已经 skipped 的父票。`all` 需要全部原票和追加票通过，每张父票只激活自己的后签。

任一当前可决定的任务拒绝或退回，会调用原有领域结论命令；成功后关闭同轮次剩余 pending 和 waiting。取消或重新提交也会关闭旧轮次两种状态的任务。不能通过释放仍带未完成前/后/并行子票的候选任务来丢弃必签责任。

最终推进流程的实际决定人必须通过领域结论命令的额度、职责分离、状态和版本约束。后签人可能成为最终签署人；若其额度不足，最后决定、版本、阶段变化及本次历史共同回滚，之前已提交的父票保留。引擎不会自动改用更早审批人的身份。

## 客户端调用

```ts
import { client } from '@app/contracts';

const candidates = await client.approvalCandidateTasks();
if (candidates.ok && candidates.data.length) {
  const task = candidates.data[0];
  // 展示候选不代表任务已被占用；服务端在领取事务中再次检查候选规则、权限和版本。
  const claimed = await client.approvalTaskAction(task.id, {
    action: 'claim', expectedRevision: task.revision, reason: '由我负责核查材料',
  });
  if (claimed.ok) {
    // 领取已增加任务版本，后续界面读取本人待办并使用新版本；此处不自动替用户批准。
    await client.approvalTasks();
  }
}
```

其他已提供的调用如下，目标用户 ID 由应用选人界面提供，不在页面写死员工 ID：

- `client.approvalTasks()` 读取本人 pending；`client.approvalTasks('waiting')` 查看等待签署依赖的本人任务。
- `client.approvalCandidateTasks()` 读取当前可领取的共享任务，不把它们混入本人的可决定清单。
- `approvalTaskAction(id, { action: 'claim' | 'unclaim' | 'resolve', expectedRevision, reason })` 不接受目标用户字段。
- 转办/委派为 `{ action: 'transfer' | 'delegate', targetUserId, expectedRevision, reason }`。
- 加签为 `{ action: 'addSign', userIds, placement?: 'parallel' | 'before' | 'after', expectedRevision, reason }`；目标数组不能重复。
- `client.decideApprovalTask(id, 'approve' | 'reject' | 'return', { expectedRevision, comment? })` 提交审批决定。
- `client.approvalTaskHistory(process, aggregate, id, { after?, limit? })` 返回 `items/nextCursor`；默认 50，最多 200 条。

摘要中的 `assigneeId` 是当前持有人，未领取时为 null；`assignment` 区分 direct/candidate，`parentTaskId/signPosition` 表示加签来源和顺序，`signPositions` 提供本实例允许发起的签序，`delegation: 'pending'` 表示只能归还。`actions/signPositions` 仅提示实例开放的管理政策，不能代替当前用户权限或任务状态校验。

任务 `revision` 与单据 `version` 不同。candidate 节点或启用了任一任务管理动作的节点，决定也必须携带 `expectedRevision`；其他旧直派节点保留不带版本的引擎/HTTP 兼容调用，SDK 始终要求版本。领取、释放、转办、决定、激活或关闭任务都会使相应版本递增。冲突后重新读取并让用户核对；接口没有跨请求成功回执缓存，超时不表示服务端未提交，不可盲目重发。

助理的 `approval_tasks` 只查询本人 pending 待办，`approval_decide` 可以保存并提交读取到的 `expectedRevision`，决定时仍检查委派状态、归属和权限。助理目前没有候选领取/释放、转办、委派归还或加签的管理写工具；这些功能由页面直接调用 SDK。

## HTTP、可见性与操作记录

| HTTP | 输入/行为 |
| --- | --- |
| GET `/api/approval/tasks` | `status` 默认 pending，可用 waiting 查看本人等待任务 |
| GET `/api/approval/candidate-tasks` | 当前未领取、规则和权限均符合的任务 |
| POST `/api/approval/tasks/:id/claim`、`unclaim` | `expectedRevision/reason` |
| POST `/api/approval/tasks/:id/transfer`、`delegate` | `targetUserId/expectedRevision/reason` |
| POST `/api/approval/tasks/:id/resolve` | `expectedRevision/reason` |
| POST `/api/approval/tasks/:id/add-sign` | `userIds/placement?/expectedRevision/reason` |
| POST `/api/approval/tasks/:id/approve`、`reject`、`return` | `expectedRevision/comment` |
| GET `/api/approval/task-history/:process/:aggregate/:id` | `after` 记录 ID 字符串，`limit` 分页大小 |

所有写入沿用会话与 CSRF。意见/原因最多 1000 字，管理动作原因去首尾空白后必须非空；未知字段、伪造 action 和非法 placement 拒绝。任务不在当前租户、不是本人持有，或领取时已经归别人，返回 NOT_FOUND；策略未开放、候选资格或能力不符返回 FORBIDDEN；仍可操作的任务版本过期返回 CONFLICT；waiting、已关闭、委派状态不允许或非当前步骤返回 INVALID_TRANSITION。并发抢领失败不保证都返回版本冲突，另一个人已持有时会返回 NOT_FOUND。

每个流程分别扫描本人对应状态最近 200 条任务，或最近 200 条未领取候选任务，再按当前单据 read/范围过滤；候选还检查批准能力、当前选人规则和同节点是否已经承担其他票。停用或失去当前读取权限后不会继续披露相应摘要。过滤后可能不足 200 条，当前没有分页游标，不能据此断言更早没有符合条件的任务。

`vars` 保留提交时路由变量的含义，但始终去 hidden 并对敏感字段掩码。即使具备明文能力，也需另经正式业务读取接口获得带审计的明文。

领取、释放、转办、委派、归还、加签、激活、人工决定、跳过和取消写入独立动作记录，与本次任务变更共同事务提交或回滚。应用账号只有记录 INSERT/SELECT 权限；这不是数据库管理员也无法修改的防篡改存储。当前单据授权读者可分页查看人工意见，处理过任务不产生永久读权。不要把凭据或无权共享的额外明文写入原因；迁移前发生的操作不会自动补录。

## 当前界面和验收边界

框架 Admin 用同一收件箱表格展示本人、可领取和等待加签任务及各类数量；采购范例提供“待我处理 / 可领取 / 等待加签”三个视图。两者都有领取、释放、受托任务归还及正常决定入口。waiting 仅展示，不显示决定按钮；候选和受托任务分别显示领取、归还入口。采购 `/approvals` 用 `view=candidates`、`view=waiting` 保存视图，默认本人待办不需要 view 参数。界面可提示操作，未完成子票等动态限制仍由服务端拒绝。

采购范例包含协作名录选人、转办/委派/三种加签及分页人工操作历史，详见 [采购导读](../examples/purchase-example.md)。框架 Admin 提供通用任务收件箱，启用审批运营后提供“我的申请”和“流程提醒”，不依赖采购的页面、名录或额外业务字段。框架支持、应用路由启用、浏览器验收仍是不同状态。

应用接入需检查真实角色、路由、迁移、worker 与浏览器路径，覆盖相关成功和拒绝场景；框架历史回归结果不能代替当前应用验收。

尚未实现受限岗位规则、代理时间段、嵌套委派、无可用人员的通用恢复、减签/撤销加签、任意串行加签链、指定节点退回、任意流程图/循环/OR 网关、工作日计时、自动升级、抄送、邮件/短信通知和可视化运行时设计器。

## 框架通用时限、提醒与催办

这组能力实现在 `@yss123/cage-approval`，复用内核的 runtime/worker 扩展，不需要业务项目创建通知表或编写定时任务。应用只需声明政策，沿用正常迁移、API 与 worker 启动流程。旧实例未声明时限或催办政策时不会被升级自动开放。

```ts
import { approvalOperations, approver, route, step } from '@yss123/cage-approval';

/** 通用站内运营服务，从 domain 入口导出，worker 才会扫描到期节点。 */
export const approvalOps = approvalOperations();

/** 局部接入示意：对应 approval 必须已绑定，并把 createdBy 列入 routable。 */
export const documentRoute = route('document-review', [
  step('部门审核', approver.role('reviewer'), {
    sla: { durationMinutes: 1440, remindBeforeMinutes: 60 },
    actions: { transfer: true, delegate: true, addSign: true },
  }),
], { reminders: { requesterField: 'createdBy', cooldownMinutes: 15 } });
```

`durationMinutes` 是进入人工节点后可用的**自然分钟总时限**，`remindBeforeMinutes` 是截止前多少分钟进入临期提醒。两者允许小数分钟，换算后至少一毫秒、至多 525600 分钟，提前量严格小于时限；省略提前量则只发超时提醒。每条并行分支的节点在实际开启时独立开始计时，尚未满足前驱的节点不提前计时。时限以数据库持久时间计算，加签、转办、委派、领取和释放都不重置；后签激活时该节点可能已经超时。AI 节点及其人工接管不使用此人工节点 SLA，已有人工接管待办仍可接收申请人催办。没有工作日历、节假日扣除或按员工时区计算的工作时间。

临期/超时由 worker 扫描各分支的持久活动节点并写入站内提醒。同一节点阶段、任务、收件人去重；worker 重启或并发扫描不重复投递同一项。已经跨过截止时间时只补超时，不补过时临期。转办或后签激活后的新办理人可在下一次扫描收到当前阶段提醒。waiting 票不会收到“请处理”提醒，取消、完成和不再活动的步骤停止投递；提醒不会自动批准、自动转办或替人取得能力。

每次 tick 最多扫描 25 个节点，每个节点最多投递 100 个尚未收到当前阶段提醒的任务/接收人配对，后续扫描继续补齐；扫描位置保存在数据库并轮转，完成投递的旧节点不会永久占满批次。角色选人仍读取当前完整候选集合，尚未验证大组织生产规模性能。手动催办最多 200 个合格配对，超出明确返回 INVALID_TRANSITION 且不写通知或冷却。提醒实际到达时间受 worker 轮询和队列积压影响，不是精确到毫秒的送达承诺。

接收人根据当前 pending 任务的持有人、未归还委派的原负责人或未领取候选规则计算，并实时过滤 active、批准/read 能力与单据范围。候选人已承担本节点另一票时不接收可领取提醒。通知读取与标已读仍核对本人、当前权限及接收关系，转出或撤权后不能凭旧通知继续查看原因。它是当前协作收件箱；永久操作追溯仍用 `approvalTaskHistory`。

申请人由路由 `reminders.requesterField` 指定，必须是公开且进入 `routable` 的单个用户 UUID 字段，并随提交冻结。仅能读取单据不等于能催办。催办绑定实例 UUID 与 `expectedStep`，并行实例还必须提交完整且按升序排列的 `expectedSteps`，其值使用最近一次申请摘要中的 `currentSteps`。即使并行实例暂时只剩一个活动节点，也不能省略该集合；否则返回 INVALID_INPUT。最小索引未变而另一分支已推进时，旧集合仍会返回 CONFLICT，页面应刷新后由用户重新核对。

催办事务同时检查活动集合、业务提交版本、申请人和冷却时间，向全部活动节点的合格任务/接收人配对投递。同实例跨分支、跨节点共享冷却，冷却中或旧业务版本返回 CONFLICT；无合格接收人明确失败且不消耗冷却。催办只增加提醒和操作记录，不修改业务 version 或待办 revision。本人申请从最近 200 个匹配实例中再按当前可见性过滤，未提供分页，不能把返回数量当作完整历史总数。

公共 SDK 使用与其他命令相同的会话和 CSRF：

| 调用 | 用途 |
| --- | --- |
| `client.approvalRequests()` | 本人发起且开放催办的运行实例，含 currentSteps、逐节点 activeSteps、最近截止 dueAt 和 nextUrgeAt |
| `client.urgeApproval(instanceId, { expectedStep, expectedSteps, reason })` | 并行必填完整 expectedSteps；原因 1–1000 字；返回任务/接收人配对数及再次可催办时间 |
| `client.approvalNotices({ after?, limit?, unreadOnly? })` | 本人当前可见提醒，返回 items/nextCursor，游标始终为字符串 |
| `client.readApprovalNotice(id)` | 标已读；重复请求保留首次已读时间 |

```ts
const requests = await client.approvalRequests();
if (requests.ok && requests.data.length) {
  const selected = requests.data[0];
  // 页面应先让申请人选择实例并填写原因；同时提交最小索引与完整集合，防止旧页面误催已变化的分支。
  const result = await client.urgeApproval(selected.id, {
    expectedStep: selected.currentStep,
    expectedSteps: selected.currentSteps,
    reason: '材料已补齐，请继续审核',
  });
  if (result.ok) {
    // recipientCount 按任务与接收人配对计数；同一人处理两条分支可收到两条提醒，不是去重人数。
    console.log(`已发送 ${result.data.recipientCount} 条站内催办提醒`);
  }
}
```

对应接口为 GET `/api/approval/requests`、POST `/api/approval/instances/:id/urge`、GET `/api/approval/notices`、POST `/api/approval/notices/:id/read`。只有启用运行时才注册，并写入 OpenAPI。提醒分页按底层稳定记录游标推进，授权过滤后空页也可能有 nextCursor，应继续加载直到 null；单条通知不包含整份路由变量。

框架 Admin 的 `/admin/#/requests` 可填写原因并催办，`/admin/#/notices?view=unread` 可筛选、翻页和标已读；`view=all` 展示当前可见的全部提醒，`#/tasks` 展示截止时间。业务应用可以直接使用这些页面，也可以消费公共 SDK 构建自己的界面。采购仅作为接入验收载体，框架功能不依赖采购业务代码。
