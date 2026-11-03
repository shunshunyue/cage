// 业务规格不能凭名称制造执行链。自动连线只沿真实触发关系核对，
// 人工/等待步骤保留自己的语义；这些检查不执行 handler 或映射函数。
import type { Finding } from './findings.js';
import { projectGraph, type GraphModel, type ViewNode } from './graph-model.js';
import type { Ontology } from './ontology.js';

export function causalSuccessors(model: GraphModel, key: string): string[] {
  const node = model.nodes.find(n => n.key === key);
  return model.edges.filter(e => e.from === key && !e.derived && (
    ['emits', 'triggers', 'targets'].includes(e.kind) || (e.kind === 'binds' && node?.kind === 'approval')
  )).map(e => e.to);
}

function reachable(start: string, next: (key: string) => string[]): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) for (const key of next(queue[i])) {
    if (!seen.has(key)) { seen.add(key); queue.push(key); }
  }
  return seen;
}

export function checkBusinessProcesses(graph: Ontology): Finding[] {
  const model = projectGraph(graph);
  const nodes = new Map(model.nodes.map(n => [n.key, n]));
  const findings: Finding[] = [];
  const fail = (node: ViewNode, reason: string, fix: string) => findings.push({
    code: 'CAGE-BIZ-002', at: node.file ? `${node.file}:${node.line}` : node.id, reason, fix,
  });
  const actual = (start: string) => reachable(start, key => causalSuccessors(model, key));
  const involving = (start: string, target: string) => {
    // 写入归属、显式读取、字段引用与实际调用均是对象关联证据，流程规格边不参与。
    const involved = reachable(start, key => {
      const n = nodes.get(key)!;
      const owner = ['command', 'field'].includes(n.kind) ? model.nodes.find(a => a.kind === 'aggregate' && n.id.startsWith(`${a.id}.`))?.key : undefined;
      return [...causalSuccessors(model, key), ...(owner ? [owner] : []),
        ...model.edges.filter(e => e.from === key && ['reads', 'queries', 'refs', 'uses'].includes(e.kind)).map(e => e.to)];
    });
    return involved.has(target);
  };
  for (const process of model.nodes.filter(n => n.kind === 'process')) {
    const stages = model.nodes.filter(n => n.kind === 'stage' && n.attrs.process === process.id);
    const stageKeys = new Set(stages.map(n => n.key));
    const edges = model.edges.filter(e => e.kind === 'follows' && stageKeys.has(e.from));
    const entry = `stage:${process.attrs.entry}`;
    const reached = reachable(entry, key => edges.filter(e => e.from === key).map(e => e.to));
    const ends = stages.filter(n => n.attrs.stageKind === 'end');
    const canEnd = new Set(ends.flatMap(end => [...reachable(end.key, key => edges.filter(e => e.to === key).map(e => e.from))]));
    if (!ends.length) fail(process, `“${process.attrs.title}”没有结束阶段`, '至少声明一个 kind: end 的业务结果，便于看清流程何时结束');
    for (const stage of stages) {
      if (!reached.has(stage.key)) fail(stage, `业务阶段“${stage.attrs.title}”从入口不可达`, '补充到该阶段的业务连线，或删除不属于本流程的阶段');
      if (!canEnd.has(stage.key)) fail(stage, `业务阶段“${stage.attrs.title}”无法到达结束结果`, '补齐后续或退出分支；循环流程也需要可到达的结束结果');
      const primary = String(stage.attrs.primary);
      const chain = actual(primary);
      for (const relation of model.edges.filter(e => e.kind === 'relates' && e.from === stage.key)) {
        if (!relation.via || !chain.has(relation.via) || !involving(relation.via, relation.to)) {
          fail(stage, `“${stage.attrs.title}”的关联“${relation.label}”缺少对应实现关系`, 'via 应引用本阶段实际可触发的声明，并通过写入归属、读取或引用关联目标业务对象');
        }
      }
    }
    for (const edge of edges) {
      const from = nodes.get(edge.from)!;
      const to = nodes.get(edge.to)!;
      const a = nodes.get(String(from.attrs.primary))!;
      const b = nodes.get(String(to.attrs.primary))!;
      if (edge.mode === 'automatic' && (a.key === b.key || !actual(a.key).has(b.key))) {
        fail(from, `“${from.attrs.title} → ${to.attrs.title}”标为自动触发，但没有实际触发链`, '补齐事件/反应/审批结论/外部成功回写；人工后续用 manual，独立通知或调度用 wait');
      }
      if (edge.mode === 'manual' && !(b.kind === 'command' && (b.attrs.invokedBy as string[]).includes('user'))) {
        fail(to, `“${to.attrs.title}”标为人工下一步，但实现不是用户可调用命令`, '人工阶段绑定 invokedBy 包含 user 的命令；审批结论保留 automatic，并由审批声明证明');
      }
      if (edge.mode === 'wait' && !(b.kind === 'inbound' || b.kind === 'job' || (b.kind === 'command' && (b.attrs.invokedBy as string[]).some(k => ['external', 'job'].includes(k))))) {
        fail(to, `“${to.attrs.title}”标为等待，但实现没有外部通知或调度入口`, '等待阶段引用真实 inbound、job 或允许 external/job 调用的命令，并写明等待条件');
      }
      // 同一对象的后续操作只能从前一步实际产生的状态继续；不跨对象猜测状态。
      if (edge.mode !== 'automatic' && a.kind === 'command' && b.kind === 'command'
        && a.id.slice(0, a.id.lastIndexOf('.')) === b.id.slice(0, b.id.lastIndexOf('.'))
        && a.attrs.to != null && !(b.attrs.from as string[]).includes(String(a.attrs.to))) {
        fail(to, `“${from.attrs.title} → ${to.attrs.title}”的状态不相接`, '核对 from/to 与业务阶段，不能用流程描述绕过命令状态约束');
      }
    }
  }
  return findings;
}
