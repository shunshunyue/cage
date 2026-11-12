# @yss123/cage-ontology

从当前注册表生成服务端运行本体，按主体能力检索聚合、命令、查询和审批摘要，供 AI 工具发现和受控能力目录使用。

## 服务端发现

安装 pnpm add @yss123/cage-ontology @yss123/cage-kernel，使用同版本框架和 Node.js 24+：

```ts
import type { Ctx, Registry } from '@yss123/cage-kernel';
import { ontologyCatalog, runtimeOntology } from '@yss123/cage-ontology';

/** 从已认证上下文发现声明；业务行范围仍由实际读取与执行层检查。 */
export function discover(registry: Registry, ctx: Ctx, query: string) {
  const catalog = ontologyCatalog(runtimeOntology(registry));
  return catalog.search(ctx, { query, offset: 0, limit: 10 });
}
```

registry 来自当前应用，ctx 来自可信认证和授权解析；浏览器不能自行构造权限。启用 cage-ai 后运行时自动使用这些能力，应用通常无需另建本体服务。

## 区分声明与数据

本体描述字段、输入、规则名称与关系，不查询业务数据、不执行命令，也不导出 handler 或 SQL 源码。发现节点仍需调用相应授权工具才能读取记录或执行动作。

检索基于确定性关键词并支持分页，不是向量数据库。开发阶段的源码图谱和影响分析由 CLI context/graph 提供，和这里的运行时目录不同。

[运行时工具参考](https://github.com/shunshunyue/cage/blob/main/docs/development/reference/intelligence.md) · [开发本体工具](https://github.com/shunshunyue/cage/blob/main/docs/development/tools/ontology-context.md)
