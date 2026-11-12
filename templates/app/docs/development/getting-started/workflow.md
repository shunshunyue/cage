# 日常开发：修改、生成、验证

本页适用于已启动的应用。首次安装与登录用[启动指南](start.md)，第一次学习完整读写用[便笺课程](first-feature.md)。命令在应用根目录执行。

## 修改前确定影响

先明确本次改变的动作、状态、范围和成功结果，查现有模块与真实契约。只改样式或文案时，修改对应页面即可；改变业务含义时记录已确定规则和待定问题，参考[业务设计](../guides/recipes.md)。

已有领域含义要改变时，先保存基线：

```powershell
pnpm exec cage snapshot save before-change
```

也可以使用已有真实 Git 提交或独立图文件；已有合适基线时无需再保存一份。快照同名不覆盖，示例名称已用过时换新名称，保留基线到验收结束。

## 按业务链修改

1. 在所属 domain 模块修改字段、状态和命令；跨模块联动放 workflows，第三方协议放 integrations。维护中文业务名称、reads/calls 和逐层导出。
2. 在应用根目录运行 check 和 gen，处理真实诊断，核对契约、图谱及结构变化。
3. 有迁移草稿时审查非空字段、回填、删除与索引，再显式运行 migrate。已执行或发布的迁移保持原样。
4. 页面通过生成契约使用新行为，处理失败、版本冲突和查询刷新；管理员在已授权环境配置新能力及范围。
5. 重启需要重新加载的 API/worker，按原先的业务例子检查结果。

```powershell
pnpm exec cage check
pnpm gen
# 仅在有已审查的结构变化时执行：
pnpm migrate
```

check 识别声明和图规则，gen 更新文件，migrate 更新库，进程重启才加载相应构建；各阶段不能相互替代。

## 比较变化并检查生成物

```powershell
pnpm exec cage impact --snapshot before-change
pnpm exec cage gen --check
```

需要比较声明影响时使用 impact，还可使用 --base 提交或 --base-file 图文件。它沿已抽取关系提供影响与测试候选，不能完整追踪辅助函数、前端和间接调用；仍需阅读源码与 Git 差异选择验证。context 查询不更新快照；analyze/gen 可以更新当前图。

contracts 和审查过的迁移需要提交；generated 与 .cage 的派生资料可重新生成。迁移草稿比较的是声明和最后一份迁移快照，不是扫描实际库漂移。数据库被手工改过时需要另行核对。

## 根据改动选择验证

| 改了什么 | 相关检查 |
| --- | --- |
| 文档或文案 | 链接、示例、分发一致性 |
| 声明与目录 | check、gen --check、类型、导出与依赖 |
| 命令、约束或反应 | 成功用例及权限、状态、并发、回滚或释放的关键反例 |
| 表结构 | 审查迁移，在独立测试环境迁移并读写 |
| 页面或导航 | 构建与实际浏览器操作，检查刷新、深链接、登录回跳和错误 |
| 异步流程 | worker、任务终态、最终业务结果 |
| 第三方或模型 | 本地/fake 与真实服务验收分别记录 |

pnpm verify 汇总类型、依赖、lint、声明、生成一致性、托管区、预算及测试，可用于项目完整门禁。它已包含 check 与 gen --check 对应检查，完成后无需为同一份代码重复执行；gen 在写入前也会检查声明，单独 check 适合提前定位问题。小改动按上表验证，不机械运行所有命令。

verify --skip-tests、用例 skip/todo 或无用例都会保留不完整标记，退出码 0 只表示已执行检查没有失败。测试使用独立 PostgreSQL 环境，不能指向生产或业务集群。详细证据与报告方式见[验证参考](../reference/verification.md)。

例如只把表单按钮“提交”改成“保存”，检查页面呈现即可；若把归档 from 从 active 改成多状态，则需生成、类型和成功/拒绝用例。不要因为两次修改都在同一项目就运行完全相同的一长串命令。

## 常用命令

| 需要回答的问题 | 按需使用的命令 |
| --- | --- |
| 当前安装版本的公开 API 是什么 | cage capabilities，或直接阅读公开类型 |
| 陌生模块有哪些声明、跨对象怎样关联 | cage context、graph search/inspect/path；局部逻辑直接读源码 |
| 怎样浏览声明模型 | cage graph；阅读工具，不作为每次修改的验收步骤 |
| 相对基线有哪些声明变化和关联影响 | cage impact；候选之外仍检查源码和业务影响 |
| 注册、生成、构建或进程状态是否一致 | cage doctor；诊断不替代业务验收 |
| 为什么被拒绝、异步执行停在哪里 | cage explain / timeline；需相应运行证据与授权 |
| 执行项目或声明派生测试 | cage test --only project / derived；核对实际通过与跳过数量 |
| AGENTS 框架托管区是否与版本一致 | cage sync --check；升级或门禁需要时检查 |
| 内核规模与 unsafe 是否超预算 | cage budget；计数约束不证明设计或业务正确 |

单独调用 CLI 使用 pnpm exec cage；项目脚本使用 pnpm gen、pnpm dev 等。诊断前提见[诊断工具](../tools/diagnostics.md)。交付说明行为变化、受影响文件、生成物、配置及通过/跳过/未执行的结果。

例如已经知道要改 modules/note/note.ts，就直接读该文件及调用方；只有想找“归档以后还触发谁”时，再选择上下文或关系查询：

```powershell
pnpm exec cage context command:Note.archive
```

[返回开发手册](../README.md)
