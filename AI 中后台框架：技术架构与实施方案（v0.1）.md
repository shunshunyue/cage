# AI 中后台框架：技术架构与实施方案（v0.1）

> 历史方案：2026-10-29 的设计基线。本文的规划、包名和协议不作为当前 API；使用框架从[开发手册](docs/development/README.md)进入，查版本交付用[发布档案](docs/releases/README.md)。

Oct 29, 2026 · @Nora Bell

## 1. 方案概览

**一句话**：用 TypeScript 写一套「笼子」框架（内核、声明原语、命令行工具、系统管理），以 npm 包发布；每个中后台项目由模板生成一个薄壳并依赖这些包，AI 在壳里写业务声明和实现，框架负责权限、状态、审计、影响分析和门禁。

> **大白话**：我们做两样东西。一是笼子本身，像一套带安全规范的施工标准件，统一维护、统一升级；二是每个后台项目，用标准件盖房子。房子由 AI 盖，但承重墙和门锁都是标准件，AI 改不了。

**目标**（与设计文档一致）

- 稳定：越权、非法状态迁移、缺失审计三类缺陷不进入生产。
- 知道影响范围：每个 PR 合并前自动列出影响清单。
- 可维护：人只审声明 diff 和影响清单。
- 快速：agent 能独立完成一个新业务模块的前后端代码。

**技术选型一览**（理由见第 3 节）

| 层 | 选择 |
| --- | --- |
| 语言 | TypeScript，前后端统一 |
| 后端 HTTP | Fastify（备选 Nest，但控制器只能生成） |
| 前端 | React 或 Vue，按团队熟悉度二选一 |
| 数据库 | PostgreSQL |
| SQL 访问 | Kysely，内核写入与读侧共用 |
| 模式与校验 | Zod |
| 测试 | Vitest、fast-check、Testcontainers |
| 仓库管理 | pnpm workspace + Turborepo |
| 部署 | Docker：api、worker 两类进程，加一个迁移任务 |

**与设计文档的关系**：《笼子基础设计》讲是什么、为什么；本文讲用什么技术、怎么做出来。原则以设计文档为准，技术细节以本文为准。

**按角色怎么读**

| 你是 | 先读 | 再读 |
| --- | --- | --- |
| 决策者 | 第 1、2、16、17、18 节 | 第 13 节使用流程 |
| 框架开发者 | 第 5、6、7、9、10 节（内核、数据库、HTTP、异步、工具链） | 第 14、15 节 |
| 业务开发者 | 第 13 节使用流程、第 12 节 AI 协作 | 第 5.5 节 handler 怎么测、第 7.2 节前端 SDK |
| 运维 | 第 2、6、11、15 节 | 第 9 节 worker 与连接器 |

文中所有代码都是可以照着实现的示意代码，类型和函数名在实现时可以调整，但分层和规则不变。贯穿全文的例子是同一个采购单（含库存锁、审批和 ERP 推送），完整声明见设计文档附录。

## 2. 总体架构

运行时只有两类进程（api、worker）和一个 PostgreSQL：写入只经过内核，读取只经过安全视图，对外调用只经过出口代理。

> **大白话**：整个系统就两个程序加一个数据库。写数据、看数据、往外发数据，各自只有一条路，每条路上都有人把关。

&#91;embedded content: 运行时架构 · 进程、数据库账号、出口\]

从上往下是一次请求的方向：api 和 worker 都只用内核账号写库，读请求和报表走只读账号，迁移由发布流水线单独执行。

### 2.1 进程与职责

| 进程 | 启动命令 | 职责 | 扩容方式 |
| --- | --- | --- | --- |
| api | node dist/main.js | HTTP 接口、认证、写入流水线、读查询 | 按请求量水平扩容，进程无状态 |
| worker | node dist/worker.js | outbox 投递、反应、定时任务、连接器、审批适配 | 按 outbox 积压扩容 |
| migrate | cage migrate | 发布前执行数据库迁移 | 每次发布跑一次，跑完即退出 |
| web | 静态文件 | 业务前端与 /admin | CDN 或 Nginx |

### 2.2 一次请求的完整路径（示例：李四提交采购单到推送 ERP）

1. 浏览器发出 POST /api/purchase-order/9f3c…/submit，带会话 cookie 和幂等键。
2. api 的认证钩子解析会话，从缓存拿到李四的上下文（角色、能力、范围）。
3. 生成的路由把请求交给内核 execute，走完 12 关，在一个事务里写业务表、审计和 outbox。
4. api 返回新快照，前端刷新详情。
5. worker 领取 OrderSubmitted，执行反应：启动审批流程。
6. 审批结束后，引擎的结论经适配器回到内核，执行 approve；发出 OrderApproved。
7. worker 领取 OrderApproved：一个反应锁库存，另一个经连接器和出口代理把采购单推给 ERP，成功后用命令回写 ERP 单号。

这 7 步里，每一次写库都经过内核，每一次外呼都经过连接器，整条链路用同一个 requestId 串起来（第 15 节）。

### 2.3 环境

| 环境 | 用途 | 数据库 | 第三方 |
| --- | --- | --- | --- |
| 本地 | cage dev 开发调试 | Docker 中的 Postgres | fake 连接器 |
| CI | 门禁与派生测试 | Testcontainers 临时库 | fake 连接器 |
| 预发布 | 验收、迁移演练 | 独立库，脱敏后的生产快照 | 第三方沙箱 |
| 生产 | 正式使用 | 主库，可加只读副本给报表 | 白名单内的真实地址 |

## 3. 技术选型

每一层的选择都回答同一个问题：它能不能让机器（编译器、数据库、CI）替人守住规则。

> **大白话**：我们不追求最新最全的技术，只挑能「把规则变成报错」的那一个。比如选 PostgreSQL，是因为它能在数据库层面拦住越权读取；选 TypeScript，是因为它能在编译时拦住「用了没声明的数据」。

| 层 | 选择 | 为什么 | 备选与取舍 |
| --- | --- | --- | --- |
| 语言 | TypeScript | 前后端一套类型；声明里的 reads 能直接推导出 handler 的参数类型，不需要代码生成 | Java 需要注解处理器生成依赖接口，内核更厚 |
| 运行时 | Node.js LTS | 与语言一致，部署简单 | Bun、Deno 待观察 |
| HTTP | Fastify | 薄、快、插件机制清晰；路由由框架生成，不需要重框架 | Nest：AI 熟、生态全，但装饰器式守卫是 opt-in；若选用，必须禁止手写控制器 |
| 数据库 | PostgreSQL | 行级安全和 security\_barrier 视图让读侧由数据库兜底；SKIP LOCKED 适合做 outbox 队列 | MySQL 没有原生行级安全，读侧只能靠视图和 SQL 改写 |
| SQL 访问 | Kysely | 类型安全的查询构建器，不藏 SQL；内核写入和读侧查询共用；可以直接查视图 | Drizzle 也可；Prisma 自带一套 schema 语言，和「本体即代码」冲突，不推荐 |
| 模式与校验 | Zod | 字段声明在底层落到 Zod schema，后端校验和前端表单共用 | Valibot 更小，可后期替换 |
| 前端框架 | React 或 Vue | 笼子只提供 SDK 和 can()，不关心框架 | React 的 AI 训练语料更多；Vue 在国内中后台组件生态成熟 |
| 前端数据层 | TanStack Query | 生成的 SDK 直接包成查询和变更 hooks，React 与 Vue 都有对应版本 | — |
| 测试 | Vitest、fast-check、Testcontainers | 单测快；fast-check 做不变量的性质测试；Testcontainers 起真实 Postgres 跑范围和行级安全测试 | Jest |
| 静态检查 | ESLint、dependency-cruiser | 依赖规则（谁不能导入谁）交给 dependency-cruiser，代码规则交给 ESLint 插件 | — |
| 仓库管理 | pnpm workspace + Turborepo | 多包管理与增量构建 | Nx 功能更全，也更重 |
| 审批引擎 | 待定（D4） | 见设计文档第 10 节 | Warm-Flow、Flowable 是 Java 生态，需要独立服务化 |
| 可观测 | OpenTelemetry + pino | 跟踪一次命令从 HTTP 到 outbox 再到第三方的完整链路 | — |
| 部署 | Docker | api 与 worker 用同一镜像、不同启动命令 | — |

## 4. 仓库与包结构

框架拆成九个包（approval 可选），业务项目只有四个主要目录。依赖方向是固定的，由 dependency-cruiser 在 CI 里检查：前端只能依赖 contracts，业务声明只依赖内核。

> **大白话**：框架像一套分好类的工具箱，每个抽屉只放一类工具；业务项目只拿需要的抽屉，而且前端那只手够不到后端的抽屉。

&#91;embedded content: 包结构与依赖方向\]

上半部分是每个业务项目都有的四块，下半部分是框架包。connectors 由 domain 里的连接器声明使用，lint、testkit、cli 只在开发和 CI 时使用，不进入生产镜像。

### 4.1 框架包清单

| 包 | 职责 | 谁依赖它 |
| --- | --- | --- |
| @cage/kernel | 原语、写入流水线、范围组合子、worker 运行时 | domain、http、cli、admin |
| @cage/http | Fastify 插件：路由生成、认证、错误处理 | apps/api |
| @cage/client | 前端 SDK 运行时：请求、错误码、can()、查询 hooks | contracts |
| @cage/cli | cage 命令：gen、check、impact、test、verify、upgrade | 开发与 CI |
| @cage/admin | 组织模型声明与 /admin 系统管理前端 | apps/api 挂载 |
| @cage/connectors | 连接器原语与运行时 | domain |
| @cage/approval | 审批适配接口与桥接（可选） | apps/api |
| @cage/testkit | 派生测试运行器、fake 仓储、录制回放 | 测试代码 |
| @cage/lint | dependency-cruiser 规则与 ESLint 插件 | 开发与 CI |

### 4.2 框架仓库目录

```text
cage/
  packages/
    kernel/          # 内核：primitives/ pipeline/ scope/ worker/ db/
    http/            # Fastify 插件
    client/          # 前端 SDK 运行时
    cli/             # 命令行：extract、impact、derive、rules、gen
    admin/           # 组织模型与系统管理
    connectors/      # 连接器
    approval/        # 审批适配（可选）
    testkit/         # 测试工具
    lint/            # 静态规则
  templates/app/     # create-cage-app 模板
  examples/          # 标准范例，同时也是框架的集成测试
  docs/errors/       # 错误码册，每码一个文件
  AGENTS.md          # 框架仓库自己的 agent 规则：内核改动需要架构负责人批准
```

### 4.3 业务项目目录（模板生成）

```text
purchase-admin/
  apps/
    api/src/main.ts       # api 启动入口，约 10 行
    api/src/worker.ts     # worker 启动入口，约 10 行
    web/                  # 前端（React 或 Vue），AI 自由编写
  packages/
    domain/src/           # 声明与 handler：每个聚合一个文件
    domain/src/index.ts   # 统一导出，抽取器和内核都从这里读
    contracts/            # 生成物：前端 SDK（不要手改）
  db/migrations/          # 迁移文件（人审后提交）
  generated/              # 其他生成物：SQL、派生测试、状态图（不入库）
  AGENTS.md               # 托管区 + 本项目约定
  package.json            # 只写 @cage/* 的版本号
```

**domain 包的统一导出**：这是整个业务的入口。没有从这里导出的声明，内核和抽取器都看不到，所以 cage check 会报「有声明文件未被导出」。

```ts
// packages/domain/src/index.ts
export * from './purchase-order';         // 采购单：聚合、命令、事件、审批绑定
export * from './inventory';              // 库存与库存锁，含锁库存和解锁的反应
export * from './connectors/erp';         // ERP 连接器声明
export * from './sync/erp-push';          // 推送 ERP 的出站映射
export * from './sync/erp-inbound';       // ERP 回调的入站映射
export * from './jobs';                   // 定时任务
export * from './queries';                // 报表与对账查询
```

**项目的 package.json**：只有版本号，没有任何框架代码的副本。

```jsonc
{
  "name": "purchase-admin",              // 项目名
  "private": true,                       // 不发布到 npm
  "scripts": {
    "dev": "cage dev",                   // 本地开发
    "verify": "cage verify"              // 提交前跑全部门禁
  },
  "dependencies": {
    "@cage/kernel": "1.4.2",             // 内核，所有 @cage 包版本号一致
    "@cage/http": "1.4.2",               // HTTP 层
    "@cage/admin": "1.4.2",              // 系统管理
    "@cage/connectors": "1.4.2"          // 第三方连接器
  },
  "devDependencies": {
    "@cage/cli": "1.4.2",                // 命令行，只在开发和 CI 用
    "@cage/lint": "1.4.2",               // 静态规则
    "@cage/testkit": "1.4.2"             // 测试工具
  }
}
```

## 5. 内核实现（@cage/kernel）

内核只做三件事：提供声明原语、执行写入流水线、提供读侧上下文。体积目标 5,000 行以内，不含任何业务名词。本节按「原语怎么写、类型怎么锁、流水线怎么跑、并发和幂等怎么处理、怎么测」的顺序给出可以照着实现的代码，所有代码逐行注释。

> **大白话**：内核就是那扇门的锁芯。它要小到一两个人能完全看懂，因为所有项目的安全都压在它身上。

### 5.1 声明原语怎么实现

**做法**：原语就是普通函数。调用 aggregate(...) 不连数据库、不注册全局状态，只返回一个「描述对象」，里面装着这个业务对象的全部规则。描述对象带一个内部品牌标记，抽取器和内核都靠这个标记把它认出来。

**为什么不用装饰器或全局注册表**：装饰器依赖类和反射，类型推导弱；全局注册表依赖导入顺序，抽取器很难静态分析。返回普通对象，TypeScript 能推导出完整类型，抽取器也只需要「导入模块、遍历导出值」。

**命令名从哪里来**：内核启动时遍历 domain 包的导出，用导出的变量名作为命令名。所以 export const approve = command(PurchaseOrder, …) 的能力点就是 PurchaseOrder.approve，不需要再手写一遍名字，也就不会写错。

**示例 1：字段原语**

```ts
// packages/kernel/src/primitives/fields.ts
import { z } from 'zod';                                          // 字段的底层校验用 Zod

export type SensitiveKind =                                       // 敏感种类是封闭集合，决定掩码方式
  'phone' | 'idCard' | 'bankCard' | 'email' | 'name' | 'address';

export interface FieldDef<T extends z.ZodTypeAny> {
  zod: T;                                                         // 校验规则，前后端共用
  sql: string;                                                    // 对应的 Postgres 列类型，生成表结构时用
  sensitive?: SensitiveKind;                                      // 敏感种类，没有就是普通字段
  ref?: string;                                                   // 引用的聚合名，抽取器据此画引用边
}

function field<T extends z.ZodTypeAny>(zod: T, sql: string) {
  const def: FieldDef<T> = { zod, sql };                          // 基础定义
  return Object.assign(def, {                                     // 附加一个链式方法
    sensitive: (kind: SensitiveKind) => ({ ...def, sensitive: kind }), // 用法：text().sensitive('phone')
  });
}

export const text = () => field(z.string().max(500), 'text');     // 文本，最长 500 字
export const int = () => field(z.number().int(), 'integer');      // 整数
export const money = () =>                                        // 金额
  field(z.string().regex(/^\d+(\.\d{1,2})?$/), 'numeric(18,2)');  // 用字符串传输，避免浮点误差
export const id = () => field(z.string().uuid(), 'uuid');         // 主键或外键
export const ref = (to: { name: string }) =>                      // 引用另一个聚合
  ({ ...id(), ref: to.name });                                    // 本质是 uuid，额外记下引用目标
export const list = (shape: Record<string, FieldDef<any>>) =>     // 明细行，例如 list({ sku: text(), qty: int() })
  field(z.array(z.object(Object.fromEntries(                      // 把每个子字段的 Zod 拼成数组元素
    Object.entries(shape).map(([k, f]) => [k, f.zod])))), 'jsonb'); // 存成 jsonb 列
```

**示例 2：aggregate 原语**

```ts
// packages/kernel/src/primitives/aggregate.ts
import { z } from 'zod';                                          // 整体校验用 Zod
import type { Fields, ScopeSpec, Snapshot } from './types';       // 内核内部类型，见 5.2

export const AGGREGATE = Symbol.for('cage.aggregate');            // 品牌标记：抽取器靠它识别聚合

export interface Aggregate<Name extends string, F extends Fields> {
  readonly [AGGREGATE]: true;                                     // 带上品牌标记
  readonly name: Name;                                            // 聚合名，同时是表名和能力点前缀
  readonly fields: F;                                             // 字段定义
  readonly scope: ScopeSpec<F>;                                   // 数据范围配置：哪个字段是部门、哪个是创建人
  readonly invariants: Record<string, (o: Snapshot<F>) => boolean>; // 不变量：普通函数
  readonly schema: z.ZodObject<any>;                              // 由 fields 拼出的整体校验
}

export function aggregate<Name extends string, F extends Fields>(
  name: Name,                                                     // 例如 'PurchaseOrder'
  def: {
    fields: F;                                                    // 字段
    scope: ScopeSpec<F>;                                          // 例如 scope.deptSubtree('deptId')
    invariants?: Record<string, (o: Snapshot<F>) => boolean>;     // 可选的不变量
  },
): Aggregate<Name, F> {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {                        // 名字必须是大驼峰，保证表名和路由稳定
    throw new Error(`[CAGE-NAME-001] 聚合名 ${name} 必须是大驼峰`); // 带错误码，agent 可查错误码册
  }
  const schema = z.object(Object.fromEntries(                     // 把每个字段的 Zod 拼成一个对象 schema
    Object.entries(def.fields).map(([k, f]) => [k, f.zod])));
  return Object.freeze({                                          // 冻结，运行时不允许被修改
    [AGGREGATE]: true as const,                                   // 品牌标记
    name,                                                         // 聚合名
    fields: def.fields,                                           // 字段
    scope: def.scope,                                             // 范围配置
    invariants: def.invariants ?? {},                             // 没写不变量时给空对象
    schema,                                                       // 拼好的校验
  });
}
```

**示例 3：command 原语**

```ts
// packages/kernel/src/primitives/command.ts
export const COMMAND = Symbol.for('cage.command');                // 品牌标记：抽取器靠它识别命令
const idOnly = z.object({ id: z.string().uuid() });               // 默认输入：只有单据 id

export function command<
  A extends AnyAggregate,                                         // 命令作用的聚合
  R extends Reads = {},                                           // 读依赖，默认没有
  I extends z.ZodTypeAny = typeof idOnly,                         // 输入 schema，默认只有 id
>(
  agg: A,                                                         // 例如 PurchaseOrder
  def: {
    from: StateOf<A> | StateOf<A>[] | 'new';                      // 起始状态；'new' 表示新建
    to: StateOf<A>;                                               // 目标状态
    input?: I;                                                    // 输入校验
    reads?: R;                                                    // 读依赖，决定 handler 能拿到什么
    emits?: AnyEvent[];                                           // 发出的事件
    constraints?: Constraint<A>[];                                // 硬约束组合子
    invokedBy?: 'user' | 'process' | 'job' | 'external';          // 谁能调用，默认 user
    handler: (                                                    // AI 写的业务逻辑
      o: Draft<A>,                                                //   当前单据的可修改草稿
      input: z.infer<I>,                                          //   校验过的输入
      deps: DepsOf<R>,                                            //   只读依赖，类型由 reads 推导
    ) => Promise<Draft<A> | DomainError>;                         //   返回新草稿或业务错误
  },
): Command<A, R, I> {
  if (def.from !== 'new' && !hasStates(agg, def.from)) {          // 起始状态必须是聚合声明过的状态
    throw new Error('[CAGE-STATE-001] from 里有未声明的状态');      // 构建期就报错
  }
  return Object.freeze({                                          // 返回冻结的描述对象
    [COMMAND]: true as const,                                     // 品牌标记
    agg,                                                          // 所属聚合
    from: def.from,                                               // 起始状态
    to: def.to,                                                   // 目标状态
    input: def.input ?? idOnly,                                   // 没写输入时默认只要 id
    reads: def.reads ?? {},                                       // 默认没有读依赖
    emits: def.emits ?? [],                                       // 默认不发事件
    constraints: def.constraints ?? [],                           // 默认没有硬约束
    invokedBy: def.invokedBy ?? 'user',                           // 默认由用户调用
    handler: def.handler,                                         // 业务逻辑
  }) as Command<A, R, I>;                                         // 命令名稍后由导出名补上
}
```

### 5.2 用类型把依赖锁死

**做法**：command 里写了 reads，handler 的第三个参数类型就从 reads 推出来。没声明的东西在类型上不存在，AI 写了就编译不过；status 在草稿类型里是只读的，handler 改不了状态。

```ts
// packages/kernel/src/primitives/types.ts（节选）
export type Reads = Record<string, AnyAggregate>;                 // reads 的形状：别名 -> 聚合

export interface ReadRepo<A extends AnyAggregate> {               // 注入给 handler 的只读仓储
  get(id: string): Promise<SnapshotOf<A> | null>;                 // 按 id 取一条，范围外返回 null
  find(where: Partial<SnapshotOf<A>>): Promise<SnapshotOf<A>[]>;  // 简单条件查询，自动附加范围
  count(where: Partial<SnapshotOf<A>>): Promise<number>;          // 计数，同样自动附加范围
}

export type DepsOf<R extends Reads> = {
  readonly [K in keyof R]: ReadRepo<R[K]>;                        // reads 里每个别名都变成一个只读仓储
};

export type Draft<A extends AnyAggregate> =
  Omit<SnapshotOf<A>, 'status' | 'id' | 'version'>                // 可改的字段：去掉状态、主键、版本号
  & { readonly status: StateOf<A>; readonly id: string };         // 状态和主键只读，handler 改不了
```

**效果演示**：下面是业务代码，注释标出编译器在哪一行拦下。

```ts
// packages/domain/src/purchase-order.ts（业务代码）
export const approve = command(PurchaseOrder, {
  from: 'pending_approval',                                       // 只能从待审批开始
  to: 'approved',                                                 // 审批通过
  invokedBy: 'process',                                           // 只接受审批流程调用
  reads: { stock: Inventory },                                    // 只声明了要读库存
  handler: async (order, _input, deps) => {
    const s = await deps.stock.get(order.items[0].sku);           // 可以：stock 在 reads 里
    const v = await deps.supplier.get(order.supplierId);          // 编译错误：supplier 不在 reads 里
    order.status = 'approved';                                    // 编译错误：status 是只读的
    return order;                                                 // 返回修改后的草稿
  },
});
```

**这样做的好处**：「依赖要声明」不再是一条需要 AI 记住的规范，而是写错就跑不起来的事实。影响分析读的也是 reads，所以声明和真实依赖不可能不一致。

### 5.3 写入流水线

**做法**：execute 是内核唯一的写入入口。HTTP、审批流程、定时任务、反应、批量导入都调用它，所以检查只写一遍，顺序永远一样。新建类命令（from 为 new）跳过第 4、5 关，由内核生成 id 和初始版本号。

```ts
// packages/kernel/src/pipeline/execute.ts
export async function execute(
  cmd: AnyCommand,                                                // 要执行的命令（来自注册表）
  raw: unknown,                                                   // 调用方传来的原始输入
  ctx: Ctx,                                                       // 当前主体：用户、角色、能力、范围
): Promise<Snapshot> {
  if (!ctx.actor) throw cageError('UNAUTHENTICATED');             // 第 1 关：没有身份直接拒绝
  const input = parseOrThrow(cmd.input, raw);                     // 第 2 关：Zod 校验输入，失败抛 INVALID_INPUT
  assertInvoker(cmd, ctx);                                        // 第 3 关之一：流程专用命令只接受流程身份
  assertCapability(ctx, cmd.capability);                          // 第 3 关之二：没有能力点抛 FORBIDDEN
  return db.transaction().execute(async (tx) => {                 // 后面所有步骤在同一个数据库事务里
    const claim = await idempotency.claim(tx, ctx.idempotencyKey); // 幂等：先抢占幂等键（见 5.4）
    if (!claim.fresh) return claim.result;                        // 执行过的请求直接返回上次结果
    await setSessionVars(tx, ctx);                                // 写入会话变量，供行级安全策略使用
    const cur = await loadScoped(tx, cmd.agg, input.id, ctx);     // 第 4 关：按范围加载并加行锁
    if (!cur) throw cageError('NOT_FOUND');                       // 范围外和不存在一律 404
    assertFrom(cmd, cur.status);                                  // 第 5 关：当前状态必须在 from 里
    await checkConstraints(cmd, cur, ctx);                        // 第 6 关：职责分离、额度、二次认证
    const deps = bindReads(tx, cmd.reads, ctx);                   // 第 7 关：只把 reads 里的聚合做成只读仓储
    const result = await cmd.handler(draftOf(cur), input, deps);  // 第 8 关：调用 AI 写的 handler
    if (isDomainError(result)) throw result;                      // 业务错误导致整个事务回滚
    const next = { ...cur, ...result, status: cmd.to };           // 第 9 关：状态只由内核推进
    checkInvariants(cmd.agg, next);                               // 第 10 关：逐条校验不变量
    await persist(tx, cmd.agg, cur, next);                        // 第 11 关：带版本号写入，冲突抛 CONFLICT
    await writeAudit(tx, ctx, cmd, cur, next);                    // 同一事务写审计，敏感字段掩码
    const events = buildEvents(cmd.emits, next);                  // 组装本次要发出的事件
    await outbox.enqueue(tx, events);                             // 事件写入 outbox 表
    await runSameTxReactions(tx, events, ctx);                    // tx 为 same 的反应在这里执行
    await idempotency.complete(tx, ctx.idempotencyKey, next);     // 记录幂等结果
    return next;                                                  // 第 12 关：函数返回即提交事务
  });
}
```

**按范围加载**：第 4 关把「能不能看到这条数据」直接写进 SQL 条件，范围外的数据根本查不出来，不存在「先查出来再判断」的漏洞。

```ts
// packages/kernel/src/pipeline/load.ts
export async function loadScoped(tx: Tx, agg: AnyAggregate, id: string, ctx: Ctx) {
  const where = compileScope(agg.scope, ctx.scopes[agg.name], ctx); // 把范围组合子翻译成 SQL 条件
  return tx
    .selectFrom(`core.${tableOf(agg)}` as any)                    // 从业务表读（内核账号）
    .selectAll()                                                  // 取全部字段
    .where('id', '=', id)                                         // 按主键
    .where(where)                                                 // 附加范围条件：范围外等于查不到
    .forUpdate()                                                  // 行锁，防止并发修改同一条
    .executeTakeFirst();                                          // 只取一条，没有就返回 undefined
}
```

**范围组合子的翻译**：只认识封闭的几种组合子，每种都有一段固定的 SQL。未配置时按「仅本人」处理，与设计文档一致。

```ts
// packages/kernel/src/scope/compile.ts
import { sql } from 'kysely';                                     // Kysely 的参数化 SQL 片段

export function compileScope(spec: ScopeSpec, grant: ScopeGrant | undefined, ctx: Ctx) {
  const g = grant ?? { combinator: 'self' as const };             // 没配置时按「仅本人」处理
  switch (g.combinator) {                                         // 只认识封闭的几种组合子
    case 'all':                                                   // 全部数据（租户条件在外层另加）
      return sql<boolean>`true`;
    case 'self':                                                  // 本人：聚合必须有创建人字段
      return spec.ownerField
        ? sql<boolean>`${sql.ref(spec.ownerField)} = ${ctx.userId}`  // 创建人等于当前用户
        : sql<boolean>`false`;                                    // 没有创建人字段就什么都看不到
    case 'dept':                                                  // 本部门
      return sql<boolean>`${sql.ref(spec.deptField)} = ${ctx.deptId}`;
    case 'deptSubtree':                                           // 本部门及下级：按祖先路径前缀匹配
      return sql<boolean>`${sql.ref(spec.deptField)} in (
        select id from sys.dept where ancestors like ${ctx.deptPath + '%'})`;
    case 'deptSet':                                               // 角色配置的部门集合
      return sql<boolean>`${sql.ref(spec.deptField)} = any(${g.deptIds})`;
    default:                                                      // 出现未知组合子，说明授权数据异常
      throw new Error('[CAGE-SCOPE-001] 未知的范围组合子');
  }
}
```

所有值都经过 Kysely 参数化，字段名通过 sql.ref 引用，没有任何字符串拼接，也就不会出现若依 dataScope 那类 SQL 注入。

### 5.4 并发与幂等

**两个人同时编辑同一张单**：每张业务表都有 version 列。前端提交时带上它看到的版本号 expectedVersion，execute 把它传给 persist。加载时的行锁防止同一时刻两个事务交错，版本号防止「拿着过期页面提交」。

```ts
// packages/kernel/src/pipeline/persist.ts
export async function persist(
  tx: Tx,                                                         // 当前事务
  agg: AnyAggregate,                                              // 要写的聚合
  cur: Snapshot,                                                  // 加载时的旧快照
  next: Snapshot,                                                 // handler 和内核处理后的新快照
  expected?: number,                                              // 前端看到的版本号（可选）
) {
  if (expected !== undefined && expected !== cur.version) {       // 前端的版本号和库里不一致
    throw cageError('CONFLICT');                                  // 页面已过期，提示用户刷新
  }
  const changed = diffFields(cur, next);                          // 只更新真正变化的字段
  const res = await tx
    .updateTable(`core.${tableOf(agg)}` as any)                   // 更新业务表
    .set({ ...changed, version: cur.version + 1, updated_at: sql`now()` }) // 版本号加一，记录更新时间
    .where('id', '=', cur.id)                                     // 同一条记录
    .where('version', '=', cur.version)                           // 且版本号没被别人改过
    .executeTakeFirst();                                          // 执行更新
  if (Number(res.numUpdatedRows) === 0) {                         // 影响 0 行说明被别人抢先改了
    throw cageError('CONFLICT');                                  // 报冲突，由调用方重试
  }
}
```

**同一个请求被重复提交**（用户双击、网络重试）：请求头带 Idempotency-Key，内核在事务开头先「抢占」这个键。唯一约束让并发的第二个请求等第一个提交后再判断，最终只执行一次。

```ts
// packages/kernel/src/pipeline/idempotency.ts
export const idempotency = {
  async claim(tx: Tx, key?: string) {
    if (!key) return { fresh: true as const };                    // 没带幂等键：当作新请求
    const row = await tx.insertInto('sys.idempotency')            // 先抢占这个键
      .values({                                                   // 插入一条「执行中」的记录
        key,                                                      //   幂等键
        status: 'running',                                        //   状态：执行中
        expires_at: sql`now() + interval '24 hours'`,             //   24 小时后过期
      })
      .onConflict((oc) => oc.column('key').doNothing())           // 键已存在就什么都不做
      .returning('key')                                           // 插入成功会返回这一行
      .executeTakeFirst();
    if (row) return { fresh: true as const };                     // 抢到了：继续执行
    const prev = await tx.selectFrom('sys.idempotency')           // 没抢到：说明之前执行过
      .select(['result'])                                         // 取上次的结果
      .where('key', '=', key)                                     // 按键查
      .executeTakeFirstOrThrow();
    return { fresh: false as const, result: prev.result };        // 把上次结果交回给调用方
  },
  async complete(tx: Tx, key: string | undefined, result: unknown) {
    if (!key) return;                                             // 没带键不记录
    await tx.updateTable('sys.idempotency')                       // 与业务写入同一事务提交
      .set({ status: 'done', result: JSON.stringify(result) })    // 记下结果
      .where('key', '=', key)                                     // 对应的键
      .execute();
  },
};
```

**示例**：用户双击「提交」，浏览器发出两个同键请求 A 和 B。A 抢到键并执行；B 的插入被唯一索引挡住，等 A 提交；A 提交后 B 的插入冲突、什么都不做，转而读到 A 的结果返回。如果 A 回滚了，B 的插入会成功并正常执行。数据库里只会有一次状态变更和一条审计。

### 5.5 handler 怎么测

**做法**：handler 不碰数据库，测试时把读依赖换成内存假对象，直接调用函数。这类测试毫秒级，AI 每改一次都能跑。权限、范围、状态这些测试由工具链自动生成（第 10 节），不用手写；手写的只有业务逻辑本身。

```ts
// packages/domain/src/purchase-order.test.ts（项目代码）
import { describe, it, expect } from 'vitest';                   // 测试框架
import { fakeRepo, draftOf } from '@cage/testkit';                // 测试工具：内存只读仓储、构造草稿
import { approve } from './purchase-order';                       // 被测命令

describe('approve', () => {                                       // 针对审批通过命令
  it('库存不足时返回 STOCK_SHORT', async () => {                   // 用例：库存不够
    const order = draftOf(approve, {                              // 构造一张待审批的采购单草稿
      items: [{ sku: 'A-01', qty: 10 }],                          // 需要 10 件
    });
    const deps = {                                                // 只提供 reads 里声明的依赖
      stock: fakeRepo([{ id: 'A-01', available: 3 }]),            // 假库存：只有 3 件
    };
    const res = await approve.handler(order, { id: order.id }, deps); // 直接调用 handler，不需要数据库
    expect(res).toMatchObject({ code: 'STOCK_SHORT' });           // 断言返回了业务错误
  });
});
```

### 5.6 走一遍：李四提交一张采购单

背景：李四是采购部的采购员，角色「采购员」被授予 PurchaseOrder.create、PurchaseOrder.submit、PurchaseOrder.read 三个能力点，数据范围是「仅本人」。他在页面上点了「提交」。

| 关 | 发生了什么 | 用到的规则 |
| --- | --- | --- |
| 1 认证 | 认证插件解析 cookie，得到 actor = 李四 | 会话 |
| 2 输入 | { id: '9f3c…', expectedVersion: 3 } 通过校验 | 命令的输入 schema |
| 3 能力 | 李四的能力集合里有 PurchaseOrder.submit | 上下文缓存 |
| 4 加载 | 执行 select … where id = '9f3c…' and created\_by = 李四 for update；如果这张单是王五建的，这里查不到，直接返回 404 | 范围组合子 self |
| 5 状态 | 当前状态 draft 在 from 里 | 命令声明 |
| 6 约束 | submit 没有硬约束，跳过 | — |
| 7 依赖 | submit 没有 reads，deps 为空对象 | — |
| 8 handler | 检查明细不为空，返回草稿 | AI 写的代码 |
| 9 状态 | 内核把状态改成 pending\_approval | 命令声明 |
| 10 不变量 | amountPositive、hasItems 都成立 | 聚合声明 |
| 11 写入 | 版本号 3 变 4；写一条审计（李四提交 9f3c…，状态 draft → pending\_approval）；写一条 outbox（OrderSubmitted） | — |
| 12 提交 | 事务提交并返回新快照；随后 worker 投递 OrderSubmitted，审批适配器启动流程 | — |

## 6. 数据库设计

PostgreSQL 一个库，分四个模式、四个账号：业务表和系统表只能由内核账号写，读侧账号只能看安全视图，迁移账号只在发布时使用。除系统表外，所有表结构、视图、策略都由声明生成，不手写。

> **大白话**：同一个数据库里隔出几个房间，给不同的程序不同的钥匙。AI 写的报表 SQL 拿的是只读钥匙，而且只能进「已经过滤和打码」的那个房间。

### 6.1 模式与账号

| 模式 | 内容 | 谁能写 | 谁能读 |
| --- | --- | --- | --- |
| core | 业务聚合表（由声明生成） | 内核账号 | 内核账号、视图属主 |
| sys | 系统表：组织、授权、审计、outbox、幂等、同步记录 | 内核账号（审计只能插入） | 内核账号 |
| safe | 安全视图（由声明生成） | 无 | 读侧账号 |
| flow | 审批引擎自己的表（若采用） | 引擎 | 引擎 |

| 账号 | 权限 | 使用者 |
| --- | --- | --- |
| cage\_app | core、sys 读写，但没有删除权；sys.audit\_log 只能插入 | api、worker 进程里的内核 |
| cage\_read | 只有 safe 模式下视图的 SELECT | ORM 读查询、手写报表 SQL、导出 |
| cage\_view\_owner | 安全视图的属主，只有基表 SELECT；不能登录 | 无 |
| cage\_migrate | DDL 权限 | 发布时的迁移任务，不进入应用进程 |

业务数据不物理删除：「删除」也是一个命令，把状态迁移到 deleted，所以内核账号根本不需要 DELETE 权限。这样就算内核代码有 bug，也删不掉数据。

**初始化脚本（框架提供，建库时执行一次）**

```sql
-- db/bootstrap.sql
CREATE SCHEMA core;                                   -- 业务聚合表
CREATE SCHEMA sys;                                    -- 系统表
CREATE SCHEMA safe;                                   -- 安全视图

CREATE ROLE cage_app LOGIN;                           -- 内核账号：api 和 worker 用它写数据
CREATE ROLE cage_read LOGIN;                          -- 读侧账号：ORM 查询、报表、导出用它
CREATE ROLE cage_view_owner NOLOGIN;                  -- 视图属主：不能登录，只用来持有视图
CREATE ROLE cage_migrate LOGIN;                       -- 迁移账号：只在发布流水线里使用

GRANT USAGE ON SCHEMA core, sys TO cage_app;          -- 内核账号能访问业务表和系统表
GRANT USAGE ON SCHEMA core, sys TO cage_view_owner;   -- 视图属主需要读基表
GRANT USAGE ON SCHEMA safe TO cage_read;              -- 读侧账号只能进 safe 模式
REVOKE ALL ON SCHEMA core, sys FROM cage_read;        -- 明确收回读侧账号对基表模式的一切权限

ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE ON TABLES TO cage_app; -- 以后迁移建的业务表，自动给内核账号读写，不给删除
ALTER DEFAULT PRIVILEGES FOR ROLE cage_migrate IN SCHEMA core
  GRANT SELECT ON TABLES TO cage_view_owner;          -- 视图属主只能读
```

### 6.2 由声明生成的业务表

**示例**：设计文档附录里的 PurchaseOrder 声明，运行 cage gen 后得到下面这张表。每一列都能在声明里找到来源。

```sql
-- 生成物：generated/sql/core.purchase_order.sql（不要手改）
CREATE TABLE core.purchase_order (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- 主键，由内核生成
  tenant_id      uuid NOT NULL,                              -- 租户（启用多租户时才有）
  dept_id        uuid NOT NULL REFERENCES sys.dept(id),      -- 来自 deptId: ref(Dept)，部门类范围依赖它
  created_by     uuid NOT NULL REFERENCES sys.user(id),      -- 来自 createdBy: ref(User)，「仅本人」依赖它
  supplier_phone text,                                       -- 来自 text().sensitive('phone')，读侧会被掩码
  amount         numeric(18,2) NOT NULL,                     -- 来自 money()
  items          jsonb NOT NULL,                             -- 来自 list(...)，明细存为 jsonb
  status         text NOT NULL CHECK (status IN (            -- 来自 states(...)：数据库层也限制取值
                   'draft', 'pending_approval', 'approved', 'rejected', 'cancelled')),
  version        integer NOT NULL DEFAULT 1,                 -- 乐观锁版本号
  created_at     timestamptz NOT NULL DEFAULT now(),         -- 创建时间
  updated_at     timestamptz NOT NULL DEFAULT now()          -- 更新时间
);
CREATE INDEX ON core.purchase_order (tenant_id, dept_id);    -- 部门类范围条件用
CREATE INDEX ON core.purchase_order (tenant_id, created_by); -- 「仅本人」范围用
CREATE INDEX ON core.purchase_order (status);                -- 列表按状态筛选用
```

**生成规则**

| 声明 | 生成的数据库结构 |
| --- | --- |
| 字段类型 | 列类型取 FieldDef.sql；必填字段加 NOT NULL |
| ref(X) | uuid 列加外键 |
| states | text 列加 CHECK 约束，数据库层也不允许非法状态 |
| scope 用到的字段 | 自动建索引，避免范围过滤拖慢查询 |
| sensitive | 列本身不变，掩码在安全视图里做 |
| 每张表 | 自动加 id、version、created\_at、updated\_at，启用多租户时加 tenant\_id |

### 6.3 系统表

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| sys.user、sys.dept、sys.role | 组织模型（本身也是聚合） | dept 带 ancestors 祖先路径 |
| sys.role\_capability | 角色拥有的能力点 | role\_id、capability、params（额度等） |
| sys.role\_scope | 角色在各聚合上的数据范围 | role\_id、aggregate、combinator、args |
| sys.user\_role | 用户与角色 | user\_id、role\_id |
| sys.audit\_log | 审计，按月分区，只追加 | actor、on\_behalf\_of、command、aggregate\_id、diff、result |
| sys.outbox | 待投递事件 | event、payload、aggregate\_id、status、attempts、next\_at |
| sys.processed\_event | 反应去重 | event\_id、reaction（联合唯一） |
| sys.idempotency | 命令幂等 | key、status、result、expires\_at |
| sys.sync\_record | 第三方写操作的同步状态 | connector、operation、ref\_id、status、attempts |
| sys.dead\_letter | 死信 | 原事件、错误、处理人、处理结果 |

**两张关键系统表的结构**

```sql
-- sys.outbox：待投递事件
CREATE TABLE sys.outbox (
  id            bigserial PRIMARY KEY,                -- 自增 id，决定投递顺序
  event         text NOT NULL,                        -- 事件名，例如 OrderApproved
  aggregate_id  uuid NOT NULL,                        -- 来源聚合 id，同一聚合内保序
  payload       jsonb NOT NULL,                       -- 事件载荷（敏感字段已掩码）
  trace         jsonb,                                -- 链路追踪上下文，异步处理时接上
  status        text NOT NULL DEFAULT 'pending',      -- pending、done、dead
  attempts      int NOT NULL DEFAULT 0,               -- 已尝试次数
  next_at       timestamptz NOT NULL DEFAULT now(),   -- 下次可投递时间（退避用）
  created_at    timestamptz NOT NULL DEFAULT now()    -- 写入时间
);
CREATE INDEX ON sys.outbox (status, next_at);         -- 投递器按这两列领取

-- sys.audit_log：审计，按月分区，只追加
CREATE TABLE sys.audit_log (
  id            bigserial,                            -- 自增 id
  at            timestamptz NOT NULL DEFAULT now(),   -- 发生时间，也是分区键
  actor         uuid NOT NULL,                        -- 操作主体（用户或系统身份）
  on_behalf_of  uuid,                                 -- 系统身份代表的真人
  source        text NOT NULL,                        -- api、process、job、import、external
  command       text NOT NULL,                        -- 例如 PurchaseOrder.submit
  aggregate_id  uuid,                                 -- 操作对象
  result        text NOT NULL,                        -- ok 或错误码
  diff          jsonb,                                -- 变更前后差异，敏感字段掩码
  request_id    text,                                 -- 关联请求
  PRIMARY KEY (id, at)                                -- 分区表的主键必须包含分区键
) PARTITION BY RANGE (at);                            -- 按时间范围分区，每月一个分区
GRANT INSERT ON sys.audit_log TO cage_app;            -- 内核账号只能插入
REVOKE UPDATE, DELETE ON sys.audit_log FROM cage_app; -- 明确不能改、不能删
```

审计查询走系统管理接口，使用读侧账号和 safe.audit\_log 视图，内核账号本身读不到审计。

### 6.4 安全视图与行级安全

**做法**：读侧账号只拿到视图；视图属主是一个不能登录、也不是表属主的专用角色，所以通过视图读取时一定受行级安全约束；策略读取内核在事务开始时写入的会话变量。一共四步。

**第 1 步：内核把当前用户写进会话变量**

```ts
// packages/kernel/src/db/session.ts
export async function setSessionVars(tx: Tx, ctx: Ctx) {
  await sql`select
    set_config('app.user_id',   ${ctx.userId},   true),       -- 当前用户；第三个参数 true 表示只在本事务内有效
    set_config('app.tenant_id', ${ctx.tenantId}, true),       -- 当前租户
    set_config('app.dept_id',   ${ctx.deptId},   true),       -- 当前部门
    set_config('app.dept_path', ${ctx.deptPath}, true),       -- 当前部门的祖先路径，供「本部门及下级」使用
    set_config('app.scopes',    ${JSON.stringify(ctx.scopeNames)}, true), -- 各聚合的范围名，例如 {"PurchaseOrder":"self"}
    set_config('app.unmask',    ${ctx.unmaskKinds.join(',')}, true)    -- 可以看明文的敏感种类
  `.execute(tx);                                              // 在当前事务里执行；事务结束变量自动清空
}
```

**第 2 步：生成范围判断函数和掩码函数**

```sql
-- 生成物：sys.in_scope，由范围组合子生成，不手写
CREATE OR REPLACE FUNCTION sys.in_scope(agg text, dept uuid, owner uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE coalesce(
           current_setting('app.scopes', true)::jsonb ->> agg, -- 从会话变量里取这个聚合的范围名
           'self')                                            -- 没配置时按「仅本人」
    WHEN 'all'  THEN true                                     -- 全部
    WHEN 'self' THEN owner = current_setting('app.user_id', true)::uuid -- 本人
    WHEN 'dept' THEN dept = current_setting('app.dept_id', true)::uuid  -- 本部门
    WHEN 'deptSubtree' THEN dept IN (                         -- 本部门及下级
      SELECT id FROM sys.dept                                 -- 在部门表里找
      WHERE ancestors LIKE current_setting('app.dept_path', true) || '%') -- 祖先路径以当前部门开头
    ELSE false                                                -- 未知值一律看不到
  END
$$;

-- 生成物：sys.mask，按敏感种类掩码
CREATE OR REPLACE FUNCTION sys.mask(kind text, val text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN val IS NULL THEN NULL                                -- 空值不处理
    WHEN kind = ANY(string_to_array(current_setting('app.unmask', true), ',')) THEN val -- 有明文权限就原样返回
    WHEN kind = 'phone'  THEN left(val, 3) || '****' || right(val, 4)       -- 手机号：138****1234
    WHEN kind = 'idCard' THEN left(val, 4) || '**********' || right(val, 4) -- 身份证：保留前四后四
    WHEN kind = 'name'   THEN left(val, 1) || '**'           -- 姓名：只留姓
    ELSE '******'                                             -- 其他种类全部遮住
  END
$$;
```

**第 3 步：给基表加行级策略**

```sql
ALTER TABLE core.purchase_order ENABLE ROW LEVEL SECURITY;  -- 打开行级安全
CREATE POLICY scope_read ON core.purchase_order             -- 策略名
  FOR SELECT                                                -- 只管读
  TO cage_view_owner                                        -- 只对视图属主生效
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid -- 先限定租户
    AND sys.in_scope('PurchaseOrder', dept_id, created_by)  -- 再按范围组合子过滤
  );
```

**第 4 步：生成安全视图并只授权给读侧账号**

```sql
CREATE VIEW safe.purchase_order WITH (security_barrier) AS  -- security_barrier 防止条件下推泄露数据
  SELECT id, dept_id, created_by, amount, items, status,    -- 普通字段原样输出
         sys.mask('phone', supplier_phone) AS supplier_phone, -- 敏感字段经过掩码
         created_at, updated_at                             -- 时间字段
  FROM core.purchase_order;                                 -- 来自基表
ALTER VIEW safe.purchase_order OWNER TO cage_view_owner;    -- 属主是专用角色，读取时受行级安全约束
GRANT SELECT ON safe.purchase_order TO cage_read;           -- 读侧账号只拿到视图
```

**为什么忘了设置上下文也不会出事**：会话变量没设置时 current\_setting(…, true) 返回空值，策略里的比较结果为空，等同于假。结果是一条都查不到，而不是查到全部。

### 6.5 迁移

**做法**：声明决定期望结构，cage gen 把期望结构和临时库里「执行完已有迁移后的结构」做比较，生成 db/migrations/ 下的 SQL 草稿；人审后提交；发布时用迁移账号执行。安全视图、策略和两个函数每次整体重建，不写进迁移历史。

**示例：一张采购单从「一个供应商」改为「多个供应商」**。这是破坏性变更，按先扩展再收缩分三次发布：

| 步骤 | 发布 | 做什么 |
| --- | --- | --- |
| 1 扩展 | 第 1 次 | 新建关联表 purchase\_order\_supplier，旧列 supplier\_id 保留 |
| 2 双写 | 第 1 次 | 声明里新增 suppliers 字段、旧字段标记为废弃；内核写入时两边都写 |
| 3 回填 | 第 1 次之后 | 一次性迁移把历史数据写进新表 |
| 4 切读 | 第 2 次 | 查询和页面改读新字段；cage impact 会列出所有还在读旧字段的地方 |
| 5 收缩 | 第 3 次 | 从声明删掉旧字段，生成删列迁移 |

```sql
-- db/migrations/0012_backfill_po_supplier.sql（第 3 步：回填）
INSERT INTO core.purchase_order_supplier (purchase_order_id, supplier_id) -- 往新关联表写
SELECT id, supplier_id                                      -- 每张旧单据的唯一供应商
FROM core.purchase_order                                    -- 来自旧表
WHERE supplier_id IS NOT NULL                               -- 只处理有供应商的单据
ON CONFLICT DO NOTHING;                                     -- 可以重复执行，已回填的跳过
```

### 6.6 怎么验证读侧真的越不过

下面是自动生成的范围测试之一，模拟「AI 直接写裸 SQL」的情况：

```ts
// generated/tests/scope.purchase-order.test.ts（派生测试，节选）
it('读账号直接写 SQL 也查不到范围外数据', async () => {
  await seed.purchaseOrder({ createdBy: users.wangwu });        // 准备一张王五的单
  const db = await readConnectionAs(users.lisi);                // 以李四身份拿读侧连接，会话变量已设置
  const res = await sql`select * from safe.purchase_order`.execute(db); // 直接写裸 SQL 查安全视图
  expect(res.rows).toHaveLength(0);                             // 李四是「仅本人」，看不到王五的单
  await expect(                                                 // 再试图绕过视图直接查基表
    sql`select * from core.purchase_order`.execute(db),
  ).rejects.toThrow(/permission denied/);                       // 读账号没有基表权限，直接报错
});
```

## 7. HTTP 层与前端

HTTP 接口全部由声明生成，AI 不手写路由；前端只能通过生成的 SDK 访问后端，SDK 带类型、校验规则和权限判断。

> **大白话**：后端接口像自动售货机的按钮，有哪些按钮由声明决定，每个按钮背后都连着同一扇门。前端拿到的是一本自动印出来的按钮说明书，照着用就不会用错。

### 7.1 路由生成（@cage/http）

| 来源 | 生成的接口 | 说明 |
| --- | --- | --- |
| command | POST /api/{aggregate}/{id}/{command} | 新建类命令没有 id：POST /api/{aggregate}/{command} |
| 聚合读取 | GET /api/{aggregate}/{id}、GET /api/{aggregate} | 走读侧账号与安全视图，分页、排序、过滤参数统一 |
| query | GET /api/queries/{name} | 参数来自 query 声明的输入 schema |
| 导出 | POST /api/{aggregate}/export | 需要导出能力，异步生成文件 |
| 入站回调 | POST /hooks/{connector}/{event} | 先验签，再映射到命令 |
| 系统管理 | /api/sys/... | 由 @cage/admin 提供 |

**做法**：一个 Fastify 插件在启动时遍历注册表，为每个命令、聚合、查询挂路由。业务项目里禁止调用 app.get / app.post（lint 拦截），所以没有声明就没有路由。

```ts
// packages/http/src/plugin.ts
import fp from 'fastify-plugin';                                  // Fastify 插件封装
import { buildRegistry, execute, read } from '@cage/kernel';      // 内核：注册表、写入流水线、读查询

export const cagePlugin = fp(async (app, opts: { domain: object }) => {
  const reg = buildRegistry(opts.domain);                         // 遍历 domain 导出，建立注册表
  for (const cmd of reg.commands) {                               // 每个命令生成一个 POST 路由
    const base = `/api/${kebab(cmd.agg.name)}`;                   // 例如 /api/purchase-order
    const url = cmd.from === 'new'                                // 新建类命令没有 id
      ? `${base}/${kebab(cmd.name)}`                              //   例如 /api/purchase-order/create
      : `${base}/:id/${kebab(cmd.name)}`;                         //   例如 /api/purchase-order/:id/submit
    app.post(url, async (req) => {                                // 注册路由
      const input = { ...(req.body as object), id: (req.params as any).id }; // 合并路径参数和请求体
      const key = req.headers['idempotency-key'] as string | undefined;       // 取幂等键
      return execute(cmd, input, { ...req.cageCtx, idempotencyKey: key });    // 交给内核，路由本身不做任何判断
    });
  }
  for (const agg of reg.aggregates) {                             // 每个聚合生成两个读取路由
    const base = `/api/${kebab(agg.name)}`;                       // 路径前缀
    app.get(base, (req) => read.list(agg, req.query, req.cageCtx));              // 列表：走读侧账号和安全视图
    app.get(`${base}/:id`, (req) => read.get(agg, (req.params as any).id, req.cageCtx)); // 详情：范围外返回 404
  }
  for (const q of reg.queries) {                                  // 每个 query 声明生成一个 GET 路由
    app.get(`/api/queries/${kebab(q.name)}`, (req) => read.run(q, req.query, req.cageCtx));
  }
  app.setErrorHandler((err, _req, reply) => {                     // 统一错误处理
    const e = toCageError(err);                                   // 把任何异常转换成 CageError
    reply.status(e.http).send({ code: e.code, detail: e.detail }); // 返回机器可读的错误码，不泄露堆栈
  });
});
```

启动时插件还会根据注册表输出一份 OpenAPI 文档，前端 SDK 就是从这份文档和声明里的 Zod schema 生成的。

### 7.2 前端 SDK（生成到 packages/contracts）

**做法**：cage gen 为每个聚合生成一个文件：字段 schema、错误码类型、调用方法和查询 hooks。前端只能从这里引入，所以调用方式、参数、错误码都有类型检查。

```ts
// 生成物：packages/contracts/src/purchase-order.ts（不要手改）
import { z } from 'zod';                                          // 和后端同一份校验规则
import { client, useCageQuery } from '@cage/client';              // SDK 运行时：发请求、处理错误码、查询缓存

export const PurchaseOrderSchema = z.object({                     // 由声明生成的字段 schema
  id: z.string().uuid(),                                          // 主键
  amount: z.string(),                                             // 金额（字符串，避免浮点误差）
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'cancelled']), // 状态
  supplierPhone: z.string().nullable(),                           // 敏感字段：前端拿到的已经是掩码值
  version: z.number(),                                            // 版本号，提交时要带回去
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;  // 前端用的类型

export type SubmitError = 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_TRANSITION' | 'CONFLICT'; // submit 可能返回的错误码

export const purchaseOrder = {                                    // 每个命令一个方法
  submit: (id: string, expectedVersion: number) =>                // 提交
    client.post<PurchaseOrder, SubmitError>(                      // 返回值和错误码都有类型
      `/api/purchase-order/${id}/submit`, { expectedVersion }),   // client 自动生成并附带幂等键
};

export const usePurchaseOrder = (id: string) =>                   // 详情查询 hook
  useCageQuery(['purchase-order', id], `/api/purchase-order/${id}`, PurchaseOrderSchema); // 响应也用 schema 校验
```

**示例：AI 写的详情页（React）**

```tsx
// apps/web/src/pages/PurchaseOrderDetail.tsx
import { purchaseOrder, usePurchaseOrder, can } from '@app/contracts'; // 只能从 contracts 引入
import { Button, message } from 'antd';                           // UI 库

export function PurchaseOrderDetail({ id }: { id: string }) {     // 页面组件，参数是单据 id
  const { data: po } = usePurchaseOrder(id);                      // 读详情，TanStack Query 自动缓存
  if (!po) return null;                                           // 加载中或查不到时不渲染
  const onSubmit = async () => {                                  // 点击「提交」
    const res = await purchaseOrder.submit(po.id, po.version);    // 带上当前版本号
    if (res.ok) return message.success('已提交');                  // 成功提示
    switch (res.code) {                                           // 错误码是联合类型，可以穷尽处理
      case 'CONFLICT': return message.warning('单据已被修改，请刷新'); // 版本冲突
      case 'INVALID_TRANSITION': return message.error('当前状态不能提交'); // 状态不对
      default: return message.error('提交失败');                   // 其他错误
    }
  };
  return (                                                        // 渲染
    <Button disabled={!can('PurchaseOrder.submit')} onClick={onSubmit}> {/* 没有能力点时按钮置灰 */}
      提交 {/* 按钮文字 */}
    </Button>
  );
}
```

这里的 can() 只影响按钮显示。就算有人绕过前端直接调接口，内核第 3 关一样会拒绝。Vue 的写法相同，换成 @tanstack/vue-query 对应的 hooks 即可。

### 7.3 前端工程（apps/web）

**框架**：React（建议 Ant Design + TanStack Query）或 Vue（建议 Element Plus 或 Ant Design Vue + TanStack Query），二选一。页面由 AI 自由编写，框架只管三件事：依赖边界、菜单权限、表单校验。

**1. 依赖边界**：前端只能依赖 contracts 和 UI 库。规则由 @cage/lint 提供，项目里只有一行引用。

```js
// node_modules/@cage/lint/dependency-cruiser.cjs（框架提供）
module.exports = {
  forbidden: [                                                    // 禁止的依赖关系列表
    {
      name: 'web-only-contracts',                                 // 规则名，报错时显示
      severity: 'error',                                          // 违反即构建失败
      from: { path: '^apps/web' },                                // 来源：前端代码
      to: { path: '^(packages/domain|node_modules/@cage/(kernel|http))' }, // 目标：后端代码
      comment: '[CAGE-DEP-003] 前端只能依赖 @app/contracts',   // 报错信息带错误码
    },
  ],
};
```

**2. 菜单权限**：菜单的排列和文案可以自由配置，但每一项必须声明需要哪些能力点。能力点名是 contracts 里的联合类型，写错了编译失败。

```ts
// apps/web/src/menus.ts
import { can, type Capability } from '@app/contracts';          // 权限判断函数和能力点类型，由能力目录生成

export const menus: { path: string; title: string; need: Capability[] }[] = [ // 菜单定义
  { path: '/purchase-orders', title: '采购单', need: ['PurchaseOrder.read'] },   // 有读权限才显示
  { path: '/inventory', title: '库存', need: ['Inventory.read'] },               // 同上
  { path: '/reports/po-aging', title: '采购单账龄', need: ['PurchaseOrder.read'] }, // 报表也要声明
];

export const visibleMenus = () => menus.filter((m) => m.need.every(can)); // 只显示能力点都具备的菜单
```

**3. 表单校验共享**：表单直接用 contracts 里的 schema，前后端校验规则永远一致。后端把金额上限从 100 万改成 50 万，前端下次生成后自动生效。

```tsx
// apps/web/src/pages/PurchaseOrderCreate.tsx
import { useForm } from 'react-hook-form';                       // 表单库
import { zodResolver } from '@hookform/resolvers/zod';            // 让表单库使用 Zod 校验
import { schemas, purchaseOrder } from '@app/contracts';          // 后端生成的输入 schema 和调用方法

export function PurchaseOrderCreate() {
  const form = useForm({                                          // 创建表单
    resolver: zodResolver(schemas.PurchaseOrder.create),          // 校验规则和后端 create 命令的输入完全一致
  });
  const onSubmit = form.handleSubmit((v) => purchaseOrder.create(v)); // 校验通过才会调用后端
  return <form onSubmit={onSubmit}>{/* 表单字段由 AI 自由布局 */}</form>; // 布局不受限制
}
```

**4. 可选的基础组件**：框架提供列表页、表单页、详情页三个基础组件，自动处理分页、筛选、错误码提示、版本冲突刷新。用不用由 AI 决定，不强制，也不生成页面。

## 8. 认证、权限与系统管理

认证交给公司现有的登录体系，框架只负责把「登录的人」变成内核需要的上下文 ctx；授权数据由框架自带的系统管理页面维护。

> **大白话**：门卫（登录）用公司现成的；框架负责给每个进门的人发一张通行证，上面写着他能做哪些事、能看哪些部门的数据。

### 8.1 认证接入

**做法**：优先对接公司 SSO（OIDC 或 OAuth2），没有 SSO 时用框架自带的账号密码加二次认证。登录成功后在服务端建会话，浏览器只拿到一个会话 cookie。

```ts
// packages/http/src/oidc.ts（节选）
app.get('/auth/callback', async (req, reply) => {                 // SSO 登录回调
  const claims = await oidc.exchange(req.query);                  // 用授权码换取用户信息
  const user = await upsertUserFromSso(claims);                   // 首次登录创建用户，之后更新姓名和部门
  const sid = await createSession(user.id, user.tenantId);        // 在 sys.session 表里建会话
  reply.setCookie('cage_sid', sid, {                              // 写会话 cookie
    httpOnly: true,                                               // 前端脚本读不到，防 XSS 窃取
    secure: true,                                                 // 只走 HTTPS
    sameSite: 'lax',                                              // 防跨站请求伪造
    path: '/',                                                    // 全站有效
    maxAge: 8 * 3600,                                             // 8 小时过期
  });
  return reply.redirect('/');                                     // 回到首页
});
```

之后每个请求都由认证钩子把会话变成上下文：

```ts
// packages/http/src/auth.ts
export const authPlugin = fp(async (app) => {
  await app.register(cookie);                                     // 启用 cookie 解析
  app.decorateRequest('cageCtx', null);                           // 给每个请求挂一个上下文字段
  app.addHook('onRequest', async (req) => {                       // 每个请求最先执行
    if (req.url.startsWith('/hooks/')) return;                    // 第三方回调走签名验证，不走用户登录
    const sid = req.cookies['cage_sid'];                          // 取会话 cookie
    const session = sid ? await verifySession(sid) : null;        // 校验会话是否有效、是否过期
    req.cageCtx = session                                         // 有会话就组装上下文
      ? await resolveCtx(session.userId, session.tenantId)        //   用户、角色、能力、范围
      : anonymousCtx();                                           //   没有会话：匿名，只能调 public 命令
  });
});
```

系统身份不走这套流程：审批流程、定时任务、入站回调各自有固定的 actor 类型，只能调用声明了对应 invokedBy 的命令。

### 8.2 上下文解析与缓存

**做法**：每个请求都需要用户的角色、能力和范围。结果缓存在进程内；授权一旦变化，用 PostgreSQL 的 LISTEN/NOTIFY 通知所有实例清掉缓存，不需要额外引入 Redis。NOTIFY 本身是事务性的：授权命令提交成功才会发出通知，回滚就不会发。

```ts
// packages/http/src/ctx.ts
const cache = new LRU<string, Ctx>({ max: 5000, ttl: 5 * 60_000 }); // 进程内缓存：最多 5000 人，5 分钟兜底过期

export async function resolveCtx(userId: string, tenantId: string): Promise<Ctx> {
  const hit = cache.get(userId);                                  // 先查缓存
  if (hit) return hit;                                            // 命中直接返回
  const roles = await sysRepo.rolesOf(userId);                    // 用户的全部角色
  const caps = await sysRepo.capabilitiesOf(roles);               // 角色拥有的能力点（含额度参数）
  const scopes = await sysRepo.scopesOf(roles);                   // 角色在各聚合上的范围
  const dept = await sysRepo.deptOf(userId);                      // 用户所在部门及祖先路径
  const ctx: Ctx = {                                              // 组装上下文
    actor: { kind: 'user', id: userId },                          // 主体：真人
    userId,                                                       // 用户 id
    tenantId,                                                     // 租户 id
    deptId: dept.id,                                              // 部门 id
    deptPath: dept.ancestors,                                     // 部门祖先路径
    capabilities: mergeCaps(caps),                                // 多角色能力取并集，额度取最大值
    scopes: mergeScopes(scopes),                                  // 多角色范围取并集，多个条件用 OR 连接
    unmaskKinds: unmaskFrom(caps),                                // 哪些敏感种类可以看明文
  };
  cache.set(userId, ctx);                                         // 写入缓存
  return ctx;                                                     // 返回上下文
}

export async function listenForGrantChanges(pg: PgClient) {       // 进程启动时调用一次
  await pg.query('LISTEN cage_grants');                           // 订阅授权变化通知
  pg.on('notification', (n) => {                                  // 收到通知
    if (n.payload === '*') cache.clear();                         // 角色本身变化：清空全部缓存
    else cache.delete(n.payload!);                                // 某个用户的角色变化：只清这个人
  });
}
```

### 8.3 授权配置示例

管理员在 /admin 里这样配置采购场景的三个角色：

| 角色 | 能力点（节选） | 采购单范围 | 参数 |
| --- | --- | --- | --- |
| 采购员 | PurchaseOrder.create、submit、withdraw、read | 仅本人 | — |
| 部门经理 | PurchaseOrder.read、PurchaseOrder.approve（作为审批人） | 本部门及下级 | 审批额度 50,000 |
| 财务 | PurchaseOrder.read、Supplier.unmask.phone | 全部 | 审批额度 1,000,000 |

如果张三同时是采购员和部门经理：他的能力是两个角色的并集；采购单范围是「本人或本部门及下级」；审批额度取 50,000。他审批自己提交的单时，职责分离约束会拒绝，与他拥有哪些角色无关。

### 8.4 系统管理（@cage/admin）

框架自带一组后台页面和接口，作为独立的前端子应用挂在 /admin 下，和业务前端用 React 还是 Vue 无关。

| 页面 | 功能 |
| --- | --- |
| 用户与部门 | 维护组织，可从 SSO 同步 |
| 角色与授权 | 从能力目录勾选能力点、设置额度；设置每个聚合的数据范围 |
| 菜单 | 排列与文案；可见性由能力决定 |
| 审计查询 | 按人、对象、命令、时间检索 |
| 异步任务 | outbox 积压、死信查看与重放、定时任务启停 |
| 第三方同步 | 同步记录、对账差异处理 |

**这些页面自己也走内核**：角色、用户、部门都是框架自带的聚合，改授权就是调用命令，同样被鉴权、写审计。防提权用一个内置的硬约束实现：

```ts
// packages/admin/src/constraints.ts
export const noEscalation = (): Constraint<typeof Role> => ({     // 防提权约束，框架内置
  name: 'noEscalation',                                           // 约束名，出现在本体图和报错里
  check: (role, ctx, input) =>                                    // 加载之后、handler 之前执行
    ctx.capabilities.has(input.capability)                        // 操作人自己必须有这个能力点
      ? ok()                                                      // 有：放行
      : violation('[CAGE-GRANT-001] 不能授出自己没有的能力点'),     // 没有：拒绝，返回 CONSTRAINT_VIOLATED
});

// packages/admin/src/domain/role.ts（框架自带的声明，节选）
export const grantCapability = command(Role, {
  from: 'active', to: 'active',                                   // 授权不改变角色状态
  input: z.object({ id: z.string().uuid(), capability: z.string(), params: z.record(z.unknown()).optional() }), // 要授的能力点和参数
  constraints: [noEscalation()],                                  // 挂上防提权约束
  emits: [GrantsChanged],                                         // 授权变化事件：同事务反应会 NOTIFY cage_grants
  handler: async (role, input) =>                                 // 业务逻辑很简单
    ({ ...role, capabilities: [...role.capabilities, input] }),   // 把能力点加到角色上
});
```

## 9. 异步、第三方与审批

所有「不在本次请求里做完」的事情都交给 worker 进程：投递事件、执行反应、跑定时任务、调用第三方。worker 和 api 用同一份代码和镜像，只是启动命令不同。

> **大白话**：前台（api）只负责收单，后厨（worker）负责慢慢做；后厨每做完一步都记账，做失败了能重来，重来也不会做两遍。

### 9.1 worker 进程

```ts
// apps/api/src/worker.ts（模板生成，与 main.ts 同一个包、同一个镜像）
import { startWorker } from '@cage/kernel/worker';                // worker 运行时：投递器、调度器
import * as domain from '@app/domain';                            // 和 api 用同一份业务声明

startWorker({                                                     // 启动 worker 进程
  domain,                                                         // 注册表从这里建立
  concurrency: 8,                                                 // 同时处理的事件数
  pollIntervalMs: 500,                                            // 没收到 NOTIFY 时的轮询间隔
});
```

部署时 api 和 worker 用同一个镜像：api 启动命令是 node main.js，worker 是 node worker.js，各自独立扩缩容。

### 9.2 outbox 投递器

**做法**：多个 worker 实例同时从 outbox 表领取事件，靠 FOR UPDATE SKIP LOCKED 避免重复领取；同一聚合的事件严格按顺序处理。

```ts
// packages/kernel/src/worker/outbox.ts
export async function claimBatch(limit: number) {
  return db.transaction().execute(async (tx) => {                 // 领取在事务里进行
    const { rows } = await sql<OutboxRow>`
      select o.* from sys.outbox o                                -- 从 outbox 表领取
      where o.status = 'pending'                                  -- 只要待投递的
        and o.next_at <= now()                                    -- 已经到了可投递时间
        and not exists (                                          -- 同一聚合里没有更早的未完成事件
          select 1 from sys.outbox p
          where p.aggregate_id = o.aggregate_id
            and p.id < o.id and p.status <> 'done')
      order by o.id                                               -- 按写入顺序
      limit ${limit}                                              -- 一次最多领这么多
      for update skip locked                                      -- 被别的 worker 锁住的直接跳过
    `.execute(tx);
    if (rows.length > 0) {                                        // 领到了才更新
      await tx.updateTable('sys.outbox')                          // 标记为处理中，防止重复领取
        .set({ status: 'processing', locked_at: sql`now()` })     // 记录领取时间，超时未完成的会被重置
        .where('id', 'in', rows.map((r) => r.id))                 // 本批领到的事件
        .execute();
    }
    return rows;                                                  // 返回领到的事件
  });
}

export async function deliver(row: OutboxRow) {
  const reactions = registry.reactionsFor(row.event);             // 找到订阅这个事件的所有异步反应
  try {
    for (const r of reactions) await runReaction(r, row);         // 逐个执行，每个反应自己一个事务
    await markDone(row.id);                                       // 全部成功：标记完成
  } catch (err) {                                                 // 任何一个反应失败
    const attempts = row.attempts + 1;                            // 失败次数加一
    if (attempts >= MAX_ATTEMPTS) {                               // 超过上限（默认 10 次）
      await moveToDeadLetter(row, err);                           // 转入死信，等人工处理
    } else {
      await reschedule(row.id, attempts, backoff(attempts));      // 指数退避：1 秒、2 秒、4 秒……最多 1 小时
    }
  }
}
```

两个容易忽略的点：一是 worker 崩溃后「处理中」的事件会卡住，所以有一个清扫任务把 locked\_at 超过 5 分钟的重置为待投递；二是进入死信的事件会挡住同一聚合的后续事件，这是故意的，为了保证顺序，直到有人在 /admin 里处理掉它。

### 9.3 反应：事件触发另一个命令

**做法**：反应不直接改数据，而是以系统身份调用目标聚合上的命令，所以同样走完 12 关。重复投递靠 processed\_event 表去重。

```ts
// packages/domain/src/inventory.ts（业务代码：声明一个反应）
export const reserveOnApprove = reaction(OrderApproved, {        // 订阅「采购单已审批」事件
  target: InventoryLock,                                          // 作用的聚合：库存锁
  command: acquireLock,                                           // 调用库存锁上的 acquireLock 命令
  map: (e) => ({ orderId: e.orderId, items: e.items }),           // 把事件载荷映射成命令输入（纯函数）
  tx: 'outbox',                                                   // 异步执行（默认值，见 D3）
  acquires: 'inventory.lock',                                     // 声明它获得了库存锁，供配对检查使用
});
```

```ts
// packages/kernel/src/worker/reaction.ts（内核代码：执行一个反应）
export async function runReaction(r: AnyReaction, row: OutboxRow) {
  await db.transaction().execute(async (tx) => {                  // 每个反应一个独立事务
    const first = await tx.insertInto('sys.processed_event')      // 先登记「这个反应处理过这个事件」
      .values({ event_id: row.id, reaction: r.name })             // 事件 id 加反应名
      .onConflict((oc) => oc.columns(['event_id', 'reaction']).doNothing()) // 已登记过就什么都不做
      .returning('event_id')                                      // 插入成功会返回一行
      .executeTakeFirst();
    if (!first) return;                                           // 处理过了：直接跳过，保证幂等
    const input = r.map(row.payload);                             // 用业务代码里的 map 得到命令输入
    await executeIn(tx, r.command, input, systemCtx(r));          // 以系统身份调用目标命令，走完整 12 关
  });                                                             // 登记和业务写入一起提交，要么都成功要么都回滚
}
```

### 9.4 定时任务

**做法**：任务在代码里声明，写清楚会读哪些聚合、会调用哪些命令，这两项都进本体图。任务里只能读数据和调用声明过的命令，写入一样走 12 关。

```ts
// packages/domain/src/jobs.ts（业务代码）
export const expireStaleOrders = job('expireStaleOrders', {      // 任务名，也是系统身份名 job:expireStaleOrders
  cron: '0 2 * * *',                                              // 每天凌晨 2 点
  reads: [PurchaseOrder],                                         // 会读哪些聚合
  calls: [cancel],                                                // 只会调用哪些命令
  run: async ({ query, call }) => {                               // query 只读，call 只能调用 calls 里的命令
    const stale = await query.list(PurchaseOrder, {               // 找出超过 30 天还在草稿的单
      status: 'draft',                                            //   状态是草稿
      createdBefore: daysAgo(30),                                 //   创建于 30 天前
    });
    for (const po of stale) {                                     // 逐张处理
      await call(cancel, { id: po.id });                          // 每张都走完整 12 关，审计里 source = job
    }
  },
});
```

**多实例只跑一次**：调度器用 PostgreSQL 咨询锁，拿不到锁的实例直接跳过。

```ts
// packages/kernel/src/worker/scheduler.ts
async function tick(j: AnyJob, lockConn: PgClient) {              // lockConn 是调度器专用的连接
  const lockId = hash32(j.name);                                  // 每个任务一个固定的锁编号
  const r = await lockConn.query('select pg_try_advisory_lock($1) as ok', [lockId]); // 尝试拿锁，拿不到不等待
  if (!r.rows[0].ok) return;                                      // 别的实例在跑：本实例跳过
  try {
    if (!(await jobEnabled(j.name))) return;                      // 管理员在 /admin 停用了：不执行
    await j.run(jobApi(j));                                       // 执行任务，jobApi 只暴露 query 和 call
  } finally {
    await lockConn.query('select pg_advisory_unlock($1)', [lockId]); // 一定释放锁；加锁和解锁必须在同一个连接上
  }
}
```

### 9.5 第三方连接器（@cage/connectors）

**做法**：连接器声明对方系统的地址、密钥名、操作清单和调用策略；AI 只写两头的映射函数；发请求、鉴权、重试、记录都由运行时负责。下面以「审批通过后把采购单推给 ERP」为例，分四步。

**第 1 步：声明连接器**

```ts
// packages/domain/src/connectors/erp.ts（业务代码）
export const erp = connector('erp', {
  hosts: { test: 'erp-sandbox.example.com', prod: 'erp.example.com' }, // 地址白名单：测试、生产各一个
  secret: 'ERP_API_TOKEN',                                        // 只写密钥名，值由密钥管理服务注入
  timeoutMs: 5000,                                                // 超时 5 秒
  retry: { max: 5, backoff: 'exponential' },                      // 最多重试 5 次，指数退避
  rateLimit: { perSecond: 20 },                                   // 每秒最多 20 次
  operations: {                                                   // 操作清单
    pushOrder: op({                                               // 操作：推送采购单
      effect: 'retryableWrite',                                   // 副作用等级：可重试写，只能异步调用
      method: 'POST',                                             // 请求方法
      path: '/api/purchase-orders',                               // 对方接口路径
      request: z.object({                                         // 出站字段白名单：只允许发这几个字段
        externalId: z.string(),                                   //   我方单号
        amount: z.string(),                                       //   金额
        lines: z.array(z.object({ sku: z.string(), qty: z.number() })), //   明细
      }),
      response: z.object({ erpNo: z.string() }),                  // 对方返回的格式
    }),
  },
});
```

**第 2 步：AI 写出站映射**

```ts
// packages/domain/src/sync/erp-push.ts（业务代码，AI 主要写这里）
export const pushToErp = outbound(OrderApproved, erp.operations.pushOrder, { // 订阅事件，调用连接器操作
  idempotencyKey: (e) => `po-${e.orderId}`,                      // 幂等键：同一张单只推一次
  map: (e) => ({                                                  // 出站映射：我们的事件转成对方请求（纯函数）
    externalId: e.orderId,                                        // 我方单号
    amount: e.amount,                                             // 金额
    lines: e.items.map((i) => ({ sku: i.sku, qty: i.qty })),      // 明细
  }),
  onSuccess: {                                                    // 成功后怎么回写
    command: recordErpNo,                                         // 通过命令回写，而不是直接改表
    map: (res, e) => ({ id: e.orderId, erpNo: res.erpNo }),       // 把 ERP 单号写回采购单
  },
});
```

**第 3 步：运行时怎么拦**（框架代码，展示每一道管控在哪里发生）

```ts
// packages/connectors/src/runtime.ts（节选）
export async function call(op: AnyOp, payload: unknown, key: string) {
  const body = op.request.strict().parse(payload);                // 白名单外的字段直接报错，不会被悄悄发出去
  const host = op.connector.hosts[env.stage];                     // 按环境取地址，代码里写不了任意地址
  const token = await secrets.get(op.connector.secret);           // 从密钥管理服务取密钥，不落日志
  await limiter(op.connector).take();                             // 限流：超过每秒上限就等待
  const res = await fetchViaEgress(`https://${host}${op.path}`, { // 经过出口代理发出
    method: op.method,                                            // 请求方法
    headers: {                                                    // 请求头
      authorization: `Bearer ${token}`,                           //   鉴权
      'idempotency-key': key,                                     //   幂等键，对方支持时可去重
    },
    body: JSON.stringify(body),                                   // 请求体
    signal: AbortSignal.timeout(op.connector.timeoutMs),          // 超时控制
  });
  await recordCall(op, key, res.status);                          // 写调用记录到 sys.sync_record，载荷脱敏
  if (!res.ok) throw retryable(res.status);                       // 失败交给 outbox 退避重试
  return op.response.parse(await res.json());                     // 响应也按声明校验，对方格式变了立即发现
}
```

**第 4 步：对方回调我们**

```ts
// packages/domain/src/sync/erp-inbound.ts（业务代码）
export const erpReceived = inbound(erp, 'goodsReceived', {        // 生成路由 POST /hooks/erp/goods-received
  verify: hmacSha256('ERP_WEBHOOK_SECRET'),                       // 验签方式和密钥名
  payload: z.object({ erpNo: z.string(), receivedAt: z.string() }), // 对方回调的格式
  command: markReceived,                                          // 映射到的命令，以 external 身份调用
  map: (p) => ({ erpNo: p.erpNo, at: p.receivedAt }),             // 入站映射（纯函数）
});
```

映射函数都是纯函数，用录制下来的真实请求和响应样例做单测；CI 里连接器使用 fake 实现，不访问真实的 ERP。

### 9.6 审批适配（@cage/approval，可选）

**做法**：不管最后用审批引擎还是代码内封闭路由（待决策 D4），都实现同一个适配器接口。引擎只给结论，结论由桥接代码转成命令调用。

**第 1 步：统一接口**

```ts
// packages/approval/src/types.ts
export interface ApprovalAdapter {
  start(input: {                                                  // 发起审批
    process: string;                                              //   流程名，例如 po-approval
    businessKey: string;                                          //   单据 id
    vars: Record<string, unknown>;                                //   只包含声明过的 routable 字段
  }): Promise<{ instanceId: string }>;                            //   返回流程实例 id
  cancel(instanceId: string): Promise<void>;                      // 撤回时取消流程
  onCompleted(cb: (r: {                                           // 注册流程结束回调
    businessKey: string;                                          //   单据 id
    outcome: 'approved' | 'rejected';                             //   结论
    lastApprover: string;                                         //   最后一位审批人
  }) => Promise<void>): void;
}
```

**第 2 步：结论只能转成命令**

```ts
// packages/approval/src/bridge.ts
export function bindApproval(adapter: ApprovalAdapter, reg: Registry) {
  adapter.onCompleted(async (r) => {                              // 引擎给出结论时
    const binding = reg.approvalFor(r.businessKey);               // 找到这张单对应的审批绑定
    const cmd = r.outcome === 'approved'                          // 根据结论选择命令
      ? binding.onApproved                                        //   通过：approve
      : binding.onRejected;                                       //   驳回：reject
    await execute(cmd, { id: r.businessKey }, processCtx({        // 以流程身份调用，走完整 12 关
      onBehalfOf: r.lastApprover,                                 //   代表最后一位审批人，职责分离按他判断
    }));
  });
}
```

引擎侧不给任何业务表的数据库权限。如果引擎是 Java 生态的（Warm-Flow、Flowable），就把它部署成独立服务，适配器通过 HTTP 调用它，它的结论通过回调进入桥接代码。

**另一种选择：代码内封闭路由**。如果业务不需要自己拖拽改流程，可以用一小组封闭的组合子在代码里写路由，状态存在 sys 表里，并且能纳入影响分析：

```ts
// packages/domain/src/approvals/po-approval.ts（业务代码）
export const poRoute = route('po-approval', [                     // 流程名，和聚合里的 approval 绑定对应
  step('部门经理审批', approver.deptLeader('deptId')),               // 第 1 步：单据所在部门的负责人
  when(gt('amount', 50000),                                       // 金额超过 5 万时（条件也是封闭组合子）
    step('财务审批', approver.role('finance'), { mode: 'any' })),   //   第 2 步：财务角色任意一人通过即可
]);
```

这里的 step、when、gt、approver.\* 都是固定的几个函数，和范围组合子一样只能从里面选，所以抽取器能读懂：改 amount 的口径时，影响分析会把这条路由列出来。

## 10. 工具链（@cage/cli）

所有自动化都收敛到一个命令行工具 cage，本地和 CI 跑的是同一套命令。它的核心是「抽取器」：先把声明变成一张本体图，再拿这张图做规则检查、影响分析和测试生成。

> **大白话**：cage 是一个随身的质检员。AI 每改一次，就让它把所有规矩检查一遍；它说不过，就照它说的改。

### 10.1 命令清单

| 命令 | 做什么 | 谁用 |
| --- | --- | --- |
| cage create | 从模板生成项目 | 人 |
| cage dev | 起本地 Postgres、api、worker、web，声明变化时自动重新生成 | 人、agent |
| cage gen | 从声明生成 contracts、路由清单、安全视图与策略 DDL、迁移草稿、状态图 | agent、CI |
| cage check | 图规则检查：可达性、资源配对、敏感字段、事件兼容等 | agent、CI |
| cage impact --base main | 对比两张本体图，输出影响清单和需要运行的测试 | agent、CI |
| cage test | 生成并运行派生测试，再运行项目自己的测试 | agent、CI |
| cage verify | 依次运行全部门禁，本地与 CI 完全一致 | agent、CI |
| cage budget | 内核体积、原语数量、unsafe 数量检查 | CI |
| cage upgrade | 升级 @cage 包版本、运行 codemod、同步托管配置 | 人、Renovate |
| cage sync | 只同步托管配置（AGENTS.md 托管区等） | CI |

**示例：agent 跑 cage verify 时看到的输出**

```text
$ cage verify
✓ typecheck                  0 个错误
✓ 依赖规则                    0 条违反
✓ 声明静态性                  0 处
✓ 生成物一致性                无 diff
✗ 图规则                      1 个问题
  [CAGE-PAIR-002] packages/domain/src/purchase-order.ts:58
  原因：revoke 让单据离开 PurchaseOrder.approved，但没有释放 inventory.lock
  修复：新增订阅 OrderRevoked 的反应并标注 releases: 'inventory.lock'
  详见：docs/errors/CAGE-PAIR-002.md
— 已停止，后续门禁未运行
```

### 10.2 抽取器：把声明变成本体图

**做法**：用 tsx 直接导入 domain 包入口，遍历所有导出值，靠品牌标记识别原语，把它们转成节点和边。因为声明都在模块顶层，导入就是全部，不需要运行任何业务逻辑。

```ts
// packages/cli/src/extract.ts
import { pathToFileURL } from 'node:url';                         // 把文件路径转成可导入的 URL
import { AGGREGATE, COMMAND, REACTION, QUERY } from '@cage/kernel/brands'; // 各原语的品牌标记

export async function extract(domainEntry: string): Promise<Ontology> {
  const mod = await import(pathToFileURL(domainEntry).href);      // 导入 domain 包入口（用 tsx 运行，支持 TS）
  const g: Ontology = { nodes: [], edges: [] };                   // 空图
  for (const [exportName, v] of Object.entries<any>(mod)) {       // 遍历所有导出
    if (v?.[AGGREGATE]) {                                         // 是聚合
      g.nodes.push({ kind: 'aggregate', id: v.name });            //   加聚合节点
      for (const f of Object.keys(v.fields))                      //   每个字段也是节点，影响分析能精确到字段
        g.nodes.push({ kind: 'field', id: `${v.name}.${f}` });
      for (const s of v.states)                                   //   每个状态一个节点
        g.nodes.push({ kind: 'state', id: `${v.name}.${s}` });
    } else if (v?.[COMMAND]) {                                    // 是命令
      const id = `${v.agg.name}.${exportName}`;                   //   命令名 = 聚合名.导出名
      g.nodes.push({ kind: 'command', id });                      //   加命令节点，也就是能力点
      for (const f of [v.from].flat())                            //   每个起始状态画一条迁移边
        g.edges.push({ kind: 'transition', from: `${v.agg.name}.${f}`, to: `${v.agg.name}.${v.to}`, via: id });
      for (const [alias, agg] of Object.entries<any>(v.reads))    //   每个读依赖画一条读边
        g.edges.push({ kind: 'reads', from: id, to: agg.name, alias });
      for (const ev of v.emits)                                   //   每个事件画一条发事件边
        g.edges.push({ kind: 'emits', from: id, to: ev.name });
      for (const c of v.constraints)                              //   约束引用了哪些字段
        for (const f of c.fields ?? [])
          g.edges.push({ kind: 'uses', from: id, to: `${v.agg.name}.${f}` });
    } else if (v?.[REACTION]) {                                   // 是反应
      g.edges.push({ kind: 'triggers', from: v.event.name, to: exportName }); //   事件 -> 反应
      g.edges.push({ kind: 'targets', from: exportName, to: commandId(v.command), //   反应 -> 命令
        acquires: v.acquires, releases: v.releases });            //   带上资源标注，供配对检查
    } else if (v?.[QUERY]) {                                      // 是查询
      for (const agg of v.reads)                                  //   查询读了哪些聚合
        g.edges.push({ kind: 'queries', from: exportName, to: agg.name });
    }
  }
  return g;                                                       // 写到 .cage/ontology.json，不入库
}
```

**生成的本体图（节选）**

```jsonc
{
  "nodes": [                                                      // 节点
    { "kind": "aggregate", "id": "PurchaseOrder" },               // 聚合
    { "kind": "field", "id": "PurchaseOrder.amount" },            // 字段
    { "kind": "state", "id": "PurchaseOrder.approved" },          // 状态
    { "kind": "command", "id": "PurchaseOrder.approve" }          // 命令（也是能力点）
  ],
  "edges": [                                                      // 边
    { "kind": "transition", "from": "PurchaseOrder.pending_approval", "to": "PurchaseOrder.approved", "via": "PurchaseOrder.approve" }, // 状态迁移
    { "kind": "reads", "from": "PurchaseOrder.approve", "to": "Inventory", "alias": "stock" }, // 读依赖
    { "kind": "uses", "from": "PurchaseOrder.approve", "to": "PurchaseOrder.amount" },   // 额度约束用到了 amount
    { "kind": "emits", "from": "PurchaseOrder.approve", "to": "OrderApproved" }         // 发出事件
  ]
}
```

**静态检查**：导入之前先用 TypeScript 编译器 API 扫一遍源码，确保没有声明藏在函数、条件或循环里（那样抽取器就看不到它）。

```ts
// packages/cli/src/static-check.ts（节选）
for (const call of findPrimitiveCalls(sourceFile)) {              // 找出所有原语调用：aggregate、command、reaction……
  if (!isTopLevelExport(call)) {                                  // 不在模块顶层的 export const 里
    report('CAGE-DECL-001', call,                                 // 报错，带错误码和位置
      '原语必须在模块顶层用 export const 声明');                 // 告诉 agent 怎么改
  }
}
```

### 10.3 影响分析

**做法**：在 PR 的基线提交和当前提交上各生成一张图，找出变化的节点，再沿着边向外扩散。handler 文件的改动会被映射到它所属的命令节点，所以只改实现、不改声明也能算出影响。

```ts
// packages/cli/src/impact.ts
export function impact(base: Ontology, head: Ontology, changedFiles: string[]) {
  const start = new Set<string>([                                 // 变化的起点
    ...diffNodes(base, head),                                     // 声明里新增、删除、修改的节点
    ...changedFiles.map(ownerNodeOf).filter(Boolean),             // handler 文件改动映射到它所属的命令
  ] as string[]);
  const affected = new Set(start);                                // 受影响集合，初始就是起点
  const queue = [...start];                                       // 广度优先遍历的队列
  while (queue.length > 0) {                                      // 队列空了就结束
    const n = queue.shift()!;                                     // 取出一个节点
    for (const e of head.edges) {                                 // 看它连着哪些边
      const next =
        e.kind === 'reads'    && e.to === n   ? e.from :          // 谁读了我：读我的命令受影响
        e.kind === 'queries'  && e.to === n   ? e.from :          // 哪些查询读了我
        e.kind === 'uses'     && e.to === n   ? e.from :          // 谁用了我这个字段：约束、事件载荷、路由条件、出站映射
        e.kind === 'emits'    && e.from === n ? e.to :            // 我发出的事件
        e.kind === 'triggers' && e.from === n ? e.to :            // 事件触发的反应
        e.kind === 'targets'  && e.from === n ? e.to :            // 反应调用的命令
        null;                                                     // 其他边不传播
      if (next && !affected.has(next)) {                          // 新发现的受影响节点
        affected.add(next);                                       // 记下来
        queue.push(next);                                         // 继续往外扩散
      }
    }
  }
  return { affected: [...affected], tests: testsFor(affected) };  // 输出受影响节点和必须运行的测试
}
```

**示例：CI 贴在 PR 上的影响摘要**（把采购单金额从含税改为不含税）

```text
cage impact（相对 main）
变化：  PurchaseOrder.amount 的口径说明被修改
受影响：
  - 约束   PurchaseOrder.approve 上的 ceiling(amount)
  - 路由   po-approval 中的 gt(amount, 50000)
  - 事件   OrderSubmitted、OrderApproved（载荷含 amount）
  - 外部   pushToErp（出站映射使用 amount）
  - 查询   poAmountSummary
必须运行的测试：派生测试 18 个，项目测试 5 个
需要人工确认：角色上的审批额度参数是否按新口径调整
```

### 10.4 图规则检查（以资源配对为例）

**做法**：每条图规则是一个函数，输入本体图，输出问题列表。下面是设计文档里「撤回审批漏解锁」那个例子背后的实现。

```ts
// packages/cli/src/rules/resource-pairing.ts
export function checkPairing(g: Ontology): Finding[] {
  const findings: Finding[] = [];                                 // 发现的问题
  for (const held of statesHoldingResources(g)) {                 // 找出「进入时获得了资源」的状态，例如 approved 持有 inventory.lock
    for (const t of outgoingTransitions(g, held.state)) {         // 这个状态的每一条出边
      const released = releasesOnPath(g, t, held.resource);       // 这条出边发出的事件链上有没有反应释放了资源
      const stillHeld = holds(g, t.to, held.resource);            // 或者目标状态也声明持有这个资源
      if (!released && !stillHeld) {                              // 两者都没有：资源泄漏
        findings.push({                                           // 记录一个问题
          code: 'CAGE-PAIR-002',                                  //   错误码
          at: locationOf(t.via),                                  //   指向那个命令的声明位置
          reason: `${t.via} 让单据离开 ${held.state}，但没有释放 ${held.resource}`, //   原因
          fix: `新增订阅该命令事件的反应，并标注 releases: '${held.resource}'`, //   修复方法
        });
      }
    }
  }
  return findings;                                                // 交给 cage check 输出
}
```

其他图规则：状态可达性（每个状态都能从初始状态到达）、非终态必须有出边、敏感字段不得原样进入事件载荷、事件载荷只允许向后兼容的变更、每个 invokedBy 为 process 的命令必须有审批绑定。写法都和上面一样：遍历图、输出带错误码和修复方法的问题。

### 10.5 派生测试

**做法**：测试生成器遍历本体图，按固定模板为每个能力点、每个范围组合子、每条非法迁移生成测试。生成到 generated/tests，不入库，每次运行前重新生成；用 Vitest 加 Testcontainers 起一个真实的 Postgres 跑。

| 类别 | 生成规则 |
| --- | --- |
| 能力 | 每个能力点：缺少它的用户调用，断言 FORBIDDEN |
| 范围 | 每个聚合、每个范围组合子：范围外数据的读、写、导出、安全视图都拿不到 |
| 状态 | 每个命令、每个不在 from 中的状态：断言 INVALID\_TRANSITION |
| 约束 | 每个硬约束：构造反例，断言 CONSTRAINT\_VIOLATED |
| 不变量 | fast-check 随机生成命令序列，断言每步之后不变量成立 |
| 脱敏、审计、幂等 | 按设计文档第 12 节的规则生成 |

**生成器代码（以能力测试为例）**

```ts
// packages/cli/src/derive/capability.ts
export function deriveCapabilityTests(g: Ontology): string {      // 返回一个测试文件的内容
  const out = [                                                   // 文件头
    `import { it, expect } from 'vitest';`,                       //   测试框架
    `import { callAs, seed, actorWithout } from '@cage/testkit';`, //   测试工具
  ];
  for (const cmd of g.nodes.filter((n) => n.kind === 'command')) { // 遍历所有命令（也就是所有能力点）
    out.push(`it('${cmd.id}：没有能力点时被拒绝', async () => {`); // 每个能力点一个用例
    out.push(`  const doc = await seed.inState('${cmd.id}');`);     // 造一条处在合法起始状态的数据
    out.push(`  const actor = actorWithout('${cmd.id}');`);         // 造一个只缺这个能力点的用户
    out.push(`  const res = await callAs(actor, '${cmd.id}', { id: doc.id });`); // 以他的身份调用
    out.push(`  expect(res.code).toBe('FORBIDDEN');`);              // 必须被拒绝
    out.push(`});`);                                              // 用例结束
  }
  return out.join('\n');                                          // 拼成一个文件
}
```

**生成出来的测试（节选）**

```ts
// generated/tests/capability.test.ts（生成物）
it('PurchaseOrder.submit：没有能力点时被拒绝', async () => {     // 每个能力点一条
  const doc = await seed.inState('PurchaseOrder.submit');         // 一张草稿状态的采购单
  const actor = actorWithout('PurchaseOrder.submit');             // 有其他所有能力、唯独缺 submit 的用户
  const res = await callAs(actor, 'PurchaseOrder.submit', { id: doc.id }); // 调用提交
  expect(res.code).toBe('FORBIDDEN');                             // 断言被拒绝
});
```

为什么这些测试有用：如果有人把内核的能力判定改坏了，或者某个路由绕过了内核，这一批测试会同时失败。它们不是测 handler，而是持续证明「笼子没有洞」。

### 10.6 静态规则（@cage/lint）

**依赖规则**：由 dependency-cruiser 执行，管「谁不能导入谁」。

```js
// node_modules/@cage/lint/dependency-cruiser.cjs（节选）
module.exports = {
  forbidden: [                                                    // 禁止的依赖关系
    {
      name: 'domain-no-io',                                       // 声明和 handler 不能做 IO
      severity: 'error',                                          // 违反即构建失败
      from: { path: '^packages/domain' },                         // 来源：业务声明
      to: { path: '^(node:)?(fs|net|http|https|child_process)$|pg|kysely|axios|undici' }, // 目标：文件、网络、数据库库
      comment: '[CAGE-DEP-001] 声明和 handler 不能直接做 IO',   // 报错信息
    },
    {
      name: 'adapters-write-via-commands',                        // 适配器只能通过命令写数据
      severity: 'error',                                          // 违反即构建失败
      from: { path: '^packages/adapters' },                       // 来源：审批、ERP 等适配器
      to: { path: 'pg|kysely' },                                  // 目标：数据库客户端
      comment: '[CAGE-DEP-002] 适配器必须通过命令网关写数据',     // 报错信息
    },
  ],
};
```

**代码规则**：由 ESLint 插件执行，管「代码里不能出现什么」。下面是「unsafe 必须写明原因和负责人」这条规则的完整实现：

```ts
// packages/lint/src/rules/unsafe-needs-reason.ts
export default {
  meta: {                                                         // 规则元信息
    type: 'problem',                                              // 属于问题，不是风格
    messages: { missing: '[CAGE-UNSAFE-001] unsafe 必须写明 reason 和 owner' }, // 报错文案
  },
  create(context) {                                               // ESLint 规则入口
    return {
      CallExpression(node) {                                      // 检查每一个函数调用
        if (node.callee.name !== 'unsafe') return;                // 只关心 unsafe(...)
        const arg = node.arguments[0];                            // 第一个参数应该是 { reason, owner }
        const keys = arg?.type === 'ObjectExpression'             // 是对象字面量时
          ? arg.properties.map((p) => p.key?.name)                //   取出它的键名
          : [];                                                   //   不是对象就当作没写
        if (!keys.includes('reason') || !keys.includes('owner')) { // 缺 reason 或 owner
          context.report({ node, messageId: 'missing' });         // 报错，构建失败
        }
      },
    };
  },
};
```

其他代码规则同理：禁止字符串拼接 SQL、禁止密钥字面量、禁止在业务项目里调用 app.get / app.post 手写路由。

## 11. CI/CD

PR 阶段：门禁全部跑完、影响摘要贴好，人才开始审。发布阶段：合并后构建一个镜像，先在预发布环境迁移、部署、冒烟，再到生产。

> **大白话**：机器先把能查的全查完，人只看机器查不了的；上线前先在「彩排环境」演一遍。

&#91;embedded content: CI/CD 流水线 · PR 阶段与发布阶段\]

### 11.1 PR 流水线

**做法**：框架仓库提供一个可复用流水线，业务项目只引用它。框架升级时流水线自动跟上，项目里不存在一份会过时的副本。下面以 GitHub Actions 为例，GitLab CI 用 include 写法相同。

```yaml
# .github/workflows/cage.yml（业务项目里的托管配置，只有这几行）
name: cage                                                # 流水线名
on: [pull_request]                                        # 每个 PR 触发
jobs:
  verify:                                                 # 只有一个任务
    uses: our-org/cage/.github/workflows/verify.yml@v1    # 引用框架提供的可复用流水线
    secrets: inherit                                      # 继承仓库密钥（只用于拉私有包，不含生产密钥）
```

```yaml
# cage/.github/workflows/verify.yml（框架仓库提供）
on: workflow_call                                         # 只能被其他流水线调用
jobs:
  verify:
    runs-on: ubuntu-latest                                # 运行环境
    steps:
      - uses: actions/checkout@v4                         # 拉代码
        with: { fetch-depth: 0 }                          # 拉全部历史，影响分析需要基线提交
      - uses: pnpm/action-setup@v4                        # 安装 pnpm
      - run: pnpm install --frozen-lockfile               # 按锁文件安装依赖
      - run: pnpm cage verify                             # 跑全部门禁，派生测试用 Testcontainers 起数据库
      - run: pnpm cage impact --base origin/${{ github.base_ref }} --format md > impact.md # 生成影响摘要
      - uses: marocchino/sticky-pull-request-comment@v2   # 把摘要贴到 PR，后续提交会更新同一条评论
        with: { path: impact.md }                         # 要贴的文件
```

### 11.2 PR 摘要示例

人类 reviewer 先读这一条评论，再决定重点看哪里。

```text
cage 摘要 · PR #128 采购单增加撤回审批
门禁：12 / 12 通过
声明变化：
  + 命令   PurchaseOrder.revoke（approved → pending_approval）
  + 反应   releaseOnRevoke（releases: inventory.lock）
  + 能力点 PurchaseOrder.revoke（默认无人拥有，需管理员授权）
影响：InventoryLock、审批路由 po-approval、外部同步 pushToErp
派生测试：新增 6 个，全部通过
unsafe：0（与 main 持平）
请重点审：撤回时已经推送到 ERP 的采购单如何处理
```

### 11.3 发布流水线

1. 合并到 main 后构建镜像，打上提交号标签；同一个镜像先用于预发布，再用于生产。
2. 预发布：用 cage\_migrate 执行迁移，部署 api 与 worker，跑冒烟测试（登录、一个命令、一个查询、一次 outbox 投递）。
3. 生产：人工确认后执行迁移，再滚动部署 api 与 worker。滚动期间新旧版本会短暂同时运行，所以迁移必须向后兼容（先扩展再收缩）。
4. 回滚：只回滚应用镜像，不回滚迁移。因为迁移都是先扩展，旧版本应用在新结构上仍然能跑。

**镜像**（Dockerfile 不支持行尾注释，注释写在每行上方）

```dockerfile
# Dockerfile（模板生成）
# 构建阶段：安装依赖并编译
FROM node:24-slim AS build
# 工作目录
WORKDIR /app
# 拷贝源码
COPY . .
# 启用 pnpm，按锁文件安装，编译
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
# 运行阶段：只保留运行需要的文件
FROM node:24-slim
# 工作目录
WORKDIR /app
# 拷贝编译产物
COPY --from=build /app/apps/api/dist ./dist
# 拷贝运行时依赖
COPY --from=build /app/node_modules ./node_modules
# 不用 root 运行
USER node
# 默认启动 api；worker 部署时把命令覆盖成 node dist/worker.js
CMD ["node", "dist/main.js"]
```

## 12. AI 协作配置

agent 只能从仓库里学会这套框架，所以仓库里必须有三样东西：AGENTS.md、标准范例、错误码册。

> **大白话**：这是给 AI 的入职手册。写清楚哪里能动、哪里不能动、遇到报错怎么查，AI 就不会乱来。

**12.1 AGENTS.md 结构**

```markdown
<!-- cage:begin 托管区，由 cage sync 更新，请勿手改 -->
## 工作顺序
1. 先改 packages/domain 里的声明，再写 handler 和页面
2. 运行 cage impact，把输出当作任务清单
3. 运行 cage verify，按报错修复直到全部通过
## 目录边界
可改：packages/domain、packages/queries、apps/web
禁止改：generated/、db/migrations 中已发布的文件
## 禁止事项
handler 里做网络或文件操作；绕过安全视图写 SQL；手写 HTTP 路由；字面量密钥
## 原语速查
（每个原语一个最小例子，链接到 examples/）
<!-- cage:end -->

## 本项目约定
（项目自己写：业务术语表、模块负责人、特殊规则）
```

**12.2 标准范例（examples/，随框架发布并同步到项目）**

1. 最简聚合：只有新增、修改、删除和数据范围。
2. 带状态机和审批绑定的单据。
3. 跨聚合反应：同事务与 outbox 各一例，含资源配对。
4. 第三方连接器：出站映射、入站回调、fake 与录制样例。
5. 报表：ORM 查询与手写 SQL 查询各一例。

**12.3 错误码册**

- 每条门禁报错都有错误码（如 CAGE-READS-001），格式固定：位置、原因、修复方法。
- 错误码册放在 docs/errors/ 下，每码一个文件，含正例和反例；报错末尾附上文件路径，agent 可以直接打开。

**12.4 agent 权限建议**

- 允许：读写项目目录、运行 cage 命令和 pnpm 脚本、使用本地 Docker。
- 不允许：访问生产数据库和生产密钥、直接推送主干、修改 CI 和 AGENTS.md 的托管区。
- 每个 PR 由 agent 发起，由人合并。

**12.5 错误码文件长什么样**

每个错误码一个 Markdown 文件，结构固定：什么时候出现、怎么修、正例、反例。agent 看到报错末尾的路径就会打开它。

```markdown
# CAGE-READS-001：handler 使用了未声明的读依赖

## 什么时候出现
handler 里访问了 deps.xxx，但命令的 reads 里没有 xxx。

## 怎么修（二选一）
1. 确实需要读这个聚合：在 reads 里加上 { xxx: 聚合名 }。
2. 只是想在本命令完成后影响另一个聚合：不要读它，改为发事件，由反应处理。

## 正例
reads: { stock: Inventory }
handler 里：await deps.stock.get(sku)

## 反例
reads: {}
handler 里：await deps.stock.get(sku)   ← 编译失败
```

**12.6 一次完整的 agent 工作过程（示例）**

需求（业务原话）：采购单增加「撤回审批」，撤回后要释放库存锁。

| 步 | agent 做了什么 | 工具返回了什么 |
| --- | --- | --- |
| 1 | 按 AGENTS.md 先改声明：在 purchase-order.ts 新增 revoke 命令（approved 到 pending\_approval），发出 OrderRevoked | — |
| 2 | 运行 cage impact | 受影响：InventoryLock、审批路由 po-approval、外部同步 pushToErp |
| 3 | 运行 cage verify | CAGE-PAIR-002：revoke 让单据离开 approved，但没有释放 inventory.lock |
| 4 | 按报错新增反应 releaseOnRevoke，标注 releases: 'inventory.lock'，调用库存锁的 release 命令 | — |
| 5 | 再次运行 cage verify | 全部通过；新增派生测试 6 个 |
| 6 | 给 handler 写一条单测：已推送 ERP 的单不允许撤回，返回业务错误 ALREADY\_SYNCED | 单测通过 |
| 7 | 提交 PR | CI 贴出摘要（第 11.2 节那一条） |

整个过程里人只做了两件事：开头提需求；最后审声明 diff，并确认「已推送 ERP 的单不允许撤回」这条业务规则对不对。第 3 步拦下的正是最初那类「改了审批、坏了库存」的问题。

## 13. 使用流程

项目建好之后，绝大部分时间都在「提需求、AI 改声明、影响清单、AI 写实现、门禁、人审、上线」这个循环里，人只在开头说需求和中间审 PR 两处介入。

> **大白话**：人负责说清楚要什么、把关方向；AI 负责干活；工具负责挑错。

**13.1 建项目（第一天）**

1. pnpm create cage-app 采购后台，选择 React 或 Vue，填写数据库连接。
2. cage dev 一键起本地环境：Postgres、api、worker、web 和 /admin 系统管理，自带登录、用户、部门、角色。
3. 配置公司 SSO 与组织同步。
4. CI 已在模板里，引用框架提供的流水线，项目里不需要再写。

**建项目时终端里实际会看到的**

```bash
$ pnpm create cage-app purchase-admin        # 从模板创建项目
? 前端框架 › React                           # 选择 React 或 Vue（待决策 D7）
? 是否启用多租户 › 否                         # 对应待决策 D5
? 审批方式 › 代码内封闭路由                   # 对应待决策 D4
✔ 已生成 purchase-admin                       # 只生成薄壳，框架代码在 node_modules 里
$ cd purchase-admin && pnpm install          # 安装依赖
$ pnpm cage dev                              # 起本地环境
  postgres  localhost:5432                   # Docker 中的数据库，已执行初始化脚本和迁移
  api       http://localhost:3000            # 后端
  worker    已启动                             # 异步处理
  web       http://localhost:5173            # 业务前端
  admin     http://localhost:3000/admin      # 系统管理，初始管理员账号在终端里打印一次
```

**第一个模块怎么开始**：把业务的原话直接交给 agent，并指定先只写声明。例如：

```text
请按 AGENTS.md 的顺序，先只写 packages/domain/src/purchase-order.ts 的声明，不写 handler：
- 采购单有草稿、待审批、已审批、已驳回、已取消五个状态
- 采购员只能看自己的单，部门经理看本部门及下级
- 部门经理审批，超过 5 万还要财务审批；提单人不能审批自己的单
- 审批通过后锁定库存，取消时释放
写完运行 cage check 和 cage gen，把生成的状态图路径告诉我。
```

人审完声明和状态图，再让 agent 继续写 handler、查询和页面。

**13.2 做第一个模块（例：采购单）**

1. 业务用大白话描述需求。
2. agent 只写声明：状态、命令、范围、约束、事件、反应、审批绑定。
3. 人做第一次把关：工程师审声明，业务看自动生成的状态图确认流程。
4. agent 写 handler、查询和页面，cage verify 全绿后提 PR。
5. CI 贴摘要，人审后合并上线。
6. 管理员做第二次把关：在 /admin 给角色勾选新能力点、设置数据范围，配置审批路由。

**13.3 日常迭代**：同 13.2 的第 1 到 5 步。cage verify 不通过时 agent 照报错自行修复；只有声明方向错了才需要人打回。

**13.4 谁做什么**

| 角色 | 做什么 | 不能做什么 |
| --- | --- | --- |
| 业务 / 产品 | 说需求、看状态图确认、配审批路由 | 不写代码 |
| AI agent | 写声明、handler、查询、页面、迁移草稿 | 不能改内核，不能手改生成物 |
| 工程师 | 审声明 diff、影响清单和迁移；批准 unsafe | 不用逐行审样板代码 |
| 管理员 | 用户、角色授权、数据范围 | 造不出代码里不存在的权限 |
| 框架维护者 | 维护内核、发版本、写 codemod | 不写业务 |

## 14. 升级与版本管理

业务项目依赖框架，而不是复制框架：框架以带版本号的 npm 包发布，项目里只写版本号，所以已经生成的项目可以一直跟着升级。

> **大白话**：模板只给你搭了个门框，承重墙、门锁、水电都是从框架这个建材商那里按型号买的。建材升级了，换型号就行，不用拆房子。若依那种「fork 一份再改」的模式，生成之后就和上游断了，正是我们要避免的。

**14.1 业务项目里的四类文件**

| 类别 | 例子 | 放在哪 | 怎么升级 |
| --- | --- | --- | --- |
| 框架包 | @cage/kernel、cli、http、client、admin、connectors | node\_modules，不在仓库 | 改版本号 |
| 生成物 | contracts、路由清单、安全视图 DDL、派生测试 | generated/，CI 检查无 diff | 升级后 cage gen 重新生成 |
| 托管配置 | tsconfig、ESLint、CI 流水线、AGENTS.md 通用部分 | 仓库内，但只有一行 extends 或一块托管区 | cage sync 覆盖托管区 |
| 项目自有 | 声明、handler、查询、页面、已发布的迁移 | 仓库内 | 框架不改；破坏性变更由 codemod 改写 |

模板的原则：只生成以后永远不需要框架维护者来改的东西，凡是将来可能要改的都放进包里。apps/api 里只有一段启动代码：

```ts
// apps/api/src/main.ts（模板生成，之后基本不动）
import { createServer } from '@cage/http';
import * as domain from '@app/domain';

createServer({ domain, auth: { oidcIssuer: process.env.OIDC_ISSUER } }).listen();
```

**14.2 升级流程**

1. Renovate 或 cage upgrade 提一个 PR，把 @cage/\* 升到新版本。
2. cage upgrade 运行该版本附带的 codemod（例如原语参数改名时自动改写 domain 里的写法），并同步托管区。
3. cage gen 重新生成所有生成物。
4. cage verify 跑全部门禁；剩下的编译错误交给 agent 按报错和发布说明修复。
5. 人审后合并。

**14.3 版本规则**

- 语义化版本：改变写入流水线语义、删除或改名原语是大版本，必须附带 codemod；新增原语或组合子是小版本；修复是补丁版本。
- 所有 @cage 包统一版本号，一起发布。
- 业务项目最多落后一个大版本；安全修复会回移到上一个大版本。

**14.4 仓库组织**

- PoC 阶段：框架与第一个业务项目放在同一个 monorepo，框架改动能立即在真实项目上验证。
- 稳定后：框架拆为独立仓库，发布到私有 npm 仓库；每个业务后台各自一个仓库，由 Renovate 自动提升级 PR。

**14.5 codemod 示例**

假设 2.0.0 把 command 里的 invokedBy 改名为 caller。框架发版时附带下面这个 codemod，cage upgrade 会自动运行它，业务项目里的声明被自动改写。

```ts
// packages/cli/src/codemods/2.0.0-rename-invokedBy.ts（随 2.0.0 发布）
import { Project, SyntaxKind } from 'ts-morph';                   // 用 ts-morph 按语法树改写代码，而不是文本替换

export default function migrate(project: Project) {              // cage upgrade 会把项目传进来
  for (const file of project.getSourceFiles('packages/domain/**/*.ts')) { // 只改业务声明
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) { // 遍历所有函数调用
      if (call.getExpression().getText() !== 'command') continue; // 只处理 command(...) 调用
      const obj = call.getArguments()[1]                         // 第二个参数是声明对象
        ?.asKind(SyntaxKind.ObjectLiteralExpression);             // 确认它是对象字面量
      const prop = obj?.getProperty('invokedBy')                  // 找旧属性名
        ?.asKind(SyntaxKind.PropertyAssignment);                  // 确认是普通的属性赋值
      prop?.setName('caller');                                    // 改成新名字，值保持不变
    }
    file.saveSync();                                              // 写回文件
  }
}
```

**14.6 托管区同步（cage sync）**

AGENTS.md 这类必须放在仓库里、内容又属于框架的文件，用标记圈出托管区：标记之间由框架覆盖，标记之外是项目自己的，永远不动。

```ts
// packages/cli/src/sync.ts（节选）
const BEGIN = '<!-- cage:begin';                                  // 托管区开始标记
const END = '<!-- cage:end -->';                                  // 托管区结束标记

export function syncManagedBlock(current: string, latest: string) { // current：项目里的文件；latest：框架当前版本的托管内容
  const start = current.indexOf(BEGIN);                           // 找到托管区开头
  const end = current.indexOf(END);                               // 找到托管区结尾
  if (start < 0 || end < 0) {                                     // 文件里还没有托管区
    return latest + '\n\n' + current;                             // 在文件开头插入一份
  }
  return current.slice(0, start)                                  // 托管区之前的内容原样保留
    + latest                                                      // 托管区换成框架当前版本的内容
    + current.slice(end + END.length);                            // 托管区之后（本项目约定）原样保留
}
```

**14.7 自动提升级 PR（Renovate）**

```jsonc
// renovate.json（托管配置）
{
  "extends": ["config:recommended"],                              // Renovate 推荐配置
  "packageRules": [
    {
      "matchPackageNames": ["@cage/**"],                          // 所有 @cage 包
      "groupName": "cage",                                        // 合并成一个 PR，保证版本号一致
      "postUpgradeTasks": {                                       // 升级后自动执行的命令
        "commands": ["pnpm cage upgrade --codemods-only"],        // 跑 codemod 并同步托管区
        "fileFilters": ["packages/domain/**", "AGENTS.md"]        // 允许提交这些文件的改动
      }
    }
  ]
}
```

postUpgradeTasks 需要自托管的 Renovate 并在其配置里允许该命令；如果暂时没有，就由 agent 在 Renovate 的 PR 上手动运行 cage upgrade。

## 15. 可观测与安全基线

可观测围绕「一次命令」展开：从 HTTP 请求到内核、到 outbox、到第三方调用，都用同一个 requestId 串起来。安全基线由框架默认开启，项目不需要配置。

> **大白话**：出了问题时，拿着一个编号就能顺藤摸瓜，看到这次操作经过了哪些地方、在哪一步失败。

**15.1 可观测**

| 信号 | 做法 |
| --- | --- |
| 链路追踪 | OpenTelemetry：HTTP、内核每一步、数据库、outbox 投递、连接器调用各一个 span；事件携带追踪上下文，异步处理也能接上 |
| 日志 | pino 结构化日志，带 requestId、actor、command；敏感字段按种类自动脱敏 |
| 指标 | 命令耗时与失败率（按错误码）、outbox 积压与延迟、死信数量、连接器成功率与限流次数、安全视图查询耗时 |
| 审计 | 业务审计存在数据库（第 6 节），与日志分开存放，保留期独立 |

**15.2 安全基线（默认开启）**

- HTTP：安全响应头（@fastify/helmet）、基于 cookie 会话时的 CSRF 防护、登录与敏感接口限流（@fastify/rate-limit）、请求体大小限制。
- 输入：所有命令和查询输入经 Zod 校验；SQL 只通过 Kysely 参数化，手写 SQL 也必须使用参数占位，lint 禁止字符串拼接 SQL。
- 数据：数据库账号最小权限（第 6 节）；敏感字段掩码；审计只追加。
- 密钥：只从密钥管理服务读取；仓库中出现密钥字面量即构建失败。
- 出站：生产环境出站流量只经过出口代理白名单。
- 依赖：CI 中做依赖漏洞扫描，高危漏洞阻断合并。
- 备份：数据库每日全量加持续归档（WAL），定期演练恢复。

**15.3 安全基线怎么默认开启**

这些配置写在 @cage/http 里，业务项目调用 createServer 时自动生效，不需要 AI 记得加。

```ts
// packages/http/src/server.ts（节选）
export async function createServer(opts: ServerOptions) {
  const app = Fastify({
    bodyLimit: 1_048_576,                                         // 请求体最大 1 MB，防止超大请求拖垮服务
    logger: buildLogger(opts.domain),                             // 结构化日志，敏感字段自动打码（见 15.5）
    trustProxy: true,                                             // 在负载均衡后面取真实客户端 IP
  });
  await app.register(helmet);                                     // 安全响应头：CSP、HSTS、X-Frame-Options 等
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' }); // 默认每个客户端每分钟 300 次
  await app.register(csrf, { cookieOpts: { sameSite: 'lax' } });  // 基于 cookie 会话，打开 CSRF 防护
  await app.register(async (auth) => {                            // 登录相关接口单独一组，限制更严
    await auth.register(rateLimit, { max: 10, timeWindow: '1 minute' }); // 每分钟最多 10 次，防暴力破解
    auth.register(oidcRoutes);                                    // SSO 登录与回调路由
  });
  await app.register(authPlugin);                                 // 认证：会话变上下文（第 8 节）
  await app.register(cagePlugin, { domain: opts.domain });        // 生成的业务路由（第 7 节）
  return app;                                                     // 返回给 main.ts 启动
}
```

**15.4 链路追踪：流水线每一关一个 span**

```ts
// packages/kernel/src/telemetry.ts
import { trace, context, propagation } from '@opentelemetry/api'; // OpenTelemetry 标准 API
const tracer = trace.getTracer('cage');                           // 框架统一的 tracer

export function step<T>(name: string, fn: () => Promise<T>) {     // 把流水线的每一关包起来
  return tracer.startActiveSpan(`cage.${name}`, async (span) => { // 开一个 span，例如 cage.loadScoped
    try {
      return await fn();                                          // 执行这一关
    } catch (e) {
      span.recordException(e as Error);                           // 失败时记录异常，链路里能看到在哪一关失败
      throw e;                                                    // 继续往外抛
    } finally {
      span.end();                                                 // 结束 span
    }
  });
}

export function traceCarrier() {                                  // 写 outbox 时调用
  const carrier: Record<string, string> = {};                     // 空的携带对象
  propagation.inject(context.active(), carrier);                  // 把当前链路上下文写进去
  return carrier;                                                 // 存入 sys.outbox.trace，worker 处理时取出来接上链路
}
```

**15.5 日志自动打码**：需要打码的字段不是手写的列表，而是从声明里的 sensitive 字段自动算出来的，新增敏感字段时不会漏。

```ts
// packages/http/src/logger.ts
export function buildLogger(domain: object) {
  const sensitive = sensitiveFieldPaths(domain);                  // 从声明里收集所有 sensitive 字段，例如 *.supplierPhone
  return {
    level: process.env.LOG_LEVEL ?? 'info',                       // 日志级别
    redact: {                                                     // pino 的打码配置
      paths: ['req.headers.cookie', 'req.headers.authorization', ...sensitive], // 会话、令牌和业务敏感字段
      censor: '***',                                              // 替换成 ***
    },
  };
}
```

## 16. 实施计划

先做阶段 0：用最小的框架加一个真实模块（采购单 + 库存）验证笼子能不能拦住目标缺陷；过了门槛再按设计文档第 16 节的路线扩展。不预设日期，以验收标准推进。

> **大白话**：先造一个能跑的最小版本，用真实需求去撞它，撞得住再加功能。

**16.1 阶段 0 任务拆解**

| # | 任务 | 产出 | 验收标准 |
| --- | --- | --- | --- |
| 1 | 仓库骨架 | pnpm + Turborepo monorepo、packages 与 apps 目录、基础 CI | 一条命令完成安装、构建、测试 |
| 2 | 声明原语最小集 | aggregate、states、command、scope（self、dept、deptSubtree）、sod、invariant、event、reaction | 设计文档附录的采购单声明能通过类型检查 |
| 3 | 写入流水线 | 12 步流水线、乐观锁、审计、outbox、同事务反应 | 每一步都有单测；故意漏写的约束在测试中被拦下 |
| 4 | 数据库生成 | 表结构、安全视图、行级策略、in\_scope 与 mask 函数、迁移草稿 | 用读账号直接写 SQL 查范围外数据，返回空 |
| 5 | HTTP 与 SDK | Fastify 插件生成路由；contracts 生成类型、SDK、can() | 前端调用命令和查询全程有类型提示 |
| 6 | 抽取器与 cage check | ontology.json；可达性与资源配对规则 | 「撤回审批漏解锁」的例子被 CAGE-PAIR 报错拦下 |
| 7 | cage impact | 图 diff、影响清单、PR 摘要 | 修改 amount 口径时列出约束、路由条件、事件、查询 |
| 8 | 派生测试 | 能力、范围、状态、审计四类 | 删掉任意一个权限判断，测试失败 |
| 9 | 依赖规则与 cage verify | dependency-cruiser 规则、ESLint 插件、verify 汇总 | handler 导入数据库客户端时构建失败 |
| 10 | 模板与 AGENTS.md | create-cage-app、AGENTS.md 托管区、两个标准范例 | 新人用 agent 从零生成采购单模块并通过 verify |
| 11 | 对照实验 | 同一组 5 轮需求变更，由 agent 分别在有笼子与无笼子的代码库上完成 | 产出漏出缺陷数、review 时长、影响清单召回率、一次通过率的对比报告 |

**16.2 后续阶段**（对应设计文档第 16 节）

- 阶段 1：组织模型与 @cage/admin、完整范围组合子、字段脱敏、导出。
- 阶段 2：worker 进程、outbox 投递与死信、定时任务、审批适配。
- 阶段 3：连接器运行时与出口代理、入站回调、导入，第一个真实业务模块上线。

**16.3 分工建议**

- 框架小组负责内核、CLI 与门禁，人少而稳定，所有内核改动由架构负责人批准。
- 业务小组从阶段 0 第 10 项开始，以使用者身份试用模板，持续反馈报错信息是否好懂。

## 17. 风险与对策

最大的两个风险是「AI 不会用自研框架」和「框架慢慢长成低代码」，阶段 0 的对照实验和预算检查就是为它们设的。

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 自研框架没有训练数据 | agent 反复写错原语 | API 控制在十几个函数；范例和错误码册；报错直接给修法；用一次通过率度量 |
| 框架长成低代码 | 原语和配置项不断增加 | 设计文档第 15 节的预算与红线；新增原语必须过准入流程 |
| 行级安全拖慢查询 | 列表和报表变慢 | 范围列建索引；视图执行计划纳入性能基线。注意物化视图不受行级安全约束，只能用于不含范围敏感数据的汇总，或在其上再套一层带范围过滤的安全视图 |
| 同事务反应扩大锁范围 | 高并发下死锁或超时 | 默认走 outbox；same 必须显式声明且限同库；压测覆盖 |
| 声明表达不了的业务 | AI 绕路或大量使用 unsafe | unsafe 计数报警；定期复盘缺口，决定补组合子还是留在 handler 里实现 |
| 迁移风险 | 破坏性结构变更导致线上故障 | 先扩展再收缩；迁移草稿人审；预发布环境演练 |
| 审批引擎跨语言 | Java 引擎与 Node 系统集成成本高 | 先评估代码内封闭路由能否覆盖需求；需要引擎时以独立服务接入 |
| 框架维护人力 | 人员变动后内核无人能改 | 内核体积预算；内核文档与测试覆盖；至少两人熟悉内核 |
| 绑定 PostgreSQL | 将来换库成本高 | 接受这个绑定，换取数据库层的安全兜底 |

## 18. 待决策事项

D1 已定为 TypeScript。D2、D3、D5、D6 会影响表结构和内核默认值，需要在 PoC 开始前定下。

| 编号 | 决策 | 选项 | 建议 | 何时定 |
| --- | --- | --- | --- | --- |
| D1 | 实现语言 | — | TypeScript，前后端统一 | 已定 |
| D2 | 数据库 | PostgreSQL；MySQL | PostgreSQL | PoC 开始前 |
| D3 | 反应默认事务语义 | same；outbox | outbox | PoC 开始前 |
| D4 | 审批路由 | 引擎服务；代码内封闭路由 | 先评估封闭路由能否覆盖 | 阶段 2 前 |
| D5 | 多租户 | 需要；不需要 | 待定 | PoC 开始前，影响所有表结构 |
| D6 | 后端 HTTP | Fastify；Nest | Fastify | PoC 开始前 |
| D7 | 前端框架 | React；Vue | 按团队熟悉度 | 阶段 0 第 10 项前 |
| D8 | 系统管理前端 | 独立子应用；与业务前端合并 | 独立子应用 | 阶段 1 前 |
