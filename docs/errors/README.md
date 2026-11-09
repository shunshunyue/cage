# 错误码册

这是本业务项目自带的离线诊断手册。先使用错误码、声明位置、reason/fix 定位；不需要克隆框架仓库。

- [HTTP 运行时错误与业务码](runtime.md)：401/403/404、状态冲突、约束拒绝、DOMAIN_ERROR 等。
- [业务排错顺序](../ai/troubleshooting.md)：启动、权限、审批人、worker、死信与导入导出。
- CAGE-* 是声明、工具链或内部运行诊断；HTTP code 与业务 domainCode 是另一层，不要混为一谈。

每页包含触发阶段、具体原因、修复步骤、正反例、验证方法与当前版实现位置。例子为局部说明，不能替代完整业务输入。

## 智能运行时

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-AI-001](CAGE-AI-001.md) | 智能运行时声明无效 |

## 文件字段与上传

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-FILE-001](CAGE-FILE-001.md) | 文件字段或上传配置无效 |

## 可靠读取审计

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-AUDIT-001](CAGE-AUDIT-001.md) | 可靠读取审计失败 |

## 运行状态诊断

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-DIAG-001](CAGE-DIAG-001.md) | 运行诊断输入或连接失败 |

## 后台执行与就绪

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-WORKER-001](CAGE-WORKER-001.md) | 缺少必要后台引擎 |
| [CAGE-WORKER-002](CAGE-WORKER-002.md) | 事件与消费者清单不匹配 |
| [CAGE-WORKER-003](CAGE-WORKER-003.md) | 后台任务未在停机时限内结束 |

## 审批

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-APPR-001](CAGE-APPR-001.md) | 审批字段声明无效 |
| [CAGE-APPR-002](CAGE-APPR-002.md) | 审批结论落到其他聚合 |
| [CAGE-APPR-003](CAGE-APPR-003.md) | 审批结论未允许流程调用 |
| [CAGE-APPR-004](CAGE-APPR-004.md) | 路由没有对应审批绑定 |
| [CAGE-APPR-005](CAGE-APPR-005.md) | 流程名称格式错误 |
| [CAGE-APPR-006](CAGE-APPR-006.md) | 审批步骤配置无效 |
| [CAGE-APPR-007](CAGE-APPR-007.md) | 找不到审批人 |
| [CAGE-APPR-010](CAGE-APPR-010.md) | 流程专用命令没有调用者 |

## 登录认证

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-AUTH-001](CAGE-AUTH-001.md) | OIDC 发现文档获取失败 |

## 业务流程阅读规格

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-BIZ-001](CAGE-BIZ-001.md) | 业务流程声明无效 |
| [CAGE-BIZ-002](CAGE-BIZ-002.md) | 业务流程与真实声明不一致 |

## 体积与逃生口预算

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-BUDGET-001](CAGE-BUDGET-001.md) | 内核超出体积预算 |
| [CAGE-BUDGET-002](CAGE-BUDGET-002.md) | 公共原语超过词汇预算 |
| [CAGE-BUDGET-003](CAGE-BUDGET-003.md) | 新增未经基线认可的 unsafe |

## 命令

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-CMD-002](CAGE-CMD-002.md) | 已有记录命令缺少 id |
| [CAGE-CMD-003](CAGE-CMD-003.md) | 新建命令没有目标状态 |

## 第三方连接器

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-CONN-001](CAGE-CONN-001.md) | 连接器名称格式错误 |
| [CAGE-CONN-002](CAGE-CONN-002.md) | 外部操作路径格式错误 |
| [CAGE-CONN-003](CAGE-CONN-003.md) | 地址白名单包含协议或路径 |
| [CAGE-CONN-004](CAGE-CONN-004.md) | 只读操作被用作出站写映射 |
| [CAGE-CONN-005](CAGE-CONN-005.md) | 入站事件名称格式错误 |
| [CAGE-CONN-006](CAGE-CONN-006.md) | 回调命令未允许 external |
| [CAGE-CONN-007](CAGE-CONN-007.md) | 当前环境没有连接器地址 |
| [CAGE-CONN-008](CAGE-CONN-008.md) | 外部请求发生网络错误或超时 |
| [CAGE-CONN-009](CAGE-CONN-009.md) | 外部服务返回非成功状态 |
| [CAGE-CONN-010](CAGE-CONN-010.md) | 外部响应不符合 schema |
| [CAGE-CONN-011](CAGE-CONN-011.md) | 出站永久失败进入死信 |
| [CAGE-CONN-012](CAGE-CONN-012.md) | 外部专用命令没有声明调用者 |
| [CAGE-CONN-013](CAGE-CONN-013.md) | 出站幂等键无效或请求冲突 |
| [CAGE-CONN-014](CAGE-CONN-014.md) | 不可重试外部写入结果未知 |
| [CAGE-CONN-015](CAGE-CONN-015.md) | 连接器超时或限流参数无效 |

## 创建应用

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-CREATE-001](CAGE-CREATE-001.md) | 项目创建参数或模板资源有误 |

## 可抽取声明

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-DECL-001](CAGE-DECL-001.md) | 声明不在可抽取的顶层常量 |
| [CAGE-DECL-002](CAGE-DECL-002.md) | 声明没有从 domain 入口导出 |
| [CAGE-DECL-003](CAGE-DECL-003.md) | 声明不是 export const |
| [CAGE-DECL-004](CAGE-DECL-004.md) | 跨文件导出名冲突 |

## 依赖边界

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-DEP-001](CAGE-DEP-001.md) | 领域声明直接依赖 IO |
| [CAGE-DEP-002](CAGE-DEP-002.md) | 适配器绕过命令写库 |
| [CAGE-DEP-003](CAGE-DEP-003.md) | 前端依赖服务端实现 |
| [CAGE-DEP-004](CAGE-DEP-004.md) | 声明或 handler 直接发请求/动态导入 |
| [CAGE-DEP-005](CAGE-DEP-005.md) | domain 反向依赖生成物 |

## 工程目录与模块依赖

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-STRUCT-001](CAGE-STRUCT-001.md) | 业务源码目录不符合模块约定 |
| [CAGE-STRUCT-002](CAGE-STRUCT-002.md) | 源码依赖越过模块边界 |

## 死信操作

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-DLQ-001](CAGE-DLQ-001.md) | 死信不存在或已经处理 |

## 运行配置

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-ENV-001](CAGE-ENV-001.md) | 缺少数据库连接配置 |
| [CAGE-ENV-002](CAGE-ENV-002.md) | 运行配置不满足安全边界 |
| [CAGE-ENV-003](CAGE-ENV-003.md) | 服务启动不能隐式初始化组织 |

## 事件载荷与兼容性

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-EVENT-001](CAGE-EVENT-001.md) | 事件载荷不满足声明 |
| [CAGE-EVENT-002](CAGE-EVENT-002.md) | 事件变更不向后兼容 |

## 字段

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-FIELD-001](CAGE-FIELD-001.md) | 敏感字段种类不存在 |
| [CAGE-FIELD-002](CAGE-FIELD-002.md) | 引用目标为空 |
| [CAGE-FIELD-003](CAGE-FIELD-003.md) | 字段不是字段原语 |
| [CAGE-FIELD-004](CAGE-FIELD-004.md) | 覆盖系统保留列 |

## 关系字段

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-REL-001](CAGE-REL-001.md) | 关系字段声明无效 |

## 生成一致性

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-GEN-001](CAGE-GEN-001.md) | 契约等生成结果过期 |
| [CAGE-GEN-002](CAGE-GEN-002.md) | 声明结构没有对应迁移 |
| [CAGE-GEN-003](CAGE-GEN-003.md) | 输入校验需要服务端执行 |

## 角色授权与防提权

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-GRANT-001](CAGE-GRANT-001.md) | 授予超出自己的能力或额度 |
| [CAGE-GRANT-002](CAGE-GRANT-002.md) | 授予超出自己的数据范围 |
| [CAGE-GRANT-003](CAGE-GRANT-003.md) | 能力不在代码目录中 |

## 影响分析

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-IMPACT-001](CAGE-IMPACT-001.md) | 影响分析没有可用基线 |
| [CAGE-IMPACT-002](CAGE-IMPACT-002.md) | 命名本体快照无效 |

## 账号初始化

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-INIT-001](CAGE-INIT-001.md) | 管理员 URL 没有数据库名 |
| [CAGE-INIT-002](CAGE-INIT-002.md) | 集群已有账号但缺少原凭证 |
| [CAGE-INIT-003](CAGE-INIT-003.md) | 三种连接身份或目标不一致 |
| [CAGE-INIT-004](CAGE-INIT-004.md) | 账号已创建但 .env 替换失败 |
| [CAGE-INIT-005](CAGE-INIT-005.md) | 显式组织初始化或凭据交付失败 |

## 定时任务

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-JOB-001](CAGE-JOB-001.md) | 定时表达式不合法 |
| [CAGE-JOB-002](CAGE-JOB-002.md) | 任务调用了未声明的命令 |
| [CAGE-JOB-003](CAGE-JOB-003.md) | 任务读取了未声明的聚合 |

## 通用 lint

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-LINT-001](CAGE-LINT-001.md) | lint 语法或规则错误 |

## 结构迁移与安全层

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-MIG-001](CAGE-MIG-001.md) | 迁移事务执行失败 |
| [CAGE-MIG-002](CAGE-MIG-002.md) | 安全层重建失败 |
| [CAGE-MIG-005](CAGE-MIG-005.md) | 已执行迁移内容被修改 |

## 名称

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-NAME-001](CAGE-NAME-001.md) | 聚合名必须大驼峰 |
| [CAGE-NAME-002](CAGE-NAME-002.md) | 字段名必须小驼峰 |
| [CAGE-NAME-003](CAGE-NAME-003.md) | 事件名必须大驼峰 |
| [CAGE-NAME-004](CAGE-NAME-004.md) | 命令名必须小驼峰 |
| [CAGE-NAME-005](CAGE-NAME-005.md) | 查询名必须小驼峰 |
| [CAGE-NAME-006](CAGE-NAME-006.md) | 任务名必须小驼峰 |

## 组织模型

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-ORG-001](CAGE-ORG-001.md) | 业务入口遗漏组织模型 |

## 资源配对

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-PAIR-002](CAGE-PAIR-002.md) | 离开持有资源状态却没有释放 |

## 安全查询

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-QUERY-001](CAGE-QUERY-001.md) | 查询必须选择一种实现 |
| [CAGE-QUERY-002](CAGE-QUERY-002.md) | 自定义查询直接访问基表 |
| [CAGE-QUERY-003](CAGE-QUERY-003.md) | 查询读取范围与声明不一致 |

## 跨聚合反应

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-REACT-001](CAGE-REACT-001.md) | 反应目标与命令聚合不一致 |
| [CAGE-REACT-002](CAGE-REACT-002.md) | 同事务反应链嵌套过深 |
| [CAGE-REACT-003](CAGE-REACT-003.md) | 集合或步骤顺序声明无效 |

## 显式读依赖

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-READS-001](CAGE-READS-001.md) | handler 使用了未声明读依赖 |

## 运行时注册表

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-REG-001](CAGE-REG-001.md) | 注册表缺少被引用声明 |
| [CAGE-REG-002](CAGE-REG-002.md) | 聚合或查询注册重名 |
| [CAGE-REG-003](CAGE-REG-003.md) | 命令能力点重复 |

## 自动路由

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-ROUTE-001](CAGE-ROUTE-001.md) | 业务项目手写 HTTP 路由 |

## 数据范围

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-SCOPE-001](CAGE-SCOPE-001.md) | 范围组合子未知 |
| [CAGE-SCOPE-002](CAGE-SCOPE-002.md) | 范围字段没有声明 |

## 密钥边界

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-SECRET-001](CAGE-SECRET-001.md) | 运行环境缺少密钥 |
| [CAGE-SECRET-002](CAGE-SECRET-002.md) | 源码疑似包含密钥字面量 |

## 敏感字段

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-SENS-001](CAGE-SENS-001.md) | 敏感字段未标注就进入事件 |

## SQL 参数化

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-SQL-001](CAGE-SQL-001.md) | SQL 拼接用户值 |
| [CAGE-SQL-002](CAGE-SQL-002.md) | sql.raw 接收动态表达式 |

## 状态与可达性

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-STATE-001](CAGE-STATE-001.md) | 引用了未声明状态 |
| [CAGE-STATE-002](CAGE-STATE-002.md) | 状态集合为空 |
| [CAGE-STATE-003](CAGE-STATE-003.md) | 状态名称格式错误 |
| [CAGE-STATE-004](CAGE-STATE-004.md) | 状态名称重复 |
| [CAGE-STATE-005](CAGE-STATE-005.md) | 状态声明位置冲突 |
| [CAGE-STATE-010](CAGE-STATE-010.md) | 状态不可达 |
| [CAGE-STATE-011](CAGE-STATE-011.md) | 非终态没有后续操作 |

## AI 托管区

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-SYNC-001](CAGE-SYNC-001.md) | AGENTS 托管区过期或标记损坏 |

## 测试报告

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-TEST-001](CAGE-TEST-001.md) | 测试进程没有生成结果报告 |
| [CAGE-TEST-002](CAGE-TEST-002.md) | 派生测试准备或初始夹具失败 |
| [CAGE-TEST-003](CAGE-TEST-003.md) | 测试数据库目录归属不匹配 |

## 逃生口

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-UNSAFE-001](CAGE-UNSAFE-001.md) | 逃生口缺少原因或负责人 |

## 升级

| 诊断码 | 含义 |
| --- | --- |
| [CAGE-UPGRADE-001](CAGE-UPGRADE-001.md) | 升级版本或 codemod 有歧义 |

## 历史流程

[CAGE-MIG-003](CAGE-MIG-003.md)、[CAGE-MIG-004](CAGE-MIG-004.md) 属于旧版初始化流程，当前使用 init + migrate；保留页面供历史诊断。

手册随创建项目时的 CLI 版本分发。cage sync 仅更新 AGENTS 托管区；升级后需要按该版本的资料核对差异。

框架维护者：修改 scripts/error-catalog.ts 后运行 pnpm docs:errors；不要只手改生成的逐码页面。
