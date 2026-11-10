# @yss123/cage-approval

Cage 的审批路由与执行包。用代码声明顺序步骤、条件分支、角色/部门负责人选人和会签，提供待办接口、审批历史与结论桥接，也支持 AI 审批步骤。通过、驳回和退回最终调用领域命令，审批引擎不直接修改业务表。

## 安装

需要 Node.js 24+、PostgreSQL，以及同版本 Cage 框架。在应用 domain 包中安装：

```powershell
pnpm add @yss123/cage-approval @yss123/cage-kernel
```

标准 `@yss123/cage-http` 装配审批接口，worker 消费审批启动/取消事件。只启动 API 不会完成后台事件消费。

## 将已有业务接到审批

以下是采购模板可用的组合片段。`PurchaseOrder`、事件和结论命令来自业务文件；结论命令须声明正确的状态迁移、process 调用身份及业务硬约束。

```ts
/** 将领域事件关联到审批生命周期；路由与绑定的 process 必须相同。 */
import { approval } from '@yss123/cage-kernel';
import { approver, gt, route, step, when } from '@yss123/cage-approval';
import {
  PurchaseOrder, OrderSubmitted, OrderCancelled, approve, reject,
} from './purchase-order.js';

/** 提交启动、取消撤回；只允许金额和部门字段用于流程路由。 */
export const poApproval = approval(PurchaseOrder, {
  process: 'po-approval',
  start: OrderSubmitted,
  cancelOn: [OrderCancelled],
  routable: ['amount', 'deptId'],
  onApproved: approve,
  onRejected: reject,
});

/** 先部门负责人；金额严格大于 50000 元时，增加财务角色的一人审批。 */
export const poRoute = route('po-approval', [
  step('部门经理审批', approver.deptLeader('deptId')),
  when(
    gt('amount', 50000),
    step('财务审批', approver.role('finance'), { mode: 'any' }),
  ),
]);
```

将这两个声明经模块入口从 domain 根入口导出，运行 `pnpm exec cage check` 和 `pnpm gen`，审查迁移后执行 `pnpm migrate`。启动 API/worker，在系统管理中配置真实部门负责人、角色与命令权限；通过提交命令触发业务事件后，从 `/admin/` 的审批待办处理。

`routable` 是允许路由读取的字段清单，不是权限列表。被流程选为审批人也必须具备实际结论命令能力、数据范围及额度，并满足职责分离；路由选人不会自动授予这些权限。

## 主要入口

| 入口 | 用途 |
| --- | --- |
| `route`、`step`、`when` | 声明步骤和条件；顺序执行，条件只读取允许路由的字段 |
| `approver` | 角色、部门负责人等选人规则 |
| `gt/gte/lt/lte/eq/ne/isIn` | 可被分析的条件表达式 |
| `InCodeEngine`、`TaskView` | 内置流程执行器及待办视图，通常由 HTTP/worker 装配 |
| `bindApproval`、`applyOutcome` | 适配器把审批结论桥接回领域命令 |
| `ApprovalAdapter` 等适配类型 | 对接外部审批实现时遵守的生命周期协议 |
| `approvalRoutes` | 受认证保护的 HTTP 审批接口装配 |
| `AiStepOptions`、`approvalRoleContext` | AI 节点配置与自动执行角色上下文 |
| `TaskActionPolicy`、`TaskActionInput`、`InCodeEngine.act` | 人工节点显式开放转办、委派归还、当前节点并行必签；版本与操作记录共同提交 |
| `InCodeEngine.taskHistory` | 当前单据授权读者按游标读取人工操作记录 |
| `approvalOperations()` | 显式启用框架持久站内提醒、申请人催办与已读，复用现有 worker |

领域绑定原语 `approval()` 从 `@yss123/cage-kernel` 导入；不要与本包的路由原语混淆。

AI 审批使用同一个 `step` 的 `kind: 'ai'` 选项，配置模型、材料范围、策略、handoff 和预算；结果为 `pass/return/manual`。需要 domain 启用 `@yss123/cage-ai`，退回需声明 `onReturned`，自动结论需显式配置 `automatedBy` 对应角色权限。模型失败不会被当成自动批准。

## 文档

人工节点可设置 `actions: { transfer: true, delegate: true, addSign: true }`，默认关闭并随流程实例保存。
委派未归还不能批准；前、后及并行加签在 any/all 模式下都必须全部通过。候选任务先领取再决定，任务操作及启用候选/流转节点的决定须携带 revision。
不能把任务管理理解为授予角色能力。升级需执行追加系统迁移，旧实例保持原政策。

通用时效通过 `export const approvalOps = approvalOperations()` 启用。人工 `step` 配置 `sla: { durationMinutes: 1440, remindBeforeMinutes: 60 }`，
`route` 第三参配置 `reminders: { requesterField: 'createdBy', cooldownMinutes: 15 }`，申请人字段必须进入 `approval.routable`。
框架负责持久提醒、去重、当前接收人授权、冷却和已读；Admin 提供“我的申请”和“流程提醒”，业务应用无需自行实现通知表或定时器。
节点时限采用自然分钟，加签、转办和领取不重置；尚无工作日历、自动升级、外部通知、并行网关或流程设计器。

- [人工审批任务流转、SDK 与边界](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/approvals.md)
- [标准采购审批链路](https://github.com/shunshunyue/cage/blob/main/docs/development/examples/purchase-example.md)
- [AI 审批三态、转人工和授权](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md)
- [采购审批完整源码](https://github.com/shunshunyue/cage/blob/main/examples/purchase-admin/packages/domain/src/modules/purchase/approvals.ts)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
