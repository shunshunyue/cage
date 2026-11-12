# 日常开发：修改、生成、验证

本页适用于已启动的应用。首次安装与登录用[启动指南](start.md)，第一次学习完整读写用[便笺课程](first-feature.md)。命令在应用根目录执行。

## 修改前确定影响

先明确本次改变的动作、状态、范围和成功结果，查现有模块与真实契约。只改样式或文案时，修改对应页面即可；改变业务含义时记录已确定规则和待定问题，参考[业务设计](../guides/recipes.md)。

已有领域含义要改变时，先保存基线：

```powershell
pnpm exec cage snapshot save before-change
```

同名快照不会覆盖。也可以使用已有真实 Git 提交或独立图文件；保留到验收结束。

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

impact 提供受影响声明和候选验证，不证明任意 handler 正确。还可使用 --base 提交或 --base-file 图文件。context 查询不更新快照；analyze/gen 可以更新当前图。

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

pnpm verify 汇总项目门禁；verify --skip-tests 明确是不完整验证。测试使用独立 PostgreSQL 环境，不能指向生产或业务集群。详细证据与报告方式见[验证参考](../reference/verification.md)。

## 常用命令

| 命令 | 输出或作用 |
| --- | --- |
| cage capabilities 关键词 | 当前安装包的公开签名和指南 |
| cage context 业务关键词 | 当前应用的声明与关联 |
| cage graph | 浏览器本体工作台 |
| cage doctor | 注册、生成、构建及可用运行证据 |
| cage test --only project / derived | 项目或声明派生测试 |
| cage sync --check | AGENTS 框架托管区一致性 |

单独调用 CLI 使用 pnpm exec cage；项目脚本使用 pnpm gen、pnpm dev 等。诊断前提见[诊断工具](../tools/diagnostics.md)。交付说明行为变化、受影响文件、生成物、配置及通过/跳过/未执行的结果。

[返回开发手册](../README.md)
