# 采购工作台

这是可启动的标准范例：组织管理、采购单、审批待办、库存台账、库存锁生命周期和 ERP 出入站映射。

## 让 AI 在本项目开发业务

把本目录交给 Codex 等编程工具时，先让它读 [AGENTS.md](AGENTS.md)，再按[业务开发指南](../../docs/development/README.md)和[任务配方](../../docs/development/guides/recipes.md)实现需求。普通业务不需要修改框架源码。

[采购全链路导读](../../docs/development/examples/purchase-example.md)说明每个文件和异步步骤；[原语与最小业务](../../docs/development/reference/primitives.md)提供可添加的普通管理对象；[错误码册](../../docs/errors/README.md)用于按码修复。脚手架会将这些资料放入生成项目本地的 `docs/development` 与 `docs/errors`，无需再次克隆框架。

## 启动

在框架仓库根目录执行 `pnpm install`、`pnpm build`，然后进入本目录。独立模板项目先执行 `pnpm install`、`pnpm build:app`。

```powershell
# 首次配置时复制，已有 .env 时直接编辑原文件。
Copy-Item .env.example .env
# 编辑 .env，只填写 CAGE_ADMIN_DATABASE_URL，连接已经存在的数据库。
pnpm exec cage init
# init 自动创建账号、生成密码和 Cookie 密钥，并写回 .env。
pnpm gen
# 审查 db/migrations 后执行表结构迁移。
pnpm migrate
pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json
pnpm dev
```

数据库配置位于本项目根目录的 `.env`，与 `package.json`、`cage.config.json` 同级。[`.env.example`](.env.example) 为每项提供中文注释、填写格式和是否必填。连接池和事务由框架提供，项目只需配置连接。

| 配置项 | 用途 |
| --- | --- |
| `CAGE_APP_DATABASE_URL` | `cage_app` 账号：API/worker 业务读写 |
| `CAGE_READ_DATABASE_URL` | `cage_read` 账号：仅查询安全视图 |
| `CAGE_MIGRATE_DATABASE_URL` | `cage_migrate` 账号：手动执行表结构迁移 |

三个连接由 `cage init` 自动生成，指向**同一个已经存在的数据库**，主机、端口和库名一致。CLI 自动读取 `.env`，部署环境中的同名变量优先。修改后重启 `dev`。`migrate` 在下次执行时读取配置。

`pnpm migrate` 更新该库中的表、视图和索引；迁移历史记录在 `sys.schema_migrations`。`pnpm dev` 连接该库并启动 API、worker 和 Web，domain 变化后仅重新生成文件；表结构变更需审查迁移后手动执行。框架不创建数据库、不安装 PostgreSQL、不管理 Docker。

### 首次只提供管理员连接

在 `.env` 中填写 `CAGE_ADMIN_DATABASE_URL=postgresql://postgres:管理员密码@主机:端口/已有数据库名`。PostgreSQL 管理员通常叫 `postgres`，已有管理员叫 `root` 时使用实际账号名；连接串中的密码特殊字符需要 URL 编码。

执行 `pnpm exec cage init` 会创建框架账号和授权，生成三个独立随机密码及 Cookie 密钥，自动填写 `.env`，成功后移除文件中的管理员连接。业务端口、自定义配置和已有 Cookie 密钥会保留；失败会回滚数据库并保留原 `.env`。日常启动不需要管理员连接。

重复 `init` 会验证并复用已保存的三个账号，不更改密码。若集群已有 Cage 账号但本项目没有原连接，请先复用原凭证再运行 `init`；命令不会为了新项目重置其他项目的账号。部署时也可由平台直接提供三个账号连接，无需执行本地初始化。

数据库除三个登录账号外，还有不允许登录的 `cage_view_owner`，由 `init` 一并创建，用于持有安全视图，无需填写密码。角色名属于整个 PostgreSQL 集群，不能为另一个项目随意重置密码。业务表及系统表由后续 `pnpm migrate` 创建，`init` 只准备角色、schema 和授权。连接现有数据库不表示框架会自动识别、接管其中任意历史业务表；接入历史表需另行映射和审查迁移。

测试环境会初始化集群级角色，因此 `CAGE_TEST_DATABASE_URL` 必须指向独立测试集群。运行 `pnpm cage verify` 验证示例；框架仓库根目录的 `pnpm test:docker` 验证全部框架测试。

浏览器打开终端打印的 Web 地址；配置示例使用 <http://localhost:15173>。管理员凭证由显式 bootstrap 交付到新的受限文件，交付后移除。初始化仅授予系统管理能力，采购能力需要管理员明确配置。
`CAGE_WEB_PORT` 控制 Web 端口，`PORT` 控制 API 端口，Vite 代理同步使用它。缺少数据库配置时会给出错误，需填写 `.env` 后重新启动。

## 体验完整采购流程

前端使用 React Router：工作台 `/workspace`，采购列表 `/procurement/orders`，单据详情 `/procurement/orders/:id`，审批 `/approvals`，库存 `/inventory`，登录 `/login`。单号和审批待办可直接打开详情；刷新、前进后退和登录回跳保留页面地址。新增页面与部署按[路由和浏览器验收指南](../../docs/development/guides/routing.md)执行；Nginx 示例见 [deploy/nginx.conf](deploy/nginx.conf)。

1. 管理员在“库存台账”登记 `A-01` 等物料。
2. 进入 `/admin/` 创建采购员、经理，分别分配采购命令和审批能力；经理的 `PurchaseOrder.approve` 参数配置 `ceiling`。
3. 把经理设为采购员所在部门的负责人。提单人与审批人必须不同。
4. 为需要选人的采购参与者授予 `ApprovalMember.read` 与该聚合 `all` 范围，通过 `ApprovalMember.create` 登记审批协作人的公开业务姓名与专业领域；名录不授予实际审批能力。
5. 采购员新建采购单，可开启专业复核并选择 1–5 人；草稿使用 `PurchaseOrder.setReviewers` 调整名单，提交时重新校验。worker 先执行 AI 材料预审；未配置模型或模型失败时按声明转人工接管。
6. AI 预审/人工接管之后进入经理节点；启用专业复核时，经理后由所选人员全部会签。经理、专业和财务节点开放转办、委派归还和前置/后置/并行加签。
7. 超过 50,000 元的采购继续进入财务共享候选池，需另建 code 为 `finance` 的角色并给实际用户配置权限、范围和额度；财务必须先领取，恰好 50,000 元跳过该步骤。
8. 全部必签完成后，最终审批命令同事务生成库存锁；worker 调用 fake ERP 并回写单号。取消单据或收到 ERP 收货回调后异步释放锁；回调需要 `ERP_WEBHOOK_SECRET` 对原始 JSON 的 HMAC-SHA256 签名。

`Inventory.available` 是演示台账数量。本例验证库存锁生命周期，尚未实现仓库级的并发扣减、实物库存及退货核算。

本例的取消只改变本地单据并释放锁，尚未对接真实 ERP 的取消补偿接口。ERP 单号应答可能晚于取消或收货到达，`recordErpNo` 使用 `to: null` 保留当时的单据状态；它仍然检查允许的起始状态、调用身份和版本，并写入审计。上线前需确定外部订单撤销、退货或人工补偿的业务规则。

## 文件怎么读

在本目录运行 `pnpm exec cage graph`，浏览器打开终端输出的 <http://127.0.0.1:15418>，即可用图谱查看业务关系。页面支持中文/英文搜索、类型筛选、拖拽缩放、聚焦关联、声明位置与重新抽取，不需要启动数据库。

默认“对象与字段”按表卡片展示采购单、库存台账和库存锁，字段收在对象卡片中，显示中文含义、类型、必填标记及实际表名。拖动表头可以移动整张卡片。勾选“包含系统组织模型”查看部门、用户等对象；字段引用从字段行连到目标表头。“业务流程”和“完整本体”用于查看命令、事件、审批等更完整的关系。页面所说的业务对象，技术上叫“聚合”，包含共同遵守业务规则的字段、状态和命令，不只是数据库表。

线上的中文名称说明关系类型；点击连线、标签或节点详情中的“解释”，查看连接原因、业务用途、箭头方向和声明依据。可搜索 `PurchaseOrder.deptId` 后点击“聚焦关联”，看到采购单的所属部门字段**引用**部门卡片。字段详情中还可查看“采购审批分支”怎样用它**确定审批人**，点击解释会切换到完整本体显示对应连线。审批流程的“允许审批读取”表示字段可用范围，实际选人依据另有解释。

图谱主标题显示中文业务名称，下面保留英文代码标识。框架会读取声明现有的 `description`；本项目在 `cage.config.json` 的 `graph.labels` 中补充状态、字段等名称，也可覆盖较长描述。例如 `"command:PurchaseOrder.approve": "通过审批"`。键为 `节点类型:本体节点 ID`，可从节点详情复制 ID；中文标题只用于显示，不改变命令、权限标识或数据库。新增业务声明时同时补上需要的名称，然后在图谱中点击“重新抽取”。

- `packages/domain/src/modules/inventory`：最简聚合和库存锁。
- `packages/domain/src/modules/purchase`：采购状态、命令、约束、事件、审批、查询和任务。
- `packages/domain/src/workflows/purchase-inventory.ts`：同事务建锁与异步释放，包含资源配对标记。
- `packages/domain/src/integrations/erp.ts`：出站、入站映射和验签。
- `packages/contracts/src/aggregates/<聚合>`：生成的 SDK；页面统一从 `@app/contracts` 引入。
- `apps/api/src`：API 和 worker 的薄启动入口。
- `apps/web/src/app`、`modules`、`shared`：应用组合、业务页面、共享基础组件；`main.tsx` 只挂载。

新增业务先读[工程目录与代码组织](../../docs/development/reference/project-structure.md)，不要继续在 src 根目录平铺文件。模板已启用模块目录门禁，`cage check` 和 `verify` 会指出目录与依赖越界。

先运行 `pnpm cage gen` 再提交契约和迁移草稿；`pnpm cage verify` 检查完整工具链。派生测试遇到无法推断的业务输入会显示跳过，`purchase-order.test.ts` 另外准备真实业务数据覆盖成功审批和约束反例。
