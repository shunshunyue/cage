import { cageError } from '@yss123/cage-kernel';
import { ontologyCatalog, type RuntimeNode } from '@yss123/cage-ontology';
import type { Execution } from './types.js';

export function callable(node: RuntimeNode): boolean {
  return node.kind === 'query' || (node.kind === 'command' && (node.data.invokedBy as string[]).includes('user'));
}

export function authorizedToolKeys(execution: Pick<Execution, 'ontology' | 'ctx'>): string[] {
  return ontologyCatalog(execution.ontology).keys(execution.ctx, {}, callable);
}

/** 仅排序候选，不在这里决定数量。完整定义的成本由请求规划器统一计算。 */
export function candidateToolKeys(execution: Pick<Execution, 'ontology' | 'ctx' | 'run'>): string[] {
  const { ontology, ctx, run } = execution,
    catalog = ontologyCatalog(ontology);
  const keys = new Set(run.tool_keys ?? []);
  const draft = run.page_context?.draft?.command;
  if (draft && ctx.capabilities.has(draft)) keys.add(`command:${draft}`);
  for (const key of catalog.keys(ctx, { query: run.input }, callable)) keys.add(key);
  const aggregate =
    run.page_context?.subject?.aggregate ?? run.page_context?.view?.aggregate ?? run.page_context?.selection?.aggregate;
  if (aggregate) for (const key of catalog.keys(ctx, { aggregate }, callable)) keys.add(key);
  return [...keys];
}
export function loadToolKeys(execution: Execution, requested: string[]): string[] {
  const catalog = ontologyCatalog(execution.ontology),
    unique = [...new Set(requested)];
  if (!unique.length || unique.length > 128) throw cageError('INVALID_INPUT', '工具加载数量必须在 1 至 128 之间');
  for (const key of unique)
    if (!callable(catalog.node(execution.ctx, key))) throw cageError('INVALID_INPUT', '只能加载用户可调用的命令或查询');
  return unique;
}
