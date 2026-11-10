# @yss123/cage-testkit

Cage 测试工具包。提供纯 handler 的内存假依赖、真实 PostgreSQL 集成环境、测试用户/授权、手动驱动 outbox，以及声明派生的权限、状态和不变量测试。属于开发依赖，不用于生产业务写入或日常数据库管理。

## 安装

需要 Node.js 24+；与 kernel 等框架包保持同版本：

```powershell
pnpm add -D @yss123/cage-testkit vitest
```

domain 应已安装 Cage 内核，并从根入口导出组织模型 `@yss123/cage-admin/domain`。

## 配置真实数据库测试

在执行测试的包中创建 `vitest.config.ts`：

```ts
/** 测试集群由 globalSetup 管理；每个 createTestEnv 仍创建独立临时库。 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['@yss123/cage-testkit/global-setup'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
```

可通过 `CAGE_TEST_DATABASE_URL` 提供专用测试集群的管理员连接，需具备创建数据库与角色权限；否则 globalSetup 尝试启动内嵌 PostgreSQL。测试会创建角色、临时数据库和夹具，必须使用可丢弃的测试集群，不能指向生产环境。不要在输出或源码中保存连接凭据。

下面是已有 `Note.create` 业务的测试，假设测试文件与 domain 根 `index.ts` 位于同一目录；若目录不同，请调整相对导入：

```ts
/** 用完整内核流水线验证未授予能力时拒绝写入，而非只调用 handler。 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestEnv, type TestEnv } from '@yss123/cage-testkit';
import * as domain from './index.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ domain });
});

afterAll(async () => {
  if (env) await env.close();
});

test('没有创建便笺能力时拒绝创建', async () => {
  const user = await env.user({ caps: [], scopes: { Note: 'all' } });
  const result = await env.callAs(await user.ctx(), 'Note.create', {
    title: '无权限的写入',
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('FORBIDDEN');
});
```

执行 `pnpm exec vitest run`。默认按当前声明建新库，不证明历史数据升级正确；验证迁移时向 `createTestEnv({ domain, migrations })` 传实际迁移文件，并另行准备升级数据。

## 选择测试层次

| 入口 | 用途与边界 |
| --- | --- |
| `fakeRepo`、`draftOf`、`handlerCtx` | 纯 handler 计算测试，跳过权限、状态、数据库、审计和事务 |
| `sampleRecord`、`sampleValue` | 按字段形状构造样例，不保证满足业务不变量 |
| `arbitraryOf`、`arbitrarySnapshot` | fast-check 候选数据，用于探索输入和不变量边界 |
| `createTestEnv` | 独立 PostgreSQL 数据库、真实内核、安全读侧和测试身份 |
| `env.user`、`env.actorWithout`、`env.callAs` | 明确能力/范围后执行完整命令流水线 |
| `env.insert`、`env.seedFor` | 绕过命令准备夹具，仅测试可用，不能当业务写入示例 |
| `env.drain`、`env.audit` | 驱动当前可领取 outbox 与检查审计；未来重试/死信不等于已完成 |
| `derived`、`SKIP`、`DerivedTestError` | 执行声明派生测试并区分跳过与失败 |
| `@yss123/cage-testkit/global-setup` | 整轮 Vitest 的测试集群启停 |
| `@yss123/cage-testkit/pg` | 内嵌 PostgreSQL 与测试连接辅助工具 |

`env.close()` 关闭连接并尝试删除本次临时库，必须放在 teardown。外部测试集群不会由 globalSetup 停止。fake 成功、派生测试通过和真实第三方联调是不同证据；跳过项需要单独报告，不能计为通过。

## 文档

- [业务开发与验证流程](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/workflow.md)
- [采购业务测试示例](https://github.com/shunshunyue/cage/blob/main/examples/purchase-admin/packages/domain/src/modules/purchase/purchase-order.test.ts)
- [架构与权限模型](https://github.com/shunshunyue/cage/blob/main/docs/development/getting-started/architecture.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
