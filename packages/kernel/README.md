# @yss123/cage-kernel

Cage 的服务端内核：用 TypeScript 声明业务对象、状态、命令和事件，再统一执行权限、数据范围、版本、事务、审计与异步消息。适合有审批、组织权限和跨对象业务规则的中后台；它不是浏览器库，也不是绕过业务规则的通用表 CRUD。

## 安装与位置

需要 Node.js 24+、PostgreSQL；框架包应使用同一版本。在应用的 domain 包中安装：

```powershell
pnpm add @yss123/cage-kernel zod
```

新项目推荐 `pnpm create @yss123/cage-app my-app --template blank`，由模板配置 domain、API、worker、Web 与数据库连接。

## 最小业务声明

在 `packages/domain/src/modules/note/note.ts` 中声明便笺。声明本身不连接数据库；handler 返回业务变化，由内核负责真正写入。

```ts
/** 部门便笺声明；经 domain 根入口注册，供 CLI 生成契约与 API 执行。 */
import { aggregate, command, ref, scope, states, text } from '@yss123/cage-kernel';
import { z } from 'zod';

/** 同部门范围的便笺；归属字段由内核依据当前主体补入，角色仍须显式授权。 */
export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120),
    deptId: ref('Dept'),
    createdBy: ref('User'),
  },
  states: states('active', 'archived', { terminal: ['archived'] }),
  scope: scope.deptSubtree('deptId'),
  invariants: { titleNotBlank: (note) => note.title.trim().length > 0 },
});

/** 创建有效便笺；输入规范化后进入草稿，权限、范围及最终不变量失败均不会提交。 */
export const createNote = command(Note, {
  name: 'create',
  description: '创建部门便笺',
  from: 'new',
  to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  handler: (draft) => draft,
});
```

模块入口导出 `export * from './note.js';`，domain 根入口保留组织模型并导出新模块：

```ts
/** 组合所有可注册声明；未从这里导出的业务不会进入生成器和运行注册表。 */
export * from '@yss123/cage-admin/domain';
export * from './modules/note/index.js';
```

随后在应用根目录执行 `pnpm exec cage check`、`pnpm gen`；审查迁移后执行 `pnpm migrate`。管理员为目标角色授予 `Note.create`、`Note.read` 及 `Note` 数据范围，前端通过生成的 `@app/contracts` 调用 `note.create({ title })`、`note.list()`。

## 主要能力与边界

| 入口 | 用途 |
| --- | --- |
| `aggregate`、字段工厂、`states`、`scope` | 定义对象字段、关系、生命周期与范围字段 |
| `command`、`event`、`emit` | 定义唯一业务写入口及成功后产生的事实 |
| `reaction`、`reactionEach`、`job` | 同事务或异步协作、有界集合处理和定时任务 |
| `query`、`ReadSide` | 通过只读账号与 `safe.*` 安全视图读取 |
| `buildRegistry`、`createKernel` | 服务端集成时构建注册表和执行内核；普通应用交给 HTTP 装配 |
| `@yss123/cage-kernel/worker` | 底层 worker 启停、消费者和健康状态 |
| `@yss123/cage-kernel/db` | 迁移、DDL 与数据库基础设施，供工具链使用 |
| `@yss123/cage-kernel/brands` | 框架声明标识 |

handler 的读取写入 `reads`，任务的读取和命令调用写入 `reads/calls`。handler 不直接执行 SQL、HTTP 或文件 IO；外呼使用连接器。`scope` 声明不自动授权，前端 `can()` 不代替后端检查。`ref/hasMany/manyToMany` 统一写在 `fields`，集合关系由命令修改并通过安全读侧分页读取。

金额 `money()` 使用十进制字符串；不要重复定义框架的 `id/version/status/createdAt/updatedAt/tenantId`。新结构用新迁移表达，服务启动不自动建库、迁移或初始化账号。

## 继续阅读

- [架构与执行模型](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/architecture.md)
- [原语、命令与查询](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/primitives.md)
- [对象关系](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/relations.md)

脚手架项目自带 `docs/development` 与 `docs/errors`，可离线学习。源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
