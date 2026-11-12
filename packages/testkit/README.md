# @yss123/cage-testkit

开发测试工具：纯 handler 假依赖、独立真实 PostgreSQL、测试主体与授权、outbox 驱动及声明派生测试。它不作为生产业务写入口或日常数据库管理工具。

## 配置

安装 pnpm add -D @yss123/cage-testkit vitest，使用 Node.js 24+ 与同版本内核。在 Vitest 配置 globalSetup: ['@yss123/cage-testkit/global-setup']，并给数据库启动留出 hookTimeout。

CAGE_TEST_DATABASE_URL 可提供可丢弃独立测试集群；缺省时 setup 尝试内嵌真实 PostgreSQL。环境会创建角色和临时库，不能指向生产或普通业务集群。

## 验证真实流水线

以下是测试函数中的片段，domain 已包含 Note.create 与组织声明：

```ts
const env = await createTestEnv({ domain });
try {
  const user = await env.user({ caps: [], scopes: { Note: 'all' } });
  const result = await env.callAs(await user.ctx(), 'Note.create', { title: '无权创建' });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('FORBIDDEN');
} finally {
  await env.close();
}
```

createTestEnv 从本包导入，expect 来自测试库，domain 来自被测入口。默认按当前声明建库；历史升级要传实际 migrations 并准备旧数据，默认测试不证明迁移历史正确。

fakeRepo/draftOf/handlerCtx 只测计算，跳过权限、事务与数据库。env.insert/seedFor 是测试夹具通道；env.drain 驱动可领取消息，不代表未来重试或死信已完成。

derived 证明通用性质，不能凭空推断所有业务合法输入。跳过、失败与通过分别报告，fake 和真实第三方联调也分别取得证据。

[验证参考](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/verification.md) · [采购业务测试](https://github.com/shunshunyue/cage/blob/main/examples/purchase-admin/packages/domain/src/modules/purchase/purchase-order.test.ts)
