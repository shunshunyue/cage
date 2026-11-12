# 沿一张采购单阅读完整框架

采购范例把领域、审批、库存锁、ERP、附件和助理组合成可运行应用。它演示如何消费框架，采购规则属于范例，不自动成为其他项目需求。

## 先找到实际源码

| 所处项目 | 本文源码路径从哪里起算 |
| --- | --- |
| 框架仓库 | examples/purchase-admin |
| purchase 模板 | 当前应用根目录 |
| blank 模板 | docs/examples/purchase-admin，只有阅读源码 |

下文 domain 路径相对 packages/domain/src，Web 路径相对 apps/web/src。blank 的采购参考不参与注册、构建或迁移；要运行完整演示可创建 purchase 项目。

## 第一遍只读主链

1. domain index.ts 统一导出组织、业务、workflows 和 integrations。
2. modules/purchase/purchase-order.ts 定义 PurchaseOrder、命令和事件。
3. modules/purchase/approvals.ts 绑定提交/取消及结论，定义审核路线。
4. workflows/purchase-inventory.ts 连接批准、取消和收货的资源动作。
5. integrations/erp.ts 定义外部操作、出站、回写与入站验签。

先回答“谁让下一步发生”，再去看对应页面和工具。读依赖、状态相接和资源标签各有含义，真正执行链需落实到命令、事件与反应。

## 保存和提交

PurchaseOrder 保存金额字符串、明细、部门、创建人、用途、专业复核需求、候选人员和附件 ID。金额必须为正、明细非空，输入再限制行数量。

create 保存草稿。setReviewers 调整专业需求和名单，提交时重新核对名录：需要复核时为 1–5 个不同、非提单人的有效用户。协作名录记录业务资料，不授予批准能力。

submit 成功后记录 OrderSubmitted；worker 消费并启动流程。提交响应证明主事务完成，实际待办需进一步读取。

## 审核路线和结论

当前路线为 AI 材料预审 → 部门经理 → 可选专业会签 → 严格大于 50000 元的财务候选池。恰好 50000 元跳过财务。专业会签需全部人通过，财务先领取。

AI 的 main 模型和自动角色需真实配置，材料不足退回修订，不确定或模型失败按策略人工接管。修订后重新提交新轮次。人工经理、专业与财务节点可按政策转办、委派及前后/并行加签，旧实例沿用快照。

approve/reject/returnForChanges 是 process 命令，最后决定人需能力、范围及职责分离。批准还读取库存并做业务检查；被选中或进入名录不免除这些条件。

## 批准与资源占用共同提交

OrderApproved 同时驱动库存锁命令和 ERP 后续。库存锁反应使用 same，锁失败使批准回滚。acquires/releases 为静态资源配对，真正记录由 InventoryLock 命令保存。

取消和收货后异步释放。取消事件带 previousStatus，草稿取消不会尝试释放未取得资源；新增其他离开持有状态的路径也需要核对释放。

Inventory.available 是演示台账，库存锁用于演示生命周期，不提供完整仓库级并发扣减、实物库存、退货核算。

## ERP 在本地提交之后

出站将事件映射到固定操作，远端幂等依赖协议。成功回执通过 external 命令 recordErpNo 回填；to: null 保留取消或收货后的当前状态，仍检查允许的 from。

入站基于原始 JSON 的 HMAC-SHA256 验签，成功调用收货命令，再发事件释放锁。fake 证明本地映射和回写，真实 ERP 联调需单独验证；取消目前只改变本地状态与资源，尚无远端撤销补偿。

## 页面和原生 AI

app 组合路由、会话、布局和跨模块链接。采购列表为 /procurement/orders，详情为 /procurement/orders/:id，审批 /approvals，库存 /inventory。页面从 @app/contracts 调用，不执行领域 handler。

integrations/intelligence.ts 启用模型和助理；shared/ui/assistant-panel.tsx 展示流式回复、进度和确认。业务页提供对象、筛选、选择和草稿语义。框架提供执行，应用提供策略与界面。

## 运行时怎样验收

按本应用 README 启动；准备采购员、不同的部门负责人、专业人员及 finance 角色，分别配置能力与范围。登记真实台账后，从创建到批准、ERP 回写、取消或收货逐步检查。

还要覆盖退回重提、自审批、缺能力、范围外、库存不足、版本冲突、候选领取、加签等待和外部失败。声明检查、派生测试、项目业务测试、浏览器、模型与真实 ERP 各自报告，历史记录不能替代本次执行。

开始自己的业务时复用声明模式和薄壳，替换对象、规则与界面；按[业务设计](../guides/recipes.md)确定范围，保留已执行迁移。

[返回开发手册](../README.md)
