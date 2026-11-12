# 接通提交、待办与审批结论

本篇先完成一条部门申请：创建草稿 → 提交 → 部门负责人处理待办 → 申请变为已批准或已驳回。完整教学文件是[部门申请声明](../examples/approval/review-request.ts)，包含聚合、命令、事件、绑定和路由；[客户端调用](../examples/approval/request-actions.ts)提供可编译的操作示例。

审批引擎负责节点和任务，业务状态由领域命令改变。先接通这条链，再按需要配置会签、并行、转办和提醒。

## 1. 声明申请及结论

将教学文件放到 packages/domain/src/modules/review-request/review-request.ts。申请有 reason、deptId、createdBy，状态为 draft、pending、approved、rejected、cancelled。

| 用户动作或结论 | 命令 | 状态变化 |
| --- | --- | --- |
| 保存说明 | create | new → draft |
| 提交 | submit，发 Submitted 事件 | draft → pending |
| 撤回 | withdraw，发 Withdrawn 事件 | pending → cancelled |
| 审批通过 | approve，仅 process | pending → approved |
| 审批驳回 | reject，仅 process | pending → rejected |

approve/reject 使用 sod.notSameAs('createdBy')。浏览器提交的是待办决定，引擎再调用这两个结论；它们没有普通用户写接口。

例如创建草稿的命令只接收说明，不让浏览器指定创建人或状态：

<!-- cage:check domain approvals-create -->
```ts
export const createRequest = command(ReviewRequest, {
  name: 'create', description: '创建申请草稿', from: 'new', to: 'draft',
  input: z.object({ reason: z.string().trim().min(1).max(1000) }),
  handler: draft => draft,
});
```

提交从草稿进入待审批并明确发事件，UUID 取自本次记录；这是事件发生的入口：

<!-- cage:check domain approvals-submit -->
```ts
export const submitRequest = command(ReviewRequest, {
  name: 'submit', description: '提交申请进入审批', from: 'draft', to: 'pending',
  emits: [emit(ReviewRequestSubmitted, record => ({ requestId: record.id }))],
  handler: draft => draft,
});
```

撤回则发另一种事实，交给绑定的 cancelOn 取消旧流程，不直接操作待办表：

<!-- cage:check domain approvals-withdraw -->
```ts
export const withdrawRequest = command(ReviewRequest, {
  name: 'withdraw', description: '撤回待审批申请', from: 'pending', to: 'cancelled',
  emits: [emit(ReviewRequestWithdrawn, record => ({ requestId: record.id }))],
  handler: draft => draft,
});
```

批准结论只接受 process 并检查职责分离；驳回沿用同样守卫、把 to 设为 rejected：

<!-- cage:check domain approvals-conclusion -->
```ts
export const approvedConclusion = command(ReviewRequest, {
  name: 'approve', description: '通过申请结论', from: 'pending', to: 'approved', invokedBy: 'process',
  constraints: [sod.notSameAs('createdBy')], handler: draft => draft,
});
```

## 2. 绑定事件与路由

同一教学文件中的接线是：

```ts
export const requestApproval = approval(ReviewRequest, {
  process: 'department-request',
  start: ReviewRequestSubmitted,
  cancelOn: [ReviewRequestWithdrawn],
  routable: ['deptId'],
  onApproved: approveReviewRequest,
  onRejected: rejectReviewRequest,
});

export const requestRoute = route('department-request', [
  step('部门负责人审批', approver.deptLeader('deptId')),
]);
```

approval 引用开始/取消事实与本聚合结论，route 使用相同 process 标识决定步骤。routable 只开放选人和条件真正需要的字段。

从模块 index.ts 导出文件，再从 domain 总入口导出模块。API 和 worker 加载相同入口，运行 check、gen，审查迁移后执行 migrate。代码路由带系统迁移，服务启动不代替迁移。

## 3. 配置实际人员和授权

准备两个不同的真实用户：申请人和部门负责人，并把负责人写到申请部门的组织记录中。

申请人需要 ReviewRequest.read、create、submit，以及本课选择的可见范围；需要撤回时再授 withdraw。负责人需要 ReviewRequest.read、approve、reject 和覆盖申请的范围。角色名字或部门负责人字段本身不会授予这些能力。

例如部门 A 中甲是申请人、乙是真实负责人，两人的授权与职责分开配置：

| 人员 | 能力例子 | 预期 |
| --- | --- | --- |
| 甲 | ReviewRequest.read/create/submit/withdraw，部门范围 | 创建、提交和撤回，不能凭申请人身份批准 |
| 乙 | ReviewRequest.read/approve/reject，覆盖 A 的范围 | 收到负责人待办后处理 |
| 甲兼任负责人 | 仍是申请创建人 | sod 拒绝自己审批，不能靠选人绕过 |

首次可由管理员在独立环境配置，随后用普通账号完成整个过程。缺负责人、账号不可用、缺能力、范围不符和自审批分别可能阻止不同阶段。

## 4. 页面通过契约提交，再处理待办

应用生成 reviewRequest 契约。创建使用 reason，提交携带当前 id 和 version。提交成功后单据为 pending；worker 消费事件后才会有待办。

待办页使用当前登录账号：

```ts
const result = await client.approvalTasks();
if (result.ok) {
  // 交给页面展示，由用户选择任务并明确作出决定。
  renderTasks(result.data);
}
```

renderTasks 是应用界面函数。用户选择任务并确认批准后调用：

```ts
const result = await client.decideApprovalTask(task.id, 'approve', {
  expectedRevision: task.revision,
  comment: '材料符合要求',
});
```

task 来自刚读取的待办，comment 来自用户输入；页面检查 result.ok，成功后重新读取待办和单据。task.revision 与单据 version 是两套并发控制。

框架 Admin 提供通用任务收件箱，也可在业务页使用 SDK。单据显示“待审批”不代表当前用户有一张可决定的票。

## 5. 观察完整结果

先让申请人创建、提交，再让负责人读取待办并批准。最后通过安全 get 独立读取申请，应为 approved；检查缺能力、自审批和范围外请求均被拒绝。

例如待办决定返回后，用生成契约重新取得申请；finished 与业务最终状态各自观察，不从页面刚点击的按钮推断：

<!-- cage:check web approvals-read-final -->
```ts
export const loadFinalRequest = (id: string) => reviewRequest.get(id);
```

再创建一条申请，提交后撤回，等待取消事件处理后确认旧待办关闭。提交成功但没有待办时按[排错方法](../tools/troubleshooting.md)检查事件、worker、绑定与选人，不直接改状态。

例如提交事务已让申请进入 pending，但 worker 未启动，此时没有待办是流程启动断点；启动正确版本 worker 后观察任务，而不是再发一条批准命令强行消掉 pending。

本课不提供退回修改或重提。需要这些动作时增加对应领域命令与绑定；AI 审批必须明确 onReturned，见[原生 AI](intelligence.md)。

## 扩展流程

| 需要什么 | 怎样扩展 |
| --- | --- |
| 一步多人 any/all | 调整 step 的 mode，区别原始票与追加必签票 |
| 按角色或单据字段选人 | approver.role/field，字段进入 routable |
| 条件和并行会审 | when、parallel、branch；实例启动时展开并保存依赖 |
| 候选领取、转办、委派、加签 | assignment/actions；页面使用当前任务 revision |
| 时限、站内提醒和申请人催办 | 导出 approvalOperations，配置 sla 与 reminders |
| AI 预审或人工接管 | 现有 step 的 kind: 'ai' |

这些选项、API、快照和限制集中在[审批参考](../reference/approval.md)。阅读完整组合业务用[采购导读](../examples/purchase-example.md)。

例如把单负责人改成多角色会签，最小变化就是选人和 mode；创建/提交及领域结论仍复用原实现：

<!-- cage:check domain approvals-expand-all -->
```ts
export const allReviewers = step('专业会签', approver.role('reviewer'), { mode: 'all' });
```

若变成“负责人先审、财务后审”，则在 route 数组中按顺序放两个 step；两个专业部门同时处理才选 parallel，不能把这三种规则当成同一配置。

[返回开发手册](../README.md)
