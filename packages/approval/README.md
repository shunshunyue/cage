# @yss123/cage-approval

提供代码审批路由、待办与结论桥接。支持顺序、条件、结构化 AND 并行、字段选人、候选领取、委派/转办、前后/并行必签及站内时效运营。

## 接入现有业务

在 domain 安装 pnpm add @yss123/cage-approval @yss123/cage-kernel。领域先提供提交事件和 process 结论，再使用 kernel 的 approval 绑定，并导出本包 route：

```ts
import { approver, route, step } from '@yss123/cage-approval';

/** 与同名 approval 配合，由真实部门字段选择负责人；不在声明时创建人员或授予能力。 */
export const requestRoute = route('department-request', [
  step('部门审核', approver.deptLeader('deptId')),
]);
```

deptId 进入 binding.routable，开始/取消事件和结论命令从 domain 一起导出。迁移后运行 API/worker，配置实际负责人、结论能力和单据范围。页面通过当前任务 revision 决定，最后由领域命令保存结果。

## 高级能力与边界

parallel/branch 创建 AND 分支，节点内 any/all 和 addSign 是不同层。assignment/actions 在实例启动时保存，代码更新不改旧实例；结构化路由不等于任意 BPMN 图或在途迁移。

approvalOperations 启用自然分钟 SLA、站内提醒和申请人催办。AI 使用 step 的 kind: 'ai' 重载并另启 ai 运行时。无选人或执行失败不能自动当作通过。

[完整审批课程](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/approvals.md) · [参数、任务和时效](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/approval.md)
