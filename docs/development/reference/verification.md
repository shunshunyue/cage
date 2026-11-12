# 怎样判断功能已经完成

验证从已确定的业务例子开始。每项检查只证明它实际覆盖的阶段；注册、生成、应用启用和业务完成分别核对。

## 按变化选择证据

| 目标 | 取得的证据 |
| --- | --- |
| 声明可用 | check、生成一致性、类型与真实契约签名 |
| 业务含义正确 | 对象、关系方向/基数、状态、动作结果符合需求；图谱名称与实际声明一致 |
| 数据持久保存 | 命令成功后通过安全读取独立取得，刷新仍是同一记录 |
| 权限和范围有效 | 允许主体成功，缺能力或范围外主体直接请求被拒绝 |
| 审批确实执行 | 提交事件、待办、决定、结论命令和最终业务状态对应 |
| 文件可用 | 原始字节上传、命令绑定、有权下载内容一致、越权拒绝 |
| 异步完成 | 实际任务终态和最终业务结果 |
| 页面可用 | 真实浏览器操作、错误状态及相应导航 |
| 外部或模型可用 | 实际服务、角色、协议与业务样例；fake 单独记录 |

文档、小文案和可逆样式变化按影响检查，不重复跑全套数据库回归。命令或内核行为变化应增加有意义的成功与风险回归，而非只复述实现。

## 测试环境与限制

PostgreSQL 用例在独立测试环境执行。CAGE_TEST_DATABASE_URL 供独立测试集群使用；testkit 可按配置准备临时数据库和角色，缺省环境也可能使用内嵌真实 PostgreSQL。普通应用 dev 继续连接项目已配置的数据库。

派生测试从声明推导能力、状态、范围、审计、幂等、掩码和不变量等通用性质，无法自动知道所有合法业务夹具。测试使用真实 testkit 执行，有效通过的用例能提供相应证据；其数量不代表业务需求覆盖。仍需按规则编写或运行具体业务成功链、审批选人及外部联调。

cage test 和 verify 的退出码 0 表示本次没有检查失败；Vitest 允许部分用例 skip/todo，退出码不能表示全部用例已执行。查看 .cage/test-results.json 的通过、失败、跳过及待实现数量；verify 也将摘要写入 .cage/verify.json。省略测试阶段、存在 skip/todo 或没有用例时，verify 的 complete 为 false。complete 为 true 只表示所配置门禁及报告中的用例完成，业务与浏览器证据仍单独验收。

源码修改还要人工核对文件职责、公开 API、复杂分支和边界的中文注释。生成代码从生成器维护；已执行迁移不因注释或排错改写。

## 先写一项能发现业务错误的测试

完成[关系课程](../guides/relations.md)后，可以将[评论测试完整文件](../examples/note/note-comments.test.ts)放到 note-comments.ts 旁边。它导入 it/expect、draftOf/fakeRepo/handlerCtx 和真实声明；其中一项反例为：

<!-- cage:example archived-comment-test -->
```ts
it('读到已归档父便笺时拒绝评论', async () => {
  const parent = draftOf(createNote, { status: 'archived', title: '历史纪要' });
  const input = createNoteComment.input.parse({ noteId: parent.id, body: '补充事项' });
  const result = await createNoteComment.handler(
    draftOf(createNoteComment), input,
    { notes: fakeRepo<typeof Note>([parent]) }, handlerCtx(),
  );
  expect(result).toMatchObject({ code: 'NOTE_ARCHIVED' });
});
```

完整文件另测允许创建和父对象未命中。fakeRepo 只替代只读依赖，直接调用 handler 没有经过能力、范围、schema 流水线、事务和审计；这些需要真实集成用例。测试刻意检查归档拒绝与部门来源，不能只断言“函数被调用”。

## 如实报告

| 结果 | 写什么 |
| --- | --- |
| 通过 | 实际执行的命令或行为，以及相应结果 |
| 跳过 | 程序跳过的项目、原因和覆盖缺口 |
| 未执行 | 没有运行的检查、缺少的环境或仍需的操作 |

交付包含行为变化、修改位置、生成物、迁移审查及必要配置。API 返回接受任务不等于任务完成，连接成功不等于模型质量验收，静态检查也不等于浏览器可用。

框架维护另按仓库 AGENTS.md 完成相应包、模板、教材和发布检查；业务应用按本项目脚本执行。

[返回开发手册](../README.md)
