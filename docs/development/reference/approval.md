# 审批路由、任务与时效参考

首次接入走[审批课程](../guides/approvals.md)。本页用于查较复杂的路由、任务协议和执行边界。approval 来自 kernel，route/step/approver/parallel/branch/approvalOperations 来自 cage-approval。

## 绑定与选人

approval 的 process 与 route 相同；start 绑定开始事件，cancelOn 绑定取消事件，onApproved/onRejected/onReturned 指向本聚合的 process 命令。routable 列出交给流程的字段，AI 自动结论另需 automatedBy 角色 code。

| 选择器 | 来源 |
| --- | --- |
| approver.deptLeader('deptId') | 字段对应部门的负责人 |
| approver.role('reviewer') | 真实角色 code 对应的成员 |
| approver.user(id) | 指定用户 UUID |
| approver.field('reviewerIds') | 已公开并进入 routable 的 UUID 或 UUID 数组 |

字段数组原长度为 1–200，重复 ID 去重；缺失/null 形成空候选，非法值或超限明确拒绝。字段和候选节点开启时校验当前租户 active 用户，后续决定仍核对业务能力与范围。

routable 在启动消费者中从当前对象快照优先取值、再取事件载荷；实例启动后保存变量及步骤政策。条件不会随在途对象实时重算，代码更新也不会改变旧实例的动作政策。

## 顺序、条件和结构化并行

人工 step 默认 direct、any。direct 给选中的人分别建票；any 需要至少一个原始票通过，all 需要全部原始票通过，追加的必签票始终全部需要完成。

when 接受 gt/gte/lt/lte/eq/ne/isIn 等封闭条件。parallel 包含多个具名 branch，每条分支内顺序前进；全部展开的分支完成后开启组后节点：

```ts
parallel('联合审核',
  branch('业务线', step('经理', approver.role('manager'))),
  branch('专业线', step('法务', approver.role('legal'))),
)
```

这是 route 数组中的组合片段。每组 2–16 个不重名分支，整条声明最多 128 个办理节点、512 个结构节点和 8 层容器。条件全部不满足的分支直接参加汇合；整条路由没有办理节点时拒绝启动。

要把部门申请课程改为“部门负责人先审，业务与法务并行会审，最后经理确认”，用下面完整声明替换原 requestRoute，保留相同 process，不另注册第二条同名路由：

<!-- cage:example parallel-request-route -->
```ts
import { approver, branch, parallel, route, step } from '@yss123/cage-approval';

/** 部门负责人先处理，两个分支汇合后由经理承担最终结论；角色需配置真实有权人员。 */
export const requestRoute = route('department-request', [
  step('部门负责人', approver.deptLeader('deptId')),
  parallel('专业会审',
    branch('业务', step('业务审核', approver.role('reviewer'))),
    branch('法务', step('法务审核', approver.role('legal'))),
  ),
  step('最终确认', approver.role('manager'), {
    assignment: 'candidate',
    actions: { transfer: true, delegate: true, addSign: true },
    sla: { durationMinutes: 60, remindBeforeMinutes: 10 },
  }),
]);
```

SLA 需要从 domain 导出 approvalOperations()，见下节；这段没有新增条件字段，原 routable: ['deptId'] 可以继续使用。最后节点先领取再处理，候选池是 manager 角色成员，权限与职责分离仍由领域命令检查。

拒绝、退回或取消结束整轮，关闭其他活动任务。开启新节点失败回滚本次推进；前面已在其他事务通过的票保留。汇合后需要固定责任人时声明最终节点，否则最后完成分支的人可能承担结论身份，并接受领域约束。

currentSteps 是完整活动集合，currentStep 仅是最小索引。历史含 branchPath、dependsOn 和 definitionVersion；该指纹标识路由内容，不包含领域命令代码，也不提供在途迁移或版本回滚。

## 候选与任务管理

assignment: 'candidate' 只建立一项未分配任务，仅支持 any。领取时按当前组织规则和权限重新核对；字段选人用实例保存的值。

人工 step 的 actions 可逐项启用 transfer、delegate、addSign，默认关闭。新加签实例自动保存 parallel/before/after 位置；旧实例只按自己的快照开放。

| 动作 | 结果与限制 |
| --- | --- |
| claim | 候选领取，任务归一位持有人；已承担本节点另一票的人不能再领取 |
| unclaim | 候选持有人释放；未归还委派或未完成子票会拒绝 |
| transfer | 转交责任，接收人需当前批准/read 与单据范围 |
| delegate | 暂交受托人，受托人只能 resolve，不能决定或再次管理 |
| resolve | 归还服务端保存的原负责人，不推进节点 |
| addSign | 在当前节点增加必签票，每次 1–20 人、累计最多 20；仅原始任务发起 |

目标不能是自己或本节点已有当前/保留负责人。领取后退出候选角色不自动解除已承担责任；失去当前业务权限则不能操作。转办可交给有权的非候选人，candidate 属性仍保留。

加签 placement：parallel 同时处理；before 挂起父票，子票全通过才恢复；after 等父票或 any 的任一原始票通过才激活。同批多人彼此并行。waiting 只读，激活与恢复会增加 revision。

any 的其他原票可被 skipped，但已创建的追加票仍必签；all 中每张父票只激活自己的后签。最终决定人仍需通过领域约束，最后决定失败会回滚本次任务与结论变化。

## SDK 与 HTTP

所有写入复用会话和 CSRF；管理原因 trim 后非空，最多 1000 字。SDK 始终要求当前 expectedRevision；冲突后读取并核对。任务动作没有跨请求成功回执缓存，超时不能盲目重发。

| client 方法 | 协议或用途 |
| --- | --- |
| approvalTasks(status?) | GET /api/approval/tasks，默认 pending，可选 waiting |
| approvalCandidateTasks() | GET /api/approval/candidate-tasks |
| decideApprovalTask(id, outcome, input) | approve/reject/return，input 含 expectedRevision、comment |
| approvalTaskAction(id, input) | claim/unclaim/transfer/delegate/resolve/addSign |
| approvalTaskHistory(process, aggregate, id, page?) | 人工历史，after/limit，默认 50、最多 200 |
| approvalHistory(aggregate, id) | 轮次、节点、并行路径及审核解释 |

转办/委派传 targetUserId，加签传 userIds 与可选 placement；所有管理动作传 expectedRevision、reason。HTTP 管理路径为 /api/approval/tasks/:id/动作，addSign 对应 add-sign；历史为 /api/approval/task-history/:process/:aggregate/:id。

例如 Web 模块中的转办函数如下。task 是刚读取的待办，targetUserId 来自本租户的有权人员选择，而不是页面虚构身份：

<!-- cage:example transfer-approval-task -->
```ts
import { client, type ApprovalTask } from '@yss123/cage-client';

/** 按当前待办 revision 转交责任；失败保留原任务，成功后页面重新读取任务与历史。 */
export async function transferTask(task: ApprovalTask, targetUserId: string, reason: string) {
  return client.approvalTaskAction(task.id, {
    action: 'transfer', targetUserId, reason,
    expectedRevision: task.revision,
  });
}
```

本人或候选清单先各扫描每流程最近 200 条，再按当前授权过滤，当前无分页；返回不足不能推断历史总量。摘要不暴露额外敏感明文。人工历史按当前单据读取权限展示，处理过任务不会获得永久读权。

不存在、范围外或已被他人领取可能为 NOT_FOUND，策略/权限不符为 FORBIDDEN，旧 revision 为 CONFLICT，任务阶段不允许为 INVALID_TRANSITION。操作记录与任务变化共同提交；应用账号只有记录 INSERT/SELECT 权限，这不等于数据库管理员也无法修改。

## SLA、提醒与催办

从 domain 导出 approvalOperations()，再声明人工 step.sla 和 route 的 reminders。没有运行时会在注册校验阶段失败。

```ts
step('部门审核', approver.deptLeader('deptId'), {
  sla: { durationMinutes: 60, remindBeforeMinutes: 10 },
});
```

durationMinutes 是自然分钟总时限，实际进入节点才开始，提前量小于总时限；换算后至少 1 毫秒、至多 525600 分钟。转办、领取和加签不重置，后签激活时可能已超时。AI 及其人工接管不使用该人工 SLA。

worker 去重投递临期/超时站内提醒，跨过截止时只补超时；waiting 不收处理提醒。每 tick 最多扫描 25 节点，每节点最多补 100 个任务/接收人配对，轮转继续；送达受轮询与积压影响，大组织性能需实测。

route options 的 reminders 使用 requesterField 和 cooldownMinutes，申请人字段需公开、单用户 UUID 并进入 routable。催办校验申请人、提交版本、实例及当前活动集合，同实例共享冷却；最多 200 个合格配对，超限或无接收人失败且不消耗冷却。

| client 方法 | 用途 |
| --- | --- |
| approvalRequests() | 本人开放催办的运行申请；最近 200 个匹配实例再过滤，无分页 |
| urgeApproval(id, { expectedStep, expectedSteps, reason }) | 并行实例必须传完整升序活动集合，reason 1–1000 字 |
| approvalNotices({ after, limit, unreadOnly }) | 提醒 items/nextCursor，游标是字符串 |
| readApprovalNotice(id) | 标已读，重复保留首次时间 |

提醒授权过滤后空页仍可能有 nextCursor，继续到 null。催办只写提醒和历史，不改业务 version 或任务 revision。Admin 的 requests/notices/tasks 页面可复用，应用也可自行组合 SDK。

## 迁移与范围

执行本版本系统迁移，API/worker 一致部署；旧实例保留既有政策。AI、任务动作、前后签及提醒分别由具名系统迁移追加，历史 DDL 不改写。

当前支持结构化 AND，尚无任意连线、循环、OR 网关、指定节点跳转或在途迁移；也无岗位/代理时间规则、嵌套委派、减签、通用人员恢复、工作日历、自动升级、抄送和外部通知。

Admin 提供通用收件箱及启用后的运营页；采购范例另有协作名录和完整任务管理 UI。助理目前只有本人待办查询与决定工具，没有领取、转办、委派或加签管理写工具。

[原生 AI](../guides/intelligence.md) · [返回开发手册](../README.md)
