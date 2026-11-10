# 第一条完整业务链

[学习入口](../README.md) · [框架开发 Skill](../skills/cage-development/SKILL.md) · [原语参考](../reference/primitives.md)

本课教会你把声明、契约、页面和持久数据连接起来。以“部门便笺”解释方法：创建便笺、查看列表与详情、修改标题、归档。这个对象只用于教学；开发真实业务时替换对象含义和规则，不需要向用户项目添加便笺。

## 先确定业务，再选择声明

一条便笺有标题、所属部门和创建人，状态为 active 或 archived。创建、修改标题、归档都是命令；列表和详情使用生成的读取接口。标题不能为空是不变量，归档后不能修改由 update 的 from 表达。

归属字段使用 `deptId: ref('Dept')` 与 `createdBy: ref('User')`，内核新建时根据当前主体填写；`scope.deptSubtree('deptId')` 描述范围字段。实际授权仍由角色配置决定，普通用户不能通过提交任意部门 ID 把记录放进其他部门。公司、项目组等自定义归属不能仅改一个字段名字就假定沿用同样规则，应核对当前支持的范围模型。

完整领域代码见[便笺声明](../examples/note/note.ts)。依次阅读聚合、createNote、updateNote、archiveNote，注意命令导出名不同于 `name` 指定的能力名称。

## 让声明进入应用

把本课声明放入应用的 `packages/domain/src/modules/note/note.ts`，在模块 index.ts 导出它，再从 domain 总入口导出模块。保留原有组织模型及其他业务；不要让不同模块的 `export *` 带来重名导出。

在应用根目录执行：

```sh
pnpm exec cage check
pnpm gen
```

检查生成的 Note 契约、图节点、路由信息及迁移草稿。应能找到 `note.create`、`note.update`、`note.archive`、`note.list` 和 `note.get`。这里验证的是注册和生成；尚未证明数据库里有表或用户有权执行。

数据库初次准备按[开发步骤](workflow.md#第一次启动应用)进行；已有项目复用现有配置。审查新迁移后执行 `pnpm migrate`，再按当前环境启动/重启 API 与 worker。不要改已执行迁移，也不要为学习案例覆盖业务数据库配置。

## 给真实主体配置权限

在独立验收环境准备有能力的主体、同部门另一主体和范围外主体。为所需角色明确配置 `Note.read`、`Note.create`、`Note.update`、`Note.archive` 及对应数据范围。按业务分别选择本人、部门或部门及下级等范围；创建一个角色名称不会自动获得这些能力。

`scope.none()` 缺少部门/创建人范围表达，不能拿它替代“仅看本部门”。当前框架合并多角色能力与范围；只切换前端门户不会把后端权限自动缩减到所选角色。产品确需切换执行身份时，先确认当前公开协议是否支持该语义，不能通过本地 role 变量伪装授权。

## 页面调用真实契约

[列表与新建页面](../examples/note/notes-page.tsx)演示创建成功后重新读取服务端列表；[详情页面](../examples/note/note-detail-page.tsx)从 URL 读取 ID，直接加载服务端记录，修改和归档带上读取到的版本。它们是可编译的完整教学组件，样式由应用自行设计。

将组件放到 `apps/web/src/modules/note/pages`，从模块 index.ts 公开导出。再在已有 app 路由组合层导入模块入口，在登录后的 Outlet 内加入以下路由片段：

```tsx
<Route path="notes" element={<RequireCapability capability="Note.read" home="/workspace"><NotesPage /></RequireCapability>} />
<Route path="notes/:id" element={<RequireCapability capability="Note.read" home="/workspace"><NoteDetailPage /></RequireCapability>} />
```

片段中的 Route、RequireCapability 和两个页面要从当前应用真实入口导入；保留已有会话恢复、退出清理和 404。新增菜单使用 Link 指向 `/notes`。完整导航要求见[路由与浏览器验收](../guides/routing.md)。

创建按钮检查 `Note.create` 只是界面提示。提交后检查 `result.ok`，成功才清空输入并重新读取；失败展示错误并保留输入。详情请求可能返回范围外的 NOT_FOUND，不能显示“该记录已删除”这种未经证明的结论。编辑冲突后重新读取版本并让用户核对，不静默覆盖他人修改。

## 沿操作观察结果

| 操作 | 预期观察 | 若失败，优先检查 |
| --- | --- | --- |
| 有权用户创建便笺 | 真实请求成功，服务端返回 ID，独立 list/get 可读 | 契约调用、迁移、能力与归属字段 |
| 新标签页打开详情 URL | 重新请求后显示同一条记录 | URL ID、会话恢复、读取范围 |
| 另一位有同部门范围的用户查看 | 服务端读取同一条记录 | 实际部门、角色范围、接口结果 |
| 范围外主体直接请求详情 | 请求拒绝或安全地返回不可见 | 服务端范围，不能只看菜单是否隐藏 |
| 两个页面使用同一旧版本修改 | 后一次得到冲突，不覆盖新值 | expectedVersion 和页面刷新策略 |
| 归档后再次修改 | 业务状态拒绝；页面重新读取为 archived | from/to 与真实状态 |

运行受影响包的类型检查和构建、生成一致性与必要业务测试，再按浏览器配方操作。未配置测试账号、未连接独立测试库或没有浏览器能力时，写清未执行项；不要用编译通过替代本表结果。

## 从本课迁移到其他业务

先替换对象、字段、归属与动作，保留“声明 → 导出 → 生成 → 运行配置 → 契约 → 观察结果”的方法。只有需求需要时再增加能力：审批学习[审批单元](../guides/approvals.md)，附件学习[文件单元](../guides/files.md)，关联学习[关系单元](../guides/relations.md)，跨对象联动参考[事务选择](architecture.md#同事务与异步的选择)。完整组合范例见[采购导读](../examples/purchase-example.md)，无需一次复制全部采购实现。
