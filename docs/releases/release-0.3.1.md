# Cage 0.3.1 发布记录

日期：2026-11-09。状态：14 个包已公开发布，latest 均为 0.3.1，注册表 SHA-512 和完整 README 与本轮 tarball 一致；blank、purchase 两模板均通过公开 npm 创建、安装、构建与静态检查。

本次发布当前工作区代码，14 个公开包统一为 0.3.1，保留已发布的 0.3.0。主要变化为审批人员操作、结构化 AND 并行与全部汇合、节点时限及流程提醒，以及采购范例的协作名录与任务界面。完整语义和边界见[审批指南](../development/guides/approvals.md)、[流程时效验收](../verification/approval-operations-verification.md)和[并行审批验收](../verification/approval-parallel-verification.md)。后两份是已有功能验收记录，不作为本轮重新执行浏览器场景的证据。

## 升级

将应用使用的全部 `@yss123/cage-*` 依赖统一升级至 0.3.1，执行 `cage sync`、重新生成并审查契约与迁移，再执行迁移。API 与 worker 使用相同版本；不要改写历史迁移或直接更新审批状态。新审批策略和范围权限需要应用明确配置，不自动授予生产角色。

并行是结构化 AND，并未实现任意跳转、OR 网关或在途实例迁移。时限为自然分钟；超时提醒不自动批准。真实模型、ERP 与生产环境须独立验收。

## 本轮验收

| 项目 | 状态 |
| --- | --- |
| 脚本 TypeScript、内核预算 | 通过；4387/5000 行，16 个原语，unsafe 0 |
| 框架、API、Web 构建及文档／模板分发 | 通过；两模板 432 个资料文件 |
| 14 个 tarball 的 README、入口、依赖与资源 | 通过；清单记录每包 SHA-512 |
| 仓库外 blank／purchase tarball 安装、构建、声明与生成检查 | 通过；临时目录 `C:/Users/hasee/AppData/Local/Temp/cage-package-0.3.1-aDTnXV` |
| 全仓框架测试 | 通过；487 项，CLI 173、testkit 300、lint 10、Admin 4，无跳过 |
| 高危依赖审计 | 通过；无 high／critical，保留 2 项 moderate |
| 完整采购范例 verify 与独立 PostgreSQL 测试 | 通过；131 项测试通过，26 项派生用例跳过，不计为通过 |
| npm 上传、latest 与注册表完整性 | 通过；14/14，latest、SHA-512 和完整 README 一致，上传后本地 SHA-512 未改变 |
| 公开 npm 创建、安装与构建 | 通过；blank／purchase 均通过创建、安装、构建、声明、生成及托管区一致性、本体查询；采购关系路径检查通过，无 tarball 覆盖或源码链接 |
| 本轮浏览器场景重验、真实 AI／ERP、生产部署、GitHub 推送与标签 | 未执行 |

本机 tarball、manifest 与日志位于 `.cage/releases/0.3.1`。上传使用 manifest 中已经检查的 tarball，上传前后核对 SHA-512。首次公开查询因 npm 索引尚未同步而未通过，保留初始日志后等待同步，并重新核对全部 14 包通过，没有重复上传。源码提交、远端推送和标签不在本次 npm 发布范围内。

最终公开 npm 验证项目保留在 `C:/Users/hasee/AppData/Local/Temp/cage-npm-0.3.1-UaUQAp`；该验收未连接业务数据库。`validation.json`、`framework-tests.log`、`example-verify.log`、`example-validation.json`、`skipped-tests.json`、`publish-results.json`、`registry-verification.json` 与 `registry-smoke.json/log` 保存检查和发布证据。采购范例跳过的 26 个用例单独列名，不计为通过；真实模型、ERP 与浏览器新场景不在本轮重验范围内。
