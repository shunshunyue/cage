# @yss123/cage-ontology

Cage 的运行时本体与能力发现包。从当前注册表提取聚合、命令、查询和审批的可解释声明，再按调用人的能力过滤并检索。主要用于服务端 AI 工具发现或受控能力目录，不是业务数据查询引擎、向量数据库或前端图谱组件。

## 安装

需要 Node.js 24+，与 kernel 等框架包保持同版本：

```powershell
pnpm add @yss123/cage-ontology @yss123/cage-kernel
```

普通应用启用 `@yss123/cage-ai` 时由运行时使用本包，无需再创建另一套本体服务。开发期间查源码、图谱、路径或影响范围，使用 `@yss123/cage-cli` 的 `cage context/graph`。

## 服务端检索示例

下面是服务端集成函数；`registry` 必须来自当前应用，`ctx` 来自已认证且实时解析授权的身份。不要从浏览器输入构造权限上下文。

```ts
/** 从当前注册表构建目录；函数只提取声明，不查询业务表或执行命令。 */
import { type Ctx, type Registry } from '@yss123/cage-kernel';
import { ontologyCatalog, runtimeOntology } from '@yss123/cage-ontology';

/**
 * 为受信任服务端调用方检索当前身份可发现的节点。
 * @param registry 当前运行的领域注册表。
 * @param ctx 认证层提供的身份和能力；行级范围由实际读取另行落实。
 * @param query 中文说明、标识或字段关键词。
 * @returns 有界摘要页；nextOffset 非空表示还存在后续结果。
 */
export function discover(registry: Registry, ctx: Ctx, query: string) {
  const ontology = runtimeOntology(registry);
  const catalog = ontologyCatalog(ontology);
  return catalog.search(ctx, { query, offset: 0, limit: 10 });
}
```

高频使用时在注册表确定后构建一次 `RuntimeOntology` 与目录，并在每次请求中传入当前 `ctx`；不要缓存用户授权结果。注册声明变化后重新构建，本体的 `fingerprint` 记录来源注册表。

## 主要入口与结果

| 入口 | 作用 |
| --- | --- |
| `runtimeOntology(registry)` | 提取公开字段、状态、输入、调用身份、规则名称与审批步骤 |
| `ontologyCatalog(ontology)`、`OntologyCatalog` | 为稳定本体建立检索与关联索引 |
| `catalog.search(ctx, input)` | 返回摘要、total、nextOffset、truncated；每页最多 20 项 |
| `catalog.describe(ctx, key, section)` | 按 overview、fields、input、related 展开详情；字段和关系支持分页 |
| `catalog.node(ctx, key)` | 读取一个授权可见节点；不存在和无权限均返回 NOT_FOUND |
| `nodeKey(node)` | 得到 `aggregate:Note`、`command:Note.create` 等稳定键 |
| `visibleNodes`、`searchOntology` | 直接过滤及简单关键词召回；大目录优先使用分页 catalog |

运行本体不包含 handler 函数体、SQL、隐藏字段或密钥。命令可发现性按命令能力判断，其他节点要求其读依赖的 read 能力；可发现不等于可以访问任意业务记录或立即执行命令。状态、版本、数据范围与硬约束仍在实际读写阶段判断。

搜索是确定性的关键词匹配，名称命中不是执行证据。规则只有名称时不能推断其阈值；分页未取完必须检查 `nextOffset/truncated`，不能把当前页当成完整业务集合。

## 文档

- [运行本体与 AI 工具发现](https://github.com/shunshunyue/cage/blob/main/docs/development/guides/intelligence.md)
- [开发时的本体查询与源码定位](https://github.com/shunshunyue/cage/blob/main/docs/development/tools/ontology-context.md)
- [能力发现与诊断](https://github.com/shunshunyue/cage/blob/main/docs/development/tools/diagnostics.md)

源码与反馈：[GitHub](https://github.com/shunshunyue/cage)。许可证：[MIT](https://github.com/shunshunyue/cage/blob/main/LICENSE)。
