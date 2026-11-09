/**
 * 从运行注册表构建可解释的领域目录，供 AI 发现声明和读取规则摘要。
 * 不导出 handler、SQL、隐藏字段和密钥；本体只描述声明，实际数据读取/写入仍走内核。
 */
import { registryFingerprint, type Registry, type Ctx, type Fields } from '@yss123/cage-kernel';
import { z } from 'zod';
import { nodeVisible } from './catalog.js';
export { OntologyCatalog, ontologyCatalog, nodeKey, type OntologySummary, type OntologySearch } from './catalog.js';

/**
 * 一个聚合、命令、查询或审批的公开声明节点，data 只保存可解释事实。
 */
export interface RuntimeNode { /** 类型内稳定标识，如聚合名或命令能力点。 */ id: string; /** 节点种类，和 id 一起形成唯一 key。 */ kind: 'aggregate' | 'command' | 'query' | 'approval'; /** 声明中文说明，缺失时回退稳定标识。 */ title: string; /** 可解释的字段、输入、状态和规则摘要，不含函数体。 */ data: Record<string, unknown>; /** 关联的聚合名，用于发现权限和关系组织。 */ reads: string[] }
/**
 * 带版本与注册指纹的运行本体，可在启动时验证与当前注册表一致。
 */
export interface RuntimeOntology { /** 本体格式版本，当前为 1。 */ version: 1; /** 来源注册表指纹，防止旧目录与新运行混用。 */ fingerprint: string; /** 公开声明节点列表，不代表全部业务数据。 */ nodes: RuntimeNode[] }

/** 只导出可解释的声明事实；handler、SQL、隐藏字段与密钥不会成为模型上下文。 */
/**
 * 提取公开字段、状态、命令输入与调用身份、查询依赖和审批步骤；不序列化可执行函数。
 * @param registry 当前运行注册表。
 * @returns 与注册指纹绑定的目录；规则只有名称时不能据此推断阈值。
 */
export function runtimeOntology(registry: Registry): RuntimeOntology {
  const nodes: RuntimeNode[] = [];
  for (const aggregate of registry.aggregates) nodes.push({ id: aggregate.name, kind: 'aggregate', title: aggregate.description ?? aggregate.name, reads: [aggregate.name],
    data: { fields: Object.fromEntries(Object.entries(aggregate.fields as Fields).filter(([, f]) => !f.isHidden).map(([name, f]) => [name, {
      kind: f.kind, description: f.description, optional: f.isOptional, sensitive: f.sensitiveKind, relation: f.ref, values: f.values,
    }])), states: aggregate.states.values, invariants: Object.keys(aggregate.invariants) } });
  for (const { capability, cmd } of registry.commands) nodes.push({ id: capability, kind: 'command', title: cmd.description ?? capability, reads: [cmd.agg.name],
    data: { aggregate: cmd.agg.name, input: z.toJSONSchema(cmd.input, { io: 'input', unrepresentable: 'any' }), from: cmd.from, to: cmd.to,
      invokedBy: cmd.invokedBy, constraints: cmd.constraints.map(c => c.name) } });
  for (const query of registry.queries) nodes.push({ id: query.name, kind: 'query', title: query.description ?? query.name, reads: query.reads.map(a => a.name),
    data: { input: z.toJSONSchema(query.input, { io: 'input', unrepresentable: 'any' }), purpose: query.audit?.purpose } });
  for (const { a } of registry.approvals) {
    const route = registry.extensions.find(e => e.kind === 'ROUTE' && e.value.process === a.process);
    const publicStep = (step: any): unknown => step.kind === 'when' ? { kind: 'when', condition: step.cond, steps: step.steps.map(publicStep) }
      : step.kind === 'parallel' ? { kind: 'parallel', title: step.title, join: 'all',
        branches: step.branches.map((branch: any) => ({ title: branch.title, steps: branch.nodes.map(publicStep) })) }
      : step.kind === 'ai' ? { kind: 'ai', title: step.title, outcomes: ['pass', 'return', 'manual'] }
      : { kind: 'human', title: step.title, approver: step.approver, mode: step.mode };
    nodes.push({ id: a.process, kind: 'approval', title: a.process, reads: [a.agg.name], data: { aggregate: a.agg.name,
      onApproved: registry.capabilityOf(a.onApproved), onRejected: registry.capabilityOf(a.onRejected),
      onReturned: a.onReturned && registry.capabilityOf(a.onReturned), steps: route?.value.nodes.map(publicStep) ?? [] } });
  }
  return { version: 1, fingerprint: registryFingerprint(registry), nodes };
}

/**
 * 按当前能力筛选可发现节点；命令依赖命令能力，其他节点依赖全部 reads 的 read 能力，行范围仍由实际读取处理。
 */
export function visibleNodes(ontology: RuntimeOntology, ctx: Ctx): RuntimeNode[] {
  return ontology.nodes.filter(node => nodeVisible(node, ctx));
}

/** 确定性召回保留来源 ID；模型解释不能把名称匹配当作执行证据。 */
/**
 * 旧式确定性关键词检索，按匹配数和 ID 排序，最多 40 项；名称匹配不是执行证据，大目录优先用分页 catalog。
 */
export function searchOntology(ontology: RuntimeOntology, ctx: Ctx, query: string, limit = 12): RuntimeNode[] {
  const text = query.normalize('NFKC').toLowerCase();
  const words = text.match(/[a-z0-9_.]+|[\p{Script=Han}]{2}/gu) ?? [text];
  return visibleNodes(ontology, ctx).map(node => ({ node, score: words.reduce((n, word) => n + (JSON.stringify(node).toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(entry => !text || entry.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, Math.min(40, limit)).map(entry => entry.node);
}
