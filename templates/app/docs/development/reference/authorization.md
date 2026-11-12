# 权限、数据范围与归属字段

授权需要同时回答：谁发起、能调用哪个动作、能触及哪些记录、是否满足本次业务条件。角色名称、页面门户和审批选人都只能回答其中的一部分。

## 一次操作检查哪些层

| 层 | 作用 |
| --- | --- |
| 登录与租户 | 确定真实账号和租户上下文 |
| 调用身份 | user、process、job、external；内部专用命令没有普通浏览器写接口 |
| 能力 | Aggregate.read、Aggregate.command，以及 export/unmask 等 |
| 数据范围 | 本人、部门、部门及下级、指定部门、全部 |
| 约束与状态 | 职责分离、二次认证、from、版本、业务条件 |
| 呈现 | hidden 排除字段，sensitive 按能力掩码 |

前端 can/useCan 用于显示；直接发请求仍经过服务端检查。process 不是角色，审批人被选中后也仍需要相应业务能力与范围。

例如按钮只看当前显示能力，但提交仍走真正的归档请求；绕过按钮发相同请求也会执行服务端权限检查：

<!-- cage:check web authorization-button -->
```tsx
export function ArchiveButton({ record }: { record: Note }) {
  const allowed = useCan('Note.archive');
  if (!allowed) return null;
  return <button onClick={() => void note.archive(record.id, record.version)}>归档</button>;
}
```

这段只演示能力显示，正式页面还需按客户端章节检查返回结果和提交状态。

## 声明归属

聚合的 scope 提供 deptField 和 ownerField 元数据，角色数据选择实际组合子。可用 scope.self、dept、deptSubtree、deptSet 或 scope.of({ dept, owner }) 表达字段位置；hint 只是声明建议。

例如各声明分别表达字段位置；第三行即使建议下级部门，角色仍可以实际只授本部门：

<!-- cage:check domain authorization-scope-metadata -->
```ts
export const ownerScope = scope.self('createdBy');
export const departmentScope = scope.dept('deptId');
export const subtreeScope = scope.deptSubtree('deptId');
export const selectedDepartments = scope.deptSet('deptId');
export const customOwnerScope = scope.of({ dept: 'deptId', owner: 'ownerId' });
```

聚合存在 createdBy 时自动识别为 ownerField；自定义所有者字段可通过 scope 指定。内核新建时以 actorUserId 设置所有者，后续命令不能改写。部门字段缺省取当前主体部门；显式输入和最终结果仍需满足创建范围。

scope.none() 没有提供部门元数据，也不关闭聚合对 createdBy 的自动识别。没有可用归属字段时，self 或 dept 等范围无法匹配记录；有相应 all 授权才能访问。scope.all() 同样只是元数据，不能自行授予全部可见。

例如字段里仍有 createdBy = 甲，即使 scope.none()，self 仍可按甲匹配；若对象既没有所有者又没有部门，给角色 self 并不会因此得到全部记录。

公司、项目、团队等自定义字段并不会自动加入部门树范围算法。确认业务需要的隔离模型，再核对当前公开能力。

例如[便笺完整聚合](../examples/note/note.ts)已有 deptId 和 createdBy，使用 scope.deptSubtree('deptId')。测试账号的实际授权可以通过 testkit 表达；下面的完整辅助函数只用于独立测试环境，不是生产授权脚本：

<!-- cage:example dept-editor -->
```ts
import type { TestEnv } from '@yss123/cage-testkit';

/** 为测试创建只能读写本部门便笺的账号，部门 UUID 来自该测试环境真实创建的部门。 */
export async function createDeptEditor(test: TestEnv, deptId: string) {
  return test.user({
    caps: ['Note.read', 'Note.create', 'Note.update', 'Note.archive'],
    scopes: { Note: 'dept' },
    deptId,
  });
}
```

这里聚合具备部门字段，账号却只选择 dept，所以不自动包含下级部门。正式应用在系统管理中按真实角色分配相同含义的能力与范围。

## 把本次操作限制写进命令

审批课程使用下面的命令禁止申请人批准自己。ReviewRequest、command、sod 的完整定义和 import 见[部门申请源码](../examples/approval/review-request.ts)：

<!-- cage:example approve-review-request -->
```ts
export const approveReviewRequest = command(ReviewRequest, {
  name: 'approve', description: '批准部门申请', from: 'pending', to: 'approved',
  invokedBy: 'process', constraints: [sod.notSameAs('createdBy')],
  handler: draft => draft,
});
```

invokedBy 限定调用入口，sod 检查本次真人与创建人不同；审批人仍须具备结论能力和单据范围。流程选人不替代这两层判断。

## 角色授权怎样生效

普通角色显式获得目录中的能力与聚合范围，多角色能力和范围合并。显式聚合范围优先于通配范围；缺省或空范围回退到 self，有能力也不意味着能匹配任意记录。

self 比较当前用户或受托真人与 ownerField。dept 比较部门，deptSubtree 使用真实部门祖先路径，deptSet 使用授权部门集合；外层始终隔离租户。

例如对一条属于部门 A、创建人为甲的便笺，下面每个结果对应一种范围选择：

| 授权例子 | 能否匹配这条便笺 |
| --- | --- |
| 甲的 self | 能 |
| 同部门乙的 self | 不能，只是同部门还不够 |
| 同部门乙的 dept | 能 |
| A 上级部门的 deptSubtree | 能，前提是真实部门树包含 A |
| 其他部门的 deptSet，集合含 A | 能 |
| 另一租户的 all | 不能跨租户 |

多角色合并也按实际选择。例如一个角色授 self、另一个授本部门，用户可以读取本人和本部门的并集；显式 Note 范围不会被通配范围无条件替换。

首次 bootstrap 创建的超级管理员使用受控 * 标记，按当前目录展开能力与本租户全部范围。普通管理员不能创建该标记或接管超级管理员角色。既有显式授权角色不会因升级自动获得此标记；普通生产角色也不会自动得到新增命令。

前端切换门户或本地 role 变量不改变服务端身份。公开 SessionUser 只有约定字段，不能用类型断言假造角色列表。

## 敏感字段和读取

safe 视图根据会话落实范围与掩码，业务 query 也从这里读取。hidden 字段排除于普通公开 DTO；sensitive 的明文需 Aggregate.unmask.kind 等对应能力，潜在明文交付还需可靠审计。

字段组合可以这样声明，再放入相应 aggregate.fields。这里的 optional 明确允许 null；hidden 字段不进入普通公开 DTO：

<!-- cage:example protected-fields -->
```ts
import { text } from '@yss123/cage-kernel';

/** 联系方式按 phone 掩码；内部备注只供服务端规则使用，不通过普通读取交付。 */
export const protectedFields = {
  phone: text(32).optional().sensitive('phone').describe('联系电话'),
  internalMemo: text(500).optional().hidden().describe('内部备注'),
};
```

handler 的 reads 返回内部快照，用于业务判断；它与浏览器安全 DTO 不同。审批变量去除隐藏字段并掩码，具有明文能力也要经正式读取入口取得带审计的明文。

例如 phone 与 internalMemo 按上面的修饰符声明后，普通读取只交付脱敏 phone，internalMemo 不出现在 DTO。不能把 deps.users.get 返回的内部对象直接发送给浏览器来绕过这个边界。

范围外详情通常返回 NOT_FOUND，避免泄露对象存在性。页面应表达“无法读取”，保留不存在、会话失效和范围外等可能性。

## 用真实主体验证

准备允许、缺能力、同范围和范围外账号，分别直接调用读写接口。部门负责人、角色成员、账号 active 与单据归属都使用真实数据；菜单是否隐藏不能作为越权请求已被拒绝的证据。

例如在独立 testkit 环境先准备 noteId，再直接以缺能力账号调用，不经过前端按钮：

<!-- cage:check test authorization-denied-test -->
```ts
export async function checkArchiveDenied(test: TestEnv, noteId: string) {
  const actor = await test.actorWithout('Note.archive');
  const result = await test.callAs(actor, 'Note.archive', { id: noteId });
  expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' });
}
```

需要解释拒绝原因时，受权管理员使用 cage explain。它观察身份、输入、能力、范围、状态、版本和硬约束，不执行 handler，也不发出之后可复用的授权许可。

[执行与审计边界](execution.md) · [返回开发手册](../README.md)
