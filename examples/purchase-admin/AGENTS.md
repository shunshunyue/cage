# 标准业务范例说明

当前目录是 Cage 框架仓库中的可运行采购范例；业务源码均相对本目录。框架通过 workspace 依赖引用，不在业务目录复制实现。

本范例使用框架仓库中的规范资料：[业务开发入口](../../docs/development/README.md)、[采购全链路](../../docs/development/examples/purchase-example.md)、[错误码册](../../docs/errors/README.md)。下面托管区提到的 `docs/development`、`docs/errors` 在本源码范例中分别指 `../../docs/development`、`../../docs/errors`；创建的独立项目会自带这两个目录。

范例用于演示模式；客户业务应按实际需求新增/替换 domain 和页面，不固定为采购。库存锁演示不包含仓库级并发扣减或真实 ERP 取消补偿。

目录与依赖遵守[工程组织规范](../../docs/development/reference/project-structure.md)：业务在 modules 内集中，前端 app 负责组合，跨领域模块反应在 workflows，第三方在 integrations。不要把业务重新平铺到 src 根目录。

<!-- cage:begin v0.4.0 -->
## Cage 开发约定（框架托管）

本项目通过 @yss123/cage-* 使用框架。真实业务入口、环境及客户规则以本文托管区外说明为准；本区由 cage sync 更新。

### 开发准则

1. **先理解业务，再建模和编码。** 先读用户描述、业务材料与现有实现，用业务语言说清本次涉及的对象、参与人、操作前后状态、权限范围和成功条件。现有代码说明当前行为，用户需求与已确认规则决定目标；只梳理本次相关内容。
2. **主动澄清影响结果的疑点。** 发现歧义、冲突或遗漏时，指出依据，提供可行选项、影响和推荐，让用户选择业务规则。沿用已明确的答案，待定部分先不落实，继续不依赖它的工作；技术事实由 agent 查证，可选建议不阻塞明确任务。
3. **查证能力，优先复用。** 先核对本项目的声明、契约和当前框架公开 API，再决定实现。业务规则不能因技术方便而被改写；确有能力缺口时说明证据、可行方案及业务影响，再确定相关取舍。
4. **编码前说明规则怎样落地。** 简述“已确认规则 → 已查证机制 → 修改位置 → 验收例子”，确保页面操作、持久化、权限和后续流程都有实际实现依据。普通技术方案由 agent 处理，不另设批准环节。
5. **保留选择，控制变更范围。** 记录规则本身及来源，区分已确定事项、待定事项和可选建议。用户改变规则时同步受影响的声明、页面、配置与验收；客户规则保留在项目文档或本文件托管区外，模板演示只作为用法参考。
6. **用真实业务结果验收。** 回到已确认的成功和拒绝例子，按改动取得保存读取、授权、状态、流程及页面等证据。修复最早失败点，交付如实说明通过、跳过和未执行，不能用界面完成或检查通过推断未验证的结果。

准则按任务影响执行：清楚的文案、样式或局部修正可用一两句话说明；已有规则直接采用，普通小改动无需重新完成全部业务建模。共同澄清的具体方法见 docs/development/guides/business-collaboration.md。

### 按任务读取

人从 docs/development/README.md 进入；编程 AI 使用 docs/development/skills/cage-development/SKILL.md，再按任务读取指南。首次学习走启动、执行模型和便笺课程，已有明确任务直接查对应章节。

### 执行和源码边界

- 声明从 domain 总入口导出；写入走命令，读取走安全读侧，外部 IO 走连接器。handler 声明 reads，job 声明 reads/calls。
- 角色、能力、范围、调用身份和业务约束分别生效，审批选人不授权，前端 can 只控制显示；新增能力不自动授给普通生产角色。
- domain 使用 modules/workflows/integrations/shared，Web 使用 app/modules/shared，通过模块 index 组合；前端仅依赖 contracts/client/协议，保持 modular 门禁。
- 手写源码遵守 docs/development/reference/commenting.md，解释职责、调用、输入输出、关键流程和实际边界；变更同步更新中文注释，生成物从来源维护。
- 领域含义变化先保存基线，修改后 check/gen 并审查迁移；生成契约不手改，已执行迁移保留。操作见 docs/development/getting-started/workflow.md。
- 多页面使用独立 URL，筛选/分页进查询参数；导航与真实交互按 docs/development/guides/routing.md 验收。
- 使用已有 PostgreSQL 和项目配置；init、migrate、bootstrap、dev 各自显式执行。凭据与 .env 不进入源码、文档或日志，普通业务不建连接池或管理 Docker。
- 业务数据、权限、流程结果来自实际服务端，界面草稿与模拟数据不能替代正式保存。先阅读相关源码、调用方和测试；跨模块声明关系可用 cage context 辅助定位，API 不明确时用 cage capabilities 或公开类型核对安装版本。按问题选工具，检索未命中不能说明能力或实现不存在。

### 可选能力与完成依据

原生 AI、AI 审批和随页助理先读 docs/development/guides/intelligence.md，核对 domain 启用、模型、迁移与授权；框架支持、应用启用与实际结果分别说明。

按 docs/development/reference/verification.md 对照本次规则验证持久化、权限、流程、文件、异步终态与页面。交付分别报告通过、跳过、未执行；诊断 unknown、verify --skip-tests 或测试用例跳过均需说明证据缺口，小改动按影响检查。

出错保留 code/at/reason/fix，查 docs/errors/README.md 与 docs/development/tools/troubleshooting.md，修复最早断点，保持权限、约束、门禁和迁移历史有效。
<!-- cage:end -->

