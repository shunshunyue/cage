/**
 * 从运行时本体目录选择用户可调用的业务工具。
 * 请求规划器用候选顺序决定优先装载哪些完整 schema；本模块只处理可见性、调用身份和 key，不执行业务，也不自行决定 Token 容量。
 */
import { cageError } from '@yss123/cage-kernel';
import { ontologyCatalog, type RuntimeNode } from '@yss123/cage-ontology';
import type { Execution } from './types.js';

/**
 * 判断节点能否作为助理业务工具：允许命名查询及 invokedBy 含 user 的命令。
 * 可见性和能力过滤由目录调用方负责；内部 process/job/external 命令不会因名称被模型发现而获得用户入口。
 */
export function callable(node: RuntimeNode): boolean {
  return node.kind === 'query' || (node.kind === 'command' && (node.data.invokedBy as string[]).includes('user'));
}

/**
 * 返回当前 ctx 在本体目录中可见且用户可调用的全部业务 key。
 * 这是能力候选集合，目标对象范围和具体约束仍在工具执行时复核。
 */
export function authorizedToolKeys(execution: Pick<Execution, 'ontology' | 'ctx'>): string[] {
  return ontologyCatalog(execution.ontology).keys(execution.ctx, {}, callable);
}

/** 仅排序候选，不在这里决定数量。完整定义的成本由请求规划器统一计算。 */
/**
 * 按已加载工具、当前草稿命令、任务关键词和页面聚合依次收集候选并去重。
 * 页面仅提供排序线索，不限制整个业务目录；此处不按数量截断，完整定义成本由请求规划器统一计算。
 */
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
/**
 * 验证显式加载列表并返回去重 key，数量必须为 1 至 128。
 * 逐项经过当前主体的目录访问与用户可调用检查，未知、不可见或内部命令立即拒绝；本函数不保证这些 schema 最终能装入预算。
 */
export function loadToolKeys(execution: Execution, requested: string[]): string[] {
  const catalog = ontologyCatalog(execution.ontology),
    unique = [...new Set(requested)];
  if (!unique.length || unique.length > 128) throw cageError('INVALID_INPUT', '工具加载数量必须在 1 至 128 之间');
  for (const key of unique)
    if (!callable(catalog.node(execution.ctx, key))) throw cageError('INVALID_INPUT', '只能加载用户可调用的命令或查询');
  return unique;
}
