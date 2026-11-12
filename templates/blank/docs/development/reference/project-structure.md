# 代码放在哪里，模块怎样合作

本规范适用于两套脚手架及独立业务项目。目录先表达业务归属，再表达页面、组件或查询等职责。小模块可以从一个文件开始，在出现独立职责时再拆分。

## 应用的四个部分

```text
packages/domain/src/
  index.ts                 所有注册声明的组合入口
  modules/<业务>/          聚合、命令、事件、审批、查询和任务
  workflows/               跨业务模块的反应与阅读流程
  integrations/            第三方协议和可选运行时声明
  shared/                  跨领域模块的纯值和校验

packages/contracts/src/   cage gen 维护，根 index 为公共 API
apps/api/src/             API 与 worker 薄启动入口
apps/web/src/
  main.tsx                 挂载 React 与全局 Provider
  app/                     会话、布局、路由与模块组合
  modules/<业务>/          页面、组件、专用 hooks/API
  shared/                  被多个模块复用的 UI 与纯工具

db/migrations/             审查过的结构迁移
```

domain 定义行为，contracts 连接前后端，Web 负责交互，API/worker 装配框架。业务通常不需要新增 controller/service/repository。

## 模块公开入口

每个业务模块的 index.ts 只导出需要被组合的声明或页面。domain 模块逐层导出到根入口，Web 模块由 app 导入；深层内部文件保持模块内部使用。

多个领域模块的导出名必须兼容：例如分别使用 createNote、createRequest，并在 command.name 中保留 create 能力名。根入口只组合，避免重名 export * 遮蔽声明。

例如便笺模块有基础读写、评论和成员命令，packages/domain/src/modules/note/index.ts 组合：

<!-- cage:example note-module-exports -->
```ts
export * from './note.js';
export * from './queries.js';
export * from './note-comments.js';
export * from './note-members.js';
```

domain/src/index.ts 保留已有组织及业务导出，再追加 export * from './modules/note/index.js'。Web 的模块入口使用同样的组合职责，例如：

<!-- cage:example note-web-exports -->
```ts
export { NotesPage } from './pages/notes-page';
export { NoteDetailPage } from './pages/note-detail-page';
export { NotesTablePage } from './pages/notes-table-page';
```

app/app.tsx 从 ../modules/note 导入页面；便笺模块内部从 @app/contracts 读取对象方法，不反向导入 app 或 domain。没有评论、查询或表格页面的项目只导出自己实际存在的文件。

页面、组件、专用 hooks、api 与样式放所属模块；目录只在确实需要时创建。测试与被测业务相邻，使用 *.test.ts(x)。全局主题和基础布局放 app，专用样式就近维护。

## 依赖方向

| 来源 | 可依赖 |
| --- | --- |
| Web main | app、Provider 和共享基础 |
| Web app | 模块公开入口、shared、布局 |
| Web module | 自身、shared、contracts、client |
| Web shared | 通用库、shared 和通用协议类型 |
| Domain module | 自身、其他领域模块公开声明、纯 shared、框架声明 API |
| Domain workflows | 各领域公开声明、纯 shared、reaction 等 |
| Domain integrations | 各领域公开声明、纯 shared、连接器或运行时声明 |
| Domain shared | 纯业务值与校验 |

Web module 不依赖其他前端模块或 app，Web 不导入 domain/数据库/内核运行时。领域 module 不反向依赖 workflows、integrations 或 domain 总入口。domain 不依赖 contracts，避免生成循环。

共享目录不能成为规避模块边界的容器。某个任务要组合两边时，由 workflows 或 app 承担组合职责。

## 生成物和资料

contracts 按聚合生成，根 @app/contracts 是稳定公开入口；手写业务不穿透其内部目录。迁移和契约需要审查，生成变更通过 gen 更新；有生成签名的陈旧契约由生成器清理，手写文件保留。

空白模板真实领域只有组织基础，采购参考在 docs/examples/purchase-admin，未参与注册和编译。采购模板直接包含业务源码。教材命令默认相对真实应用根目录。

## 门禁与整理

模板使用 structure: 'modular'。CAGE-STRUCT-001 检查 src 根入口布局，CAGE-STRUCT-002 检查模块依赖和公开入口；相对路径、别名和转导出参与解析。类型声明及相邻测试按规则豁免。

整理已有项目先移动文件、改导入、保留公开 API，再运行类型、check、gen 和生成一致性。目录移动一般不改变结构；意外出现迁移时核对原因。CLI 升级不自动搬动客户源码，保持门禁有效。

所有手写源码同步遵守[中文注释规范](commenting.md)，脚本使用 TypeScript。目录表明归属，注释负责解释职责、流程与实际保证。

[返回开发手册](../README.md)
