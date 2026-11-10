# 工程目录与代码组织

本规范针对 create-cage-app 生成的业务项目。目录首先表达业务归属，其次才是页面、组件、hooks 等技术用途。新增报销功能时，应在报销模块内找到它的页面和表单，而不是在整个 src 中搜索一批散落文件。

两种模板使用同一规则：采购模板提供完整业务，空白模板保留认证和工作台。不要为小功能创建空目录；文件确实承担独立职责时再拆分。

目录表达代码归属，[详细中文注释规范](commenting.md)说明每个文件及接口如何被理解和使用。框架与脚手架应用的新建、修改源码都必须执行这份规范，职责说明和实现一起交付。

## 项目分工

```text
项目根目录/
├─ apps/
│  ├─ api/src/
│  │  ├─ main.ts                  # 启动 HTTP，装配 domain，处理退出
│  │  └─ worker.ts                # 启动异步任务，按环境装配连接器 fake
│  └─ web/src/
│     ├─ main.tsx                 # 挂载 React、全局 Provider 和样式
│     ├─ app/                     # 会话恢复、URL 路由、布局、模块组合
│     │  ├─ app.tsx
│     │  ├─ use-session.ts        # 会话恢复和 401 回跳，不把网络故障当成未登录
│     │  ├─ workspace-layout.tsx
│     │  └─ styles/global.css
│     ├─ modules/                 # 按业务命名，一个模块内管理它的页面和交互
│     │  ├─ auth/
│     │  │  ├─ index.ts
│     │  │  └─ pages/login-page.tsx
│     │  └─ purchase/
│     │     ├─ index.ts           # 模块对应用壳公开的入口
│     │     ├─ pages/purchase-orders-page.tsx
│     │     └─ components/purchase-order-form.tsx
│     └─ shared/                  # 已被复用、与具体业务无关的前端代码
│        ├─ ui/                   # 提示容器等通用组件
│        ├─ hooks/                # 通用交互 hooks
│        └─ lib/                  # 格式化、通用错误展示等纯辅助函数
├─ packages/
│  ├─ domain/src/
│  │  ├─ index.ts                 # 全部声明的统一导出，仅负责注册组合
│  │  ├─ modules/
│  │  │  ├─ purchase/
│  │  │  │  ├─ index.ts
│  │  │  │  ├─ purchase-order.ts   # 聚合、状态、事件、命令
│  │  │  │  ├─ approvals.ts       # 本业务审批绑定和代码路由
│  │  │  │  ├─ queries.ts         # 本业务自定义安全查询
│  │  │  │  ├─ jobs.ts            # 本业务定时任务
│  │  │  │  └─ purchase-order.test.ts
│  │  │  └─ inventory/
│  │  │     ├─ index.ts
│  │  │     └─ inventory.ts
│  │  ├─ workflows/               # 跨模块事件反应，例如采购通过后锁库存
│  │  │  └─ purchase-inventory.ts
│  │  ├─ integrations/            # 第三方协议、出站映射和入站验签声明
│  │  │  └─ erp.ts
│  │  └─ shared/                  # 按需创建：跨领域模块的纯校验或业务值定义
│  └─ contracts/src/              # 全部由 cage gen 维护
│     ├─ index.ts                 # @app/contracts 统一公共入口
│     ├─ aggregates/
│     │  ├─ purchase-order/index.ts
│     │  ├─ inventory/index.ts
│     │  └─ user/index.ts
│     └─ queries/index.ts
├─ db/migrations/
└─ docs/development/、docs/errors/
```

树中的采购文件可在采购模板中运行；空白模板把它们作为离线参考放在 `docs/examples/purchase-admin`，真实源码只有认证、工作台和组织模型。空白项目没有需要用到的目录可以不创建。

## 新需求具体写到哪里

以“报销单列表、新建报销、经理审批”为例：

1. 在 `packages/domain/src/modules/expense/expense.ts` 声明 Expense、状态、事件和命令；小模块可先放在这个文件，不强制把每条命令拆成一个文件。
2. 审批声明放同模块 `approvals.ts`；查询、定时任务有实际需求再增加 `queries.ts`、`jobs.ts`。通过模块 `index.ts` 导出，再从 domain 根入口转导出。导出名全局唯一，命令重名时用显式 `name` 保留能力点语义。
3. 需要驱动其他模块时，把 reaction 放在 `workflows/expense-xxx.ts`，从双方模块公开入口取声明。第三方接口放 `integrations/<系统名>.ts`，声明 hosts、schema、secret 名、outbound/inbound，不直接发网络请求。
4. 运行 `pnpm gen`，审查 `contracts/src/aggregates/expense/index.ts` 和迁移草稿。根 `@app/contracts` 自动导出 Expense API/类型。不要在 contracts 里手工建“报销 service”。
5. 在 `apps/web/src/modules/expense/pages/expense-list-page.tsx` 使用生成 hooks。新建表单放该模块 `components/expense-form.tsx`，模块专用 hooks 放自己的 `hooks`，专用接口封装按需放自己的 `api`，专用常量留在模块内。
6. 从前端模块 `index.ts` 导出页面，应用壳从 `../modules/expense` 引入并注册列表、详情 URL，通过 Outlet 放入工作台布局。导航用 Link/NavLink，筛选和分页用 useSearchParams；弹窗和提交状态留在页面，不把整个页面切换写成 useState。按[路由指南](../guides/routing.md)验收深链接、刷新、前进后退和登录回跳。

前后端可以有相同的业务模块名，但文件不混放：领域定义授权和行为，前端管理交互，通过生成契约连接。API 启动入口维持薄壳，普通业务无需新增 controller/service/repository。

## 依赖方向与模块入口

| 来源 | 可以依赖 | 不应依赖 |
| --- | --- | --- |
| Web `main.tsx` | app、共享基础设施、框架前端 Provider | 各项业务页面与表单 |
| Web `app` | 模块公开入口、shared、应用内部布局 | 模块内部表单/hooks 文件 |
| Web `modules/<业务>` | 自己的内部文件、shared、contracts/client | 其他前端模块、app、domain/数据库包 |
| Web `shared` | shared 内部文件、通用前端库与通用 client 类型 | app、具体业务模块 |
| Domain `modules/<业务>` | 自己内部文件、其他领域模块的公开声明、纯 shared、框架声明 API | workflows、integrations、domain 总入口、IO、contracts |
| Domain `workflows` | 领域模块公开声明、纯 shared、框架 reaction API | HTTP 实现、页面、数据库写入 |
| Domain `integrations` | 领域模块公开声明、纯 shared、连接器 API | workflows、HTTP 实现、直接网络请求 |
| Domain `shared` | 纯 shared、基础值/校验库 | 具体模块和组合层、IO |

前端两项业务需要一起展示时，由 app 同时取它们的公开组件/hooks，通过 props 和回调传数据。采购页的“我的待办”数量就是由应用壳传入的，不让采购模块导入审批页面。遇到真实复用的业务组件，先明确归属和输入输出，不把整页挪到 shared 来绕过边界。

领域模块允许单向业务依赖，例如采购审核声明 `reads: { stock: Inventory }`，通过 `../inventory/index.js` 导入。不要从 domain 总入口反向导入，否则容易形成循环注册。双向依赖优先改为 workflows 组合或共享值，不用层层转导出掩盖循环。

`index.ts` 只列出对外导出。禁止把模块的全部内部实现都公开来规避边界；不在 index 中启动服务、读环境变量或初始化业务。

## 什么放 shared

一个辅助函数只被报销使用，就先留在报销模块。多个模块实际复用、且没有绑定某项业务时，再移到 shared。例如通用提示容器、命令结果反馈 hook、金额格式化可以共享；报销状态文案、采购请求、审批选人规则属于各自模块。

不要新增包罗万象的 `utils.ts`、`common.tsx`、`lists.tsx`、`api.ts` 收集所有业务。用能说明职责的文件名，例如 `error-message.ts`、`purchase-order-form.tsx`、`use-approval-tasks.ts`。

## 命名、文件与注释

- 目录和源码文件用 `kebab-case`；React 组件/类型用 `PascalCase`，函数、变量与 hook 用 `camelCase`，hook 以 `use` 开头。聚合、命令、事件名是稳定的业务标识，目录改名不顺便改能力点、API 或表名。
- 页面放 `pages/*-page.tsx`，模块专用组件放 `components`，专用 hooks 放 `hooks`。小模块只有一个页面时可以直接 `modules/<业务>/<业务>-page.tsx` 并配公开 index；不强制创建所有子目录。
- 入口只挂载或组合；页面主要描述页面流程。表单、表格或交互已承担独立职责时再抽取，避免一个大组件处理所有业务，也避免每个按钮都新建文件。
- 全局主题、reset、基础布局放 `app/styles`；业务专用样式与组件就近放置，可用 CSS Modules。不要把所有新增业务样式长期追加进一个全局文件。当前范例保留既有全局主题，结构调整不重新设计界面。
- 单测与被测代码相邻，使用 `*.test.ts(x)`。需要真实业务链路的集成用例与所属业务模块相邻；框架的测试发现递归查找，不必为它回到 src 根目录。
- 新建和修改的手写源码文件必须有中文职责、主要调用链与运行边界说明；模块入口也要说明公开职责。导出函数/类/声明、React 组件/hooks、接口及类型字段使用中文 JSDoc，复杂私有函数与关键分支解释具体步骤、原因和边界，详细要求见[注释规范](commenting.md)。
- 业务字段说明单位、格式、空值与来源；命令说明输入、权限、状态、读依赖、事件、事务与失败行为；页面说明 URL、数据加载、权限和错误交互；测试说明意图与覆盖边界；脚本说明前置条件、写入/覆盖等副作用。修改已有代码时同步补齐受影响的上下游注释，不能只更新当前实现。
- 注释必须准确、充分，不以“代码自解释”免除必要说明，不用每行语法翻译、注释字数或比例充数。生成注释从声明/生成器维护，已执行或已发布迁移不可因补注释而重写。不加无业务价值的防御分支和静默兜底；脚本使用 TypeScript，不新增 `.mjs`。

## 自动约束与整理已有项目

新模板在 `cage.config.json` 设置 `"structure": "modular"`。`pnpm exec cage check` 与 `pnpm verify` 自动检查：

- `CAGE-STRUCT-001`：domain src 根目录只保留领域入口，web src 根目录只保留 `main.tsx`；其他运行源码使用上述顶层目录。`*.d.ts` 类型声明与相邻测试不受入口限制。
- `CAGE-STRUCT-002`：阻止共享层反向依赖、前端模块直接互相导入、领域模块依赖流程/连接器、跨模块穿透内部文件。相对路径、tsconfig 别名和转导出都参与模块解析。

这些检查约束目录和可见导入，不能替代评审，也不按行数强制拆文件。通过错误码定位文件，再按职责整理，不要关闭门禁或把文件塞进 shared 来消除提示。框架已有的依赖门禁继续约束 IO、前端依赖和生成物边界。

已有项目可以先移动文件并修正导入，再启用该配置；CLI 升级不会自动搬动客户代码。生成契约布局由新版 `cage gen` 更新：保留 `@app/contracts` 公共 API，清理带 Cage 生成签名的过期文件，用户手写文件保留。不要依赖 contracts 内部路径导入。

目录调整后运行类型检查、`cage check`、`pnpm gen` 和生成一致性检查；有改动页面时检查相应操作。目录整理不应产生数据库结构变化，若出现迁移草稿应核实原因，已执行的迁移不要改写。
