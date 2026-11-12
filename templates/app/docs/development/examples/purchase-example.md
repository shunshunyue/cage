# 标准采购范例：从声明到业务页面

[返回学习入口](../README.md) · [业务任务配方](../guides/recipes.md)

选择 `--template purchase` 创建的是可运行的采购应用，下面的路径相对应用根目录；选择 `--template blank` 时，同一份范例仅作为参考源码保存在 `docs/examples/purchase-admin`，下面路径相对该参考目录，它不参与当前应用的编译、注册或迁移。框架能力来自 npm 依赖。先沿一条真实链路读代码，再把需要的模式应用到自己的业务。

## 按这个顺序读文件

| 文件（相对应用根目录） | 看懂的业务能力 | 改造时关注什么 |
| --- | --- | --- |
| `packages/domain/src/index.ts` | 哪些声明真正被注册 | 保留组织模型，导出新增业务，避免导出名冲突 |
| `packages/domain/src/modules/inventory/inventory.ts` | 最简字段、创建命令、资源锁聚合 | scope.none 不等于无需授权；创建与释放都是命令 |
| `packages/domain/src/modules/purchase/purchase-order.ts` | 单据生命周期、金额、明细、约束、事件 | 哪些字段由输入提供，哪些由内核维护；每个状态的允许操作 |
| `packages/domain/src/modules/purchase/approval-members.ts` | 采购协作名录与公开业务姓名 | 名录读权限与系统用户资料分离；成员身份不授予审批权限 |
| `packages/domain/src/workflows/purchase-inventory.ts` | 同事务建锁、异步释放 | acquires/releases 的配对及 map 返回 null 的原因 |
| `packages/domain/src/modules/purchase/approvals.ts` | 启动/取消审批、专业会签、财务候选与任务动作 | routable、部门负责人、字段选人、候选领取、结论命令 |
| `packages/domain/src/integrations/erp.ts` | 出站推单、成功回写、入站回调 | 白名单、secret 名、schema、幂等与 HMAC |
| `packages/domain/src/integrations/intelligence.ts` | 消费框架托管模型和本体助理 | Admin 配置连接，通用工具由框架生成 |
| `packages/domain/src/modules/purchase/queries.ts` | 按状态汇总 | reads、安全视图、命名参数 |
| `packages/domain/src/modules/purchase/jobs.ts` | 过期草稿取消 | reads/calls 和 job 调用身份 |
| `apps/api/src/main.ts`、`apps/api/src/worker.ts` | 如何启动框架与 worker | 保持薄装配，fake 只用于相应环境 |
| `packages/contracts/src/aggregates/purchase-order/index.ts` | 生成的前端协议与类型 | 只读它，不手改；process/external 命令不生成浏览器写方法 |
| `apps/web/src/main.tsx`、`app` | 挂载、全局 Provider、会话与导航组合 | 入口保持简洁，从模块公开入口组装页面 |
| `apps/web/src/modules/purchase`、`inventory`、`approval` | 各业务页面与交互 | 调契约、处理错误、刷新列表、展示导出任务；不互相穿透 |
| `packages/domain/src/modules/purchase/purchase-order.test.ts` | 有业务数据的成功/拒绝用例 | 越权、自审批、库存锁、晚到 ERP 回执 |

## 一次正常采购发生了什么

```text
采购员新建 → draft
  → submit → pending_approval + OrderSubmitted（同事务提交）
  → worker 消费事件 → AI 材料预审
      → 材料不足：returnForChanges → draft，补充用途后重新提交、从头审核
      → 疑难材料：在本节点创建人工接管待办
      → 材料清楚：通过本节点，创建经理待办
  → 部门经理审批
  → 申请启用专业复核时：所选专业人员全部会签
  → 金额 > 50000 时：财务共享候选任务，由 finance 成员领取后处理
  → 流程完成 → 调用 approve
      → 职责分离、库存检查
      → approved + OrderApproved
      → 同事务 lockOnApprove → InventoryLock.held
  → worker 消费 OrderApproved → fake/真实 ERP 推单
      → recordErpNo（external，保持当前状态）
  → 收货回调 → markReceived → received + OrderReceived
  → worker 释放锁 → InventoryLock.released
```

submit 返回成功只表示单据和事件已提交，不表示待办、ERP 或其他异步工作已经完成。worker 未运行时，单据可以已经处于待审批，但没有待办。

### 为什么分开单据、库存与协作名录

- `PurchaseOrder` 管单据、审批结论和采购状态。
- `Inventory` 是物料台账，提供库存检查的数据。
- `InventoryLock` 记录某张订单的资源占用，使用订单 id 作为锁 id，让释放目标明确。
- `ApprovalMember` 保存采购参与者可读取的公开业务姓名和专业说明。它引用真实用户，但不开放 `User.name` 等系统用户资料，也不代替角色授权。

审批通过和建锁放在同一事务，是为了避免“单据已批准却没拿到资源”。ERP 网络请求放到 outbox，是因为远端调用无法与本地 PostgreSQL 共同回滚。

### 取消为什么要带 previousStatus

草稿或待审批取消时还没有库存锁，不应释放不存在的锁；已批准取消才需要释放。因此 `OrderCancelled` 的显式 emit 映射携带旧状态，反应通过 `previousStatus === 'approved'` 决定是否调用释放命令。

新增撤回、作废等动作时，每一条离开已批准状态的路径都要考虑资源。仅把命令 `to` 改成新状态，可能被 `CAGE-PAIR-002` 拦下；补了标签也仍要确保真正的释放命令会执行。

### ERP 回执为什么用 to: null

网络应答可能晚于取消或收货到达。`recordErpNo` 允许从 approved/received/cancelled 更新单号，用 `to: null` 保持加锁时的当前状态；不会把取消单重新变成已批准。它仍受调用身份、允许状态、版本和审计约束。

本例没有真实 ERP 取消补偿。上线时需另外设计远端撤销、退货或人工补偿，不能把“本地取消成功”当成“远端订单已撤销”。

## 首次体验所需业务配置

以下体验需要采购模板；空白模板不会出现采购页面和审批配置。先按[开发步骤](../getting-started/workflow.md)准备已有数据库并启动 API、worker、Web。首次管理员凭证按 API 提示获取，不把凭证写到仓库。以下是业务配置，不是需要写进框架内核的逻辑。

| 对象 | 配置要点 |
| --- | --- |
| 采购员 | 创建/查看/提交/取消采购单等所需能力，所属部门，以及采购单数据范围；配置专业复核需 `PurchaseOrder.setReviewers` 和 `ApprovalMember.read` |
| 智能助理使用人 | 显式授予 `Sys.ai.use`；编辑用途还需 `PurchaseOrder.explainPurpose` |
| 模型管理者 | `Sys.ai.models.manage`；在 `/admin/#/models` 配置并启用 `main`，部署主密钥见[智能能力指南](../guides/intelligence.md) |
| 助理性格管理者 | `Sys.ai.personalities.manage`；在 `/admin/#/personalities` 编辑预设、自定义性格、设置默认并试聊 |
| AI 预审角色 | 创建 code 为 `purchase_ai_reviewer` 的角色，授予 `PurchaseOrder.read/returnForChanges` 及覆盖申请范围的数据权限；本例 AI 仅预审，不执行最终 approve |
| 经理 | `PurchaseOrder.read/approve/reject/returnForChanges` 和适当数据范围 |
| 专业协作人 | 真实账号及所需审批能力和范围；由名录管理员通过 `ApprovalMember.create` 登记公开业务姓名、专业说明；需要在任务中选人时授予 `ApprovalMember.read` |
| 名录管理员 | 显式授予 `ApprovalMember.create/update/retire/read`；登记、更新资料或退役不修改用户角色，不自动给采购参与者授予 `User.read` |
| 部门 | 将采购员所属部门的负责人设为经理；不能为空 |
| 财务 | 角色 **code** 为 `finance`，给至少两位实际用户分配以体验共享候选池；配置审批所需权限和范围；领取后才能处理 |
| 库存台账 | 预先登记与采购明细相同的 sku，数量满足演示检查 |
| 连接器环境 | fake 阶段使用 worker 注册的 fake；真实环境另配 host 对应密钥及回调签名密钥 |

经理与提单人必须是不同用户。配置“负责人”决定选谁；配置角色能力与范围决定此人能否完成结论命令，两者都需要。金额 **大于** 50,000 才追加财务步骤，恰好 50,000 不满足 gt 条件。

专业复核默认关闭，兼容旧单据的空字段；开启后需选择 1–5 位不同且非提单人的有效名录成员。`setReviewers` 只允许编辑草稿；创建可暂存未选完整的草稿，但 `submit` 会重新核对名单，拒绝保存后退役的成员。名录退役不修改已经提交的名单快照，也不撤销在途任务；账号停用和实际审批权限继续由审批引擎核验。名录的用户引用不能换绑，已退役记录保留且不支持重新启用。

`ApprovalMember` 使用 `scope.none()`，没有部门或本人字段。名录管理员和需要选人的采购参与者都必须显式获得该聚合的 `all` 数据范围；仅授予 `ApprovalMember.read` 仍看不到成员，草稿的专业名单校验也会因读范围不足拒绝。这里的 `all` 始终受当前租户隔离，不要求也不授予 `User.read`。

经理、专业会签和财务节点均显式启用转办、委派与前置/后置/并行加签，节点政策随每次提交保存。转办交接处理责任；委派处理完成后归还原审批人；加签增加必须完成的签署任务，前置签署完成前原任务等待，后置签署在原任务通过后才开放。任务动作和决定都应携带页面当前 `revision`，冲突后刷新待办，不自动重试旧决定。AI 人工接管继续采用 AI 节点自身政策，不能因为后续经理节点启用动作而越权操作。

逐项体验时用不同采购单分别记录：普通经理审批、专业双人会签、恰好 50,000 元跳过财务、超过 50,000 元财务领取/释放/再领取、转办、委派归还、三种加签，以及退回重提和申请人取消。每一步同时查看采购状态、当前可操作/等待任务及动作历史；专业会签只通过一人或必签尚未完成时采购单应仍待审批，最终通过才产生库存锁。浏览器验收需切换真实账号进行，自动测试通过不能替代页面验证。

可分别准备“采购办公用品”、说明实际使用场景的完整用途、含“紧急采购”的用途，体验退回、通过本节点和转人工。真实模型的判定应按实际样例验收；故障默认转人工，不能当作正常审查通过。详情页显示历史理由、修改建议及审核轮次；用途编辑框的未保存内容会经 SDK 一起传给助理，服务端重新核对当前单据与权限。

拥有 `Sys.ai.use` 的用户在所有业务页面右下角都有助理入口，点击打开悬浮对话窗，收起后继续执行当前任务。工作台、采购列表/详情、库存和待办分别提供页面语义；列表带筛选与可见记录，详情带单据引用和未保存用途。应用壳只挂载一个 `AssistantScope`，业务页面通过 `AssistantPage` 注册上下文，所以站内切页保留对话，但下一条消息使用新页面的快照。不同页面拥有独立的 `AiPageContext` 身份，旧任务要求补充页面时不能提交新页面代替。登录页和独立的 `/admin/` 不挂载业务助理。

悬浮窗的“相处方式”选择器消费框架 `useAssistant` 的性格目录和切换接口。默认跟随 Admin 设置，也可为当前会话选择其他已启用性格；切换不清空对话，旧回复保留生成时的性格名称。采购范例没有单独的性格表或 Prompt 拼接逻辑，AI 审批继续使用原节点策略。

## 页面如何使用框架

采购页和库存页通过 `@app/contracts` 获取方法、快照类型和查询 hooks。命令成功后刷新相应列表；失败时按 code/domainCode 展示原因。只有允许 user 调用的命令才生成页面方法，因此审批通过应使用待办接口。

`apps/web` 中对字段和按钮的中文名称属于业务文案。图谱名称来自 `cage.config.json` 的 `graph.labels`，比如 `command:PurchaseOrder.submit` 对应“提交审批”。替换业务时别忘了更新这些名称，不要改英文能力标识来做翻译。

导出按钮是调用通用异步接口的一个例子；框架不规定所有业务都要放相同的按钮。导入、导出、任务列表与错误报告应按客户页面需要接入，参考[开发步骤](../getting-started/workflow.md)中的客户端方法。

## 把示例改成自己的业务

先按[目录规范](../reference/project-structure.md)新增自己的领域模块和前端模块，完成一条完整链路，再逐步移除不需要的采购导出、路由、反应、连接器和页面引用。`@app/domain`、`@app/contracts` 是应用内包名，可以保留；npm 框架包也不需要重命名。

若数据库尚未投入使用，可为新应用审查和规划初始结构；只要迁移已执行或已发布，就不能通过覆盖 `0001_init.sql` 来假装采购表从未存在。用新迁移表达后续变更，并明确已有数据处理方式。

## 本例可以证明和不能证明的事

它演示了真实 PG 上的命令与安全读侧、审批结论约束、同事务建锁、异步释放、连接器 fake 和签名回调。`Inventory.available` 是演示台账数量，尚未实现多订单并发扣减、实物出入库和退货核算；fake ERP 不证明第三方生产联调完成。

扩展业务时把这些边界写进实现说明，补必要的业务规则与有意义的回归用例，而不是直接给范例换标题后声称生产需求已经全部覆盖。
