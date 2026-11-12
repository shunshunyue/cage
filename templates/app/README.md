# Cage 业务应用（含采购示例）

这是可运行的 Cage 范例，演示采购申请、AI/人工审批、库存锁、ERP fake、私有附件和随页助理。框架通过依赖使用，业务规则在本应用 domain。

## 启动和学习

在本项目根目录执行 `pnpm install`、`pnpm build:app`；无需克隆或构建框架仓库。

按[启动指南](docs/development/getting-started/start.md)配置已有 PostgreSQL，init、生成、审查并 migrate，再 bootstrap 和 dev。打开终端打印的 Web 地址；凭据从新受限文件交付。首次超级管理员有全量租户能力，普通角色显式授权。

先读[执行模型](docs/development/getting-started/architecture.md)，用[采购导读](docs/development/examples/purchase-example.md)沿单据跟踪源码。新增客户业务使用[开发手册](docs/development/README.md)；编程 AI 使用 [AGENTS.md](AGENTS.md)。

## 跑一次真实流程

1. 管理员登记台账物料，配置采购员、不同的部门负责人和所需能力/范围。
2. 采购员保存申请与明细；需要专业复核时在协作名录准备用户并选择 1–5 人。名录不授予实际审批权限。
3. 提交后由 worker 启动 AI 预审；材料不足退回，模型未配置或失败按政策转人工。
4. 经理、可选专业会签依次处理，严格大于 50000 元再进入 finance 角色的共享候选任务。
5. 全部必签完成后批准并同事务建库存锁；worker 调 fake ERP，回执通过命令回填。
6. 取消或验签收货后观察异步释放；查看实际单据、任务和记录。

main 模型与自动审核角色另按[AI 指南](docs/development/guides/intelligence.md)配置。经理、专业和财务节点可按政策转办、委派及加签，页面使用当前 revision。

## 页面和验证

列表 /procurement/orders、详情 /procurement/orders/:id、待办 /approvals、库存 /inventory、工作台 /workspace。系统管理走 /admin/，业务深链接和部署见[路由指南](docs/development/guides/routing.md)。

Inventory.available 是演示台账，锁用于生命周期展示，尚无完整仓库并发扣减、退货或远端取消补偿。ERP fake 不代表真实联调，模型连接不代表审核质量。

在本目录运行 pnpm exec cage check、pnpm gen、pnpm verify；数据库使用独立测试环境。图谱用 pnpm exec cage graph。构建、真实读写、权限、浏览器、模型和外部系统分别记录验证结果，问题查[错误码](docs/errors/README.md)。
