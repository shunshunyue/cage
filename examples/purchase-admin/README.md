# 采购工作台

这是可启动的标准范例：组织管理、采购单、审批待办、库存台账、库存锁生命周期和 ERP 出入站映射。

## 启动

在框架仓库根目录执行 `pnpm install`、`pnpm build`，然后进入本目录。独立模板项目先执行 `pnpm install`、`pnpm build:app`、`pnpm cage gen`。

```powershell
pnpm cage db setup
pnpm cage db up
# 仅首次初始化独立新集群时执行；已有库随后用 cage migrate。
pnpm cage db init
pnpm dev
```

连接池、事务、数据库初始化和凭证生成均由框架提供，项目不写连接或建库脚本。`cage db setup` 生成随机密码和本地 `.env`，重复运行保留已有配置。开发库位于 `127.0.0.1:54329/cage_dev`，测试库位于独立容器的 54330 端口。`cage db down` 停止容器但保留开发数据卷；`cage db up` 再次启动。package.json 中的 `db:*` 是相同命令的简写。

CLI 自动读取项目 `.env`，部署环境变量优先。`CAGE_APP_DATABASE_URL`、`CAGE_READ_DATABASE_URL`、`CAGE_MIGRATE_DATABASE_URL` 分别连接写入、只读和迁移账号。超级用户仅用于初始化，API/worker 不接收其凭证。

测试环境会初始化集群级角色，因此 `CAGE_TEST_DATABASE_URL` 必须指向独立测试集群。运行 `pnpm cage verify` 验证示例；框架仓库根目录的 `pnpm test:docker` 验证全部框架测试。

浏览器打开 <http://localhost:5173>。初始管理员凭证在 API 终端显示一次。
如果 Windows Docker/Hyper-V 保留了该端口，在 `.env` 设置 `CAGE_WEB_PORT=15173`；终端会打印实际地址。`PORT` 控制 API 端口，Vite 代理同步使用它。未配置数据库连接串时才使用原有内嵌 PostgreSQL。

## 体验完整采购流程

1. 管理员在“库存台账”登记 `A-01` 等物料。
2. 进入 `/admin/` 创建采购员、经理，分别分配采购命令和审批能力；经理的 `PurchaseOrder.approve` 参数配置 `ceiling`。
3. 把经理设为采购员所在部门的负责人。提单人与审批人必须不同。
4. 采购员新建并提交采购单；worker 建立审批待办。
5. 经理在“审批待办”通过，内核同事务生成库存锁；worker 调用 fake ERP 并回写单号。
6. 超过 50,000 元的采购走财务第二步，需另建 code 为 `finance` 的角色并分配审批人。
7. 取消单据或收到 ERP 收货回调后，通过异步反应释放锁。回调需要 `ERP_WEBHOOK_SECRET` 对原始 JSON 的 HMAC-SHA256 签名。

`Inventory.available` 是演示台账数量。本例验证库存锁生命周期，尚未实现仓库级的并发扣减、实物库存及退货核算。

本例的取消只改变本地单据并释放锁，尚未对接真实 ERP 的取消补偿接口。ERP 单号应答可能晚于取消或收货到达，`recordErpNo` 使用 `to: null` 保留当时的单据状态；它仍然检查允许的起始状态、调用身份和版本，并写入审计。上线前需确定外部订单撤销、退货或人工补偿的业务规则。

## 文件怎么读

在本目录运行 `pnpm exec cage graph`，浏览器打开终端输出的 <http://127.0.0.1:15418>，即可用图谱查看业务关系。页面支持中文/英文搜索、类型筛选、拖拽缩放、聚焦关联、声明位置与重新抽取，不需要启动数据库。

默认“对象与字段”按表卡片展示采购单、库存台账和库存锁，字段收在对象卡片中，显示中文含义、类型、必填标记及实际表名。拖动表头可以移动整张卡片。勾选“包含系统组织模型”查看部门、用户等对象；字段引用从字段行连到目标表头。“业务流程”和“完整本体”用于查看命令、事件、审批等更完整的关系。页面所说的业务对象，技术上叫“聚合”，包含共同遵守业务规则的字段、状态和命令，不只是数据库表。

线上的中文名称说明关系类型；点击连线、标签或节点详情中的“解释”，查看连接原因、业务用途、箭头方向和声明依据。可搜索 `PurchaseOrder.deptId` 后点击“聚焦关联”，看到采购单的所属部门字段**引用**部门卡片。字段详情中还可查看“采购审批分支”怎样用它**确定审批人**，点击解释会切换到完整本体显示对应连线。审批流程的“允许审批读取”表示字段可用范围，实际选人依据另有解释。

图谱主标题显示中文业务名称，下面保留英文代码标识。框架会读取声明现有的 `description`；本项目在 `cage.config.json` 的 `graph.labels` 中补充状态、字段等名称，也可覆盖较长描述。例如 `"command:PurchaseOrder.approve": "通过审批"`。键为 `节点类型:本体节点 ID`，可从节点详情复制 ID；中文标题只用于显示，不改变命令、权限标识或数据库。新增业务声明时同时补上需要的名称，然后在图谱中点击“重新抽取”。

- `packages/domain/src/inventory.ts`：最简聚合和库存锁。
- `purchase-order.ts`：状态、命令、约束和事件。
- `reactions.ts`：同事务建锁与异步释放，包含资源配对标记。
- `approvals.ts`、`erp.ts`：封闭审批路由、出站和入站映射。
- `queries.ts`、`jobs.ts`：安全视图查询及过期草稿清理。
- `apps/api/src`：API 和 worker 的薄启动入口。
- `apps/web/src`：仅依赖生成契约的 React 界面。

先运行 `pnpm cage gen` 再提交契约和迁移草稿；`pnpm cage verify` 检查完整工具链。派生测试遇到无法推断的业务输入会显示跳过，`purchase-order.test.ts` 另外准备真实业务数据覆盖成功审批和约束反例。
