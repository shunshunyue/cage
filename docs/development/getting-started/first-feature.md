# 完成便笺的创建、读取、修改与归档

本课在一个已能登录的应用中增加“部门便笺”。最终有列表 /notes 和详情 /notes/:id：创建后能刷新读取，修改会检查版本，归档后保留记录并停止编辑。

前提：已完成[启动应用](start.md)。教学源码在[领域声明](../examples/note/note.ts)、[列表页面](../examples/note/notes-page.tsx)和[详情页面](../examples/note/note-detail-page.tsx)。下面说明每个文件在整条链路中起什么作用。

## 1. 把对象和规则写在一起

便笺有标题、部门、创建人，状态为 active 或 archived。标题不能为空；归档后不能编辑。将完整领域文件放到 packages/domain/src/modules/note/note.ts，其中聚合的核心是：

```ts
export const Note = aggregate('Note', {
  description: '部门便笺',
  fields: {
    title: text(120).describe('便笺标题'),
    deptId: ref('Dept').describe('所属部门'),
    createdBy: ref('User').describe('创建人'),
  },
  states: states('active', 'archived', {
    terminal: ['archived'],
    labels: { active: '使用中', archived: '已归档' },
  }),
  scope: scope.deptSubtree('deptId'),
  invariants: { titleNotBlank: record => record.title.trim().length > 0 },
});
```

这段是完整文件中的聚合摘录；import 与命令均在源码中。title 的长度属于字段规则，非空属于最终结果必须满足的不变量。deptId 与 createdBy 提供授权使用的归属信息，实际可见范围由角色配置。

三个命令分别表达三件事：

| 命令 | 起点 → 终点 | 输入与变化 |
| --- | --- | --- |
| createNote，name 为 create | new → active | 标题经 trim、长度与非空校验，返回草稿 |
| updateNote，name 为 update | active → 保持原状态 | id 定位对象，返回新的 title |
| archiveNote，name 为 archive | active → archived | 默认 id 输入，保留字段 |

例如创建命令是：

```ts
export const createNote = command(Note, {
  name: 'create',
  description: '创建便笺',
  from: 'new',
  to: 'active',
  input: z.object({ title: z.string().trim().min(1).max(120) }),
  handler: draft => draft,
});
```

创建人由内核按主体设置，缺省部门按当前主体填写；创建后的记录还要通过范围检查。update 使用 to: null，仍只允许 active，因此 archived 记录无法通过该命令修改。

## 2. 导出后才会被识别

模块 packages/domain/src/modules/note/index.ts 导出领域文件：

```ts
export * from './note.js';
```

在已有 domain 根入口追加模块导出，保留组织模型和原有业务：

```ts
export * from './modules/note/index.js';
```

在应用根目录执行：

```powershell
pnpm exec cage check
pnpm gen
```

应出现 Note 的图节点、契约与迁移草稿。命令能力名是 Note.create、Note.update、Note.archive，读取能力是 Note.read；createNote 是源码导出名，name 决定最终命令名。

审查新迁移后运行 pnpm migrate，再重启加载了新 domain 的 API 和 worker。已有迁移继续保留。

## 3. 给真实用户授权

在独立验收环境准备创建者、同部门另一人、其他部门用户。通过系统管理为相关角色授予 Note.read 及所需命令能力；本课选择 Note 的部门范围。创建者所在部门必须已经配置。

声明 scope.deptSubtree 并不会自动授予部门及下级范围；角色的实际授权才决定可见性。验证普通账号，才能观察是否符合本课的部门规则。完整语义见[权限参考](../reference/authorization.md)。

## 4. 让列表和详情消费契约

将两个教学页面放入 apps/web/src/modules/note/pages，再从模块 index.ts 导出：

```ts
export { NotesPage } from './pages/notes-page';
export { NoteDetailPage } from './pages/note-detail-page';
```

列表使用 useNoteList 读取，提交调用 note.create({ title })。只有 result.ok 为 true 才清空输入并重新查询；失败保留输入。详情从 URL 取得 id，再用 useNote 独立读取，写入时传当前服务端 version：

```ts
await note.update(record.id, { title }, record.version);
await note.archive(record.id, record.version);
```

这两行展示方法形状，真实页面还检查结果、控制提交状态和处理 CONFLICT。冲突后刷新并让用户核对草稿，不自动覆盖新值；NOT_FOUND 表示不可读取，不能据此断言记录已删除。

## 5. 接到已有路由

在 app 路由组合层导入模块入口，在登录后的 Outlet 中加入：

```tsx
<Route path="notes" element={<RequireCapability capability="Note.read" home="/workspace"><NotesPage /></RequireCapability>} />
<Route path="notes/:id" element={<RequireCapability capability="Note.read" home="/workspace"><NoteDetailPage /></RequireCapability>} />
```

Route、RequireCapability 和页面组件从当前应用真实入口导入。菜单用 Link 指向 /notes，沿用应用的会话恢复、查询缓存清理及 404。两个页面通过 URL 连接，详情不依赖列表内存中的选中项。

教学组件用简单控件突出数据链路；正式业务按[前端组件指南](../guides/frontend-ui.md)组合界面，导航要求见[路由指南](../guides/routing.md)。

## 6. 用实际操作证明完成

| 操作 | 应看到什么 |
| --- | --- |
| 创建一条便笺，再刷新列表 | 同一条服务端记录仍在，标题正确 |
| 新标签页打开详情 | 通过 URL 独立加载同一 id |
| 同部门有权用户直接请求详情 | 能读取同一记录 |
| 范围外用户直接请求详情 | 服务端拒绝或返回不可见 |
| 两个页面以同一旧版本修改 | 后提交的页面得到冲突 |
| 归档后再次发修改请求 | 状态拒绝，记录仍为 archived |
| 提交失败 | 保留输入并显示可处理的原因 |

再运行相关类型检查、构建和生成一致性检查。教程编译检查不连接数据库；没有完成实际账号和浏览器操作时，明确列为未执行。

现在已经走通“声明 → 导出 → 生成 → 迁移与授权 → 契约 → 页面 → 独立读取”。真实业务替换对象与规则，并按需要加入[关系](../guides/relations.md)、[审批](../guides/approvals.md)或[事件联动](../guides/automation.md)。

[日常开发步骤](workflow.md) · [返回开发手册](../README.md)
