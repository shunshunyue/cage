# CAGE-APPR-007：找不到审批人

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：声明、图规则或 worker。

worker 启动或推进审批步骤时选人器没有找到人，或字段选人/候选节点中存在非当前租户启用账号。

## 修复步骤

1. 先看本项目 approvals.ts：deptLeader 读取单据部门的负责人；role 使用角色 code；user 使用实际用户 UUID。
2. 在 /admin 设置单据所属部门的负责人，或创建对应 code 的角色并分配实际用户。给用户经理角色，并不等于设置了部门负责人。
3. field 使用提交时保存的 routable 人员字段；检查 UUID 对应账号是否全部在当前租户且 active。不能删掉不合格人员后默认为审批通过；字段快照错误需按业务撤回/重提修正。
4. 再核对审批人的结论能力、数据范围、ceiling 额度和职责分离。选中审批人不等于允许完成审批。
5. 若 OrderSubmitted 已入死信，修复后在 /admin 按 outboxId 重放，确认待办生成；原提交已成功时不重复提交或 SQL 改回草稿。

## 正例

```text
deptLeader('deptId')：给该部门设置负责人；role('finance')：给实际用户分配 code=finance 的角色
```

## 反例

```text
只建中文名为“财务”的角色却没有配置 code/用户，或配置后重复提交已是 pending_approval 的单据
```

## 修复后验证

先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

- `packages/approval/src/engine.ts:87`
- `packages/approval/src/engine.ts:94`

实现片段（位置随框架版本更新）：

```ts
    if (who.length === 0) {
      throw new Error(`[CAGE-APPR-007] 流程 ${this.route.process} 第 ${index + 1} 步「${title}」找不到审批人，请在 /admin 配置部门负责人或角色`);
    }
    if (selector.kind === 'field' || assignment === 'candidate') {
      // 新字段/候选声明不允许创建指向停用或其他租户账号的票；整批拒绝，不静默减少会签人数。
```
