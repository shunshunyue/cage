# @yss123/cage-kernel

Cage 的领域声明和执行核心：聚合、命令、读取、状态、范围、事务、审计、事件与 worker。普通业务通过这些声明表达规则，由内核统一提交变化。

## 安装与最小声明

在 domain 包安装 pnpm add @yss123/cage-kernel zod，框架包保持同版本，服务端需要 Node.js 24+ 和 PostgreSQL。下面是领域模块片段：

```ts
import { aggregate, command, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/** 部门便笺的身份、标题和生命周期；实际范围由角色授权决定。 */
export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120).describe('标题'),
    deptId: ref('Dept').describe('部门'),
    createdBy: ref('User').describe('创建人'),
  },
  states: states('active', { terminal: ['active'], labels: { active: '已创建' } }),
  scope: scope.dept('deptId'),
});

/** 创建有效便笺；持久化、归属、权限和审计由内核处理。 */
export const createNote = command(Note, {
  name: 'create', description: '创建便笺', from: 'new', to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  handler: draft => draft,
});
```

沿模块入口导出到 domain，保留组织模型，执行 check/gen、审查迁移并 migrate。角色获得 Note.read/create 及相应范围后，页面使用生成契约。

## 使用边界

handler 的依赖写入 reads，任务调用写入 reads/calls；数据库、网络和文件 IO 由框架对应层执行。from/to 控制状态，约束在 handler 前检查，不变量检查最终对象，same 反应共同回滚。

服务集成使用 createKernel/buildRegistry/ReadSide，数据库与 worker 另有 /db、/worker 子入口。浏览器使用 client 和 contracts。金额用十进制字符串，系统列由内核维护。

[完整入门课](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/first-feature.md) · [原语参考](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/primitives.md) · [执行边界](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/execution.md)
