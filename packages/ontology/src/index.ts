import { registryFingerprint, type Registry, type Ctx, type Fields } from '@yss123/cage-kernel';
import { z } from 'zod';
import { nodeVisible } from './catalog.js';
export { OntologyCatalog, ontologyCatalog, nodeKey, type OntologySummary, type OntologySearch } from './catalog.js';

export interface RuntimeNode { id: string; kind: 'aggregate' | 'command' | 'query' | 'approval'; title: string; data: Record<string, unknown>; reads: string[] }
export interface RuntimeOntology { version: 1; fingerprint: string; nodes: RuntimeNode[] }

/** 只导出可解释的声明事实；handler、SQL、隐藏字段与密钥不会成为模型上下文。 */
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
      : step.kind === 'ai' ? { kind: 'ai', title: step.title, outcomes: ['pass', 'return', 'manual'] }
      : { kind: 'human', title: step.title, approver: step.approver, mode: step.mode };
    nodes.push({ id: a.process, kind: 'approval', title: a.process, reads: [a.agg.name], data: { aggregate: a.agg.name,
      onApproved: registry.capabilityOf(a.onApproved), onRejected: registry.capabilityOf(a.onRejected),
      onReturned: a.onReturned && registry.capabilityOf(a.onReturned), steps: route?.value.nodes.map(publicStep) ?? [] } });
  }
  return { version: 1, fingerprint: registryFingerprint(registry), nodes };
}

export function visibleNodes(ontology: RuntimeOntology, ctx: Ctx): RuntimeNode[] {
  return ontology.nodes.filter(node => nodeVisible(node, ctx));
}

/** 确定性召回保留来源 ID；模型解释不能把名称匹配当作执行证据。 */
export function searchOntology(ontology: RuntimeOntology, ctx: Ctx, query: string, limit = 12): RuntimeNode[] {
  const text = query.normalize('NFKC').toLowerCase();
  const words = text.match(/[a-z0-9_.]+|[\p{Script=Han}]{2}/gu) ?? [text];
  return visibleNodes(ontology, ctx).map(node => ({ node, score: words.reduce((n, word) => n + (JSON.stringify(node).toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(entry => !text || entry.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, Math.min(40, limit)).map(entry => entry.node);
}
