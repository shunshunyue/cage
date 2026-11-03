import { nodeLabel, type GraphModel, type ViewNode } from './graph-model.js';

export interface BusinessBlock {
  id: string;
  title: string;
  objects: ViewNode[];
  flows: ViewNode[];
  processes: ViewNode[];
  description?: string;
  system: boolean;
}

export const isSystemObject = (node: ViewNode) => /^(User|Role|Dept)(\.|$)/.test(node.id);

export function businessOwner(model: GraphModel, node: ViewNode): ViewNode | undefined {
  if (node.kind === 'aggregate') return node;
  // 查询、事件等可任意命名，不能凭同名前缀把它们归入某个对象。
  if (!['command', 'state', 'field', 'capability', 'entry'].includes(node.kind)) return undefined;
  return model.nodes
    .filter((n) => n.kind === 'aggregate' && node.id.startsWith(`${n.id}.`))
    .sort((a, b) => b.id.length - a.id.length)[0];
}

/** 板块只组织展示，不新增本体关系。模块目录提供归属，旧的平铺项目按对象分组；
 * 查询与任务允许出现在多个相关板块，但不会沿读取关系扩散出一整张业务图。 */
export function businessBlocks(
  model: GraphModel,
  labels: Record<string, string> = {},
  showSystem = false,
): BusinessBlock[] {
  const blocks = new Map<string, BusinessBlock>();
  const owners = new Map<string, BusinessBlock>();
  const commands = model.nodes.filter((n) => n.kind === 'command');
  const count = (n: ViewNode) => commands.filter((c) => businessOwner(model, c)?.key === n.key).length;
  const objects = model.nodes
    .filter((n) => n.kind === 'aggregate')
    .sort((a, b) => count(b) - count(a) || a.id.localeCompare(b.id));
  const processes = model.nodes.filter((n) => n.kind === 'process');
  for (const node of objects) {
    const system = isSystemObject(node);
    if (system && !showSystem) continue;
    const module = node.file?.replaceAll('\\', '/').match(/(?:^|\/)modules\/([^/]+)\//)?.[1];
    const process = processes.find((p) => p.attrs.subject === node.id);
    const area = process?.attrs.area as { id: string; title: string; description: string } | undefined;
    const id = system
      ? 'system:organization'
      : area
        ? `module:${area.id}`
        : module
          ? `module:${module}`
          : node.key;
    let block = blocks.get(id);
    if (!block) {
      block = {
        id,
        title: system ? '组织与权限' : (area?.title ?? businessLabel(node, labels)),
        description: area?.description,
        objects: [],
        flows: [],
        processes: [],
        system,
      };
      blocks.set(id, block);
    }
    block.objects.push(node);
    owners.set(node.id, block);
  }
  for (const block of blocks.values()) {
    block.title = labels[block.id] || block.title;
  }
  for (const process of processes) {
    const subject = model.nodes.find((n) => n.kind === 'aggregate' && n.id === process.attrs.subject);
    if (subject && isSystemObject(subject) && !showSystem) continue;
    const area = process.attrs.area as { id: string; title: string; description: string };
    const id = `module:${area.id}`;
    let block = blocks.get(id);
    if (!block) {
      block = {
        id,
        title: labels[id] || area.title,
        description: area.description,
        objects: [],
        flows: [],
        processes: [],
        system: false,
      };
      blocks.set(id, block);
    }
    block.title = labels[id] || area.title;
    block.description = area.description;
    block.processes.push(process);
  }
  const byKey = new Map(model.nodes.map((n) => [n.key, n]));
  for (const node of model.nodes) {
    if (!['command', 'query', 'job', 'inbound'].includes(node.kind)) continue;
    const related = new Set<BusinessBlock>();
    const addOwner = (target: ViewNode | undefined) => {
      const owner = target && businessOwner(model, target);
      const block = owner && owners.get(owner.id);
      if (block) related.add(block);
    };
    addOwner(node);
    for (const edge of model.edges) {
      if (edge.from !== node.key || !['queries', 'calls', 'targets'].includes(edge.kind)) continue;
      addOwner(byKey.get(edge.to));
    }
    // 组织模型在开关关闭时不借“其他业务”重新出现。
    if (!related.size && businessOwner(model, node) && !showSystem) continue;
    if (!related.size) {
      const belongsToHiddenSystem = model.edges.some(
        (e) =>
          e.from === node.key &&
          ['queries', 'calls', 'targets'].includes(e.kind) &&
          isSystemObject(byKey.get(e.to)!),
      );
      if (belongsToHiddenSystem && !showSystem) continue;
      const id = 'other:collaboration';
      if (!blocks.has(id))
        blocks.set(id, {
          id,
          title: '其他业务协作',
          objects: [],
          flows: [],
          processes: [],
          system: false,
        });
      related.add(blocks.get(id)!);
    }
    for (const block of related) block.flows.push(node);
  }
  for (const block of blocks.values())
    block.flows.sort((a, b) => {
      const rank = (n: ViewNode) =>
        n.kind !== 'command'
          ? 3
          : n.attrs.from === 'new'
            ? 0
            : (n.attrs.invokedBy as string[] | undefined)?.includes('user')
              ? 1
              : 2;
      return (
        rank(a) - rank(b) ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.id.localeCompare(b.id)
      );
    });
  return [...blocks.values()].sort(
    (a, b) =>
      Number(a.system) - Number(b.system) || b.flows.length - a.flows.length || a.id.localeCompare(b.id),
  );
}

export interface BusinessStep {
  /** 路径身份区分相同命令在不同分支中的映射来源。 */
  id: string;
  node: ViewNode;
  via: ViewNode[];
  label: string;
  note: string;
  children: BusinessStep[];
  repeated: boolean;
  boundary: boolean;
  mode?: 'manual' | 'automatic' | 'wait' | 'association' | 'lifecycle';
  /** 来自业务流程声明的次要分支，只影响阅读与布线，不推断取消等业务含义。 */
  branch?: boolean;
}

/** 业务页面缺少文案时明确提示补充，不用程序标识替代业务名称。完整本体仍保留标识。 */
export function businessLabel(node: ViewNode, labels: Record<string, string> = {}): string {
  if (node.kind === 'entry') return '新建业务';
  if (labels[node.key] || node.attrs.title || node.attrs.description) return nodeLabel(node, labels);
  return `待命名${({ aggregate: '业务对象', command: '操作', state: '状态', process: '流程', stage: '阶段', event: '业务结果', reaction: '自动处理', approval: '审批', inbound: '外部通知', outbound: '外部同步', query: '查询', job: '定时处理' } as Record<string, string>)[node.kind] ?? '声明'}`;
}

export const businessJourneys = (block: BusinessBlock, model: GraphModel) =>
  block.processes.length
    ? [...block.processes].sort(
        (a, b) =>
          (a.file ?? '').localeCompare(b.file ?? '') ||
          (a.line ?? 0) - (b.line ?? 0) ||
          a.id.localeCompare(b.id),
      )
    : block.objects.filter((object) =>
        model.edges.some((e) => e.kind === 'transition' && e.to.startsWith(`state:${object.id}.`)),
      );

/** 显式流程的阶段是唯一身份。汇合与循环回连已有阶段，避免复制成多份业务。 */
export function traceBusinessProcess(
  model: GraphModel,
  process: ViewNode,
  options: { branches: boolean; related: boolean },
): BusinessStep {
  const nodes = new Map(model.nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const walk = (key: string, incoming?: GraphModel['edges'][number]): BusinessStep => {
    const node = nodes.get(key)!;
    const repeated = seen.has(key);
    const mode = incoming?.mode;
    const step: BusinessStep = {
      id: repeated ? `${incoming!.from}>${key}` : key,
      node,
      via: model.edges.filter((e) => e.from === key && e.kind === 'implements').map((e) => nodes.get(e.to)!),
      label: incoming
        ? `${{ manual: '人工', automatic: '自动', wait: '等待' }[mode!]} · ${incoming.label}`
        : '流程起点',
      note:
        mode === 'automatic'
          ? '由实际声明触发；执行条件、事务与映射以实现为准。'
          : mode === 'wait'
            ? '等待外部通知或定时处理，流程图本身不发起调用。'
            : '由参与人发起，仍需通过权限和业务规则检查。',
      mode,
      branch: incoming?.branch,
      children: [],
      repeated,
      boundary: false,
    };
    if (repeated) return step;
    seen.add(key);
    step.children = model.edges
      .filter((e) => e.kind === 'follows' && e.from === key && (options.branches || !e.branch))
      .map((e) => walk(e.to, e));
    if (options.related)
      for (const relation of model.edges.filter((e) => e.kind === 'relates' && e.from === key)) {
        const object = nodes.get(relation.to)!;
        step.children.push({
          id: `${key}>${object.key}`,
          node: object,
          via: relation.via && nodes.has(relation.via) ? [nodes.get(relation.via)!] : [],
          label: relation.label ?? '关联对象',
          note: '业务对象关联；不表示下一步操作或额外触发。',
          mode: 'association',
          children: [],
          repeated: false,
          boundary: false,
        });
      }
    return step;
  };
  return walk(`stage:${process.attrs.entry}`);
}

/** 旧项目按实际状态迁移阅读；只表达允许的操作，绝不推断成自动调用链。 */
export function traceBusinessLifecycle(
  model: GraphModel,
  object: ViewNode,
  labels: Record<string, string>,
): BusinessStep {
  const nodes = new Map(model.nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const entry =
    nodes.get(`entry:${object.id}.[new]`) ??
    model.nodes.find((n) => n.kind === 'state' && n.id.startsWith(`${object.id}.`) && n.attrs.initial)!;
  const walk = (node: ViewNode, via: ViewNode[] = [], parent = ''): BusinessStep => {
    const repeated = seen.has(node.key);
    const action = via[0];
    const actor = (action?.attrs.invokedBy ?? []) as string[];
    const label = action
      ? `${actor.includes('user') ? '人工' : actor.includes('external') ? '外部通知' : actor.includes('process') ? '审批结论' : '业务操作'} · ${businessLabel(action, labels)}`
      : '生命周期起点';
    const step: BusinessStep = {
      id: repeated ? `${parent}>${node.key}` : node.key,
      node,
      via,
      label,
      note: '根据已声明状态迁移整理，表示允许执行的操作；条件与触发方式请查看实现。',
      mode: 'lifecycle',
      repeated,
      boundary: false,
      children: [],
    };
    if (repeated) return step;
    seen.add(node.key);
    step.children = model.edges
      .filter((e) => e.kind === 'transition' && e.from === node.key)
      .map((e) => walk(nodes.get(e.to)!, [nodes.get(`command:${e.via}`)!], node.key));
    return step;
  };
  return walk(entry);
}

/** 只沿会驱动后续操作的声明追踪。状态可达性和 reads 均不当作调用顺序。
 * 事件与反应收进步骤的实现依据，但保留事务、条件映射、取消及审批结论语义。 */
export function traceBusinessFlow(model: GraphModel, root: string, maxDepth = 6): BusinessStep | undefined {
  const nodes = new Map(model.nodes.map((n) => [n.key, n]));
  const outgoing = (key: string) => model.edges.filter((e) => e.from === key && !e.derived);
  type Next = { node: ViewNode; via: ViewNode[]; label: string; note: string };
  const next = (node: ViewNode): Next[] => {
    const result: Next[] = [];
    const add = (key: string, via: ViewNode[], label: string, note = '') => {
      const target = nodes.get(key);
      if (target) result.push({ node: target, via, label, note });
    };
    for (const edge of outgoing(node.key)) {
      const target = nodes.get(edge.to)!;
      if (node.kind === 'command' && edge.kind === 'emits') {
        const effects = outgoing(target.key).filter((e) => ['triggers', 'cancels'].includes(e.kind));
        if (!effects.length) add(target.key, [], '成功后产生的结果');
        for (const effect of effects) {
          const handler = nodes.get(effect.to)!;
          if (effect.kind === 'cancels') {
            add(handler.key, [target], '取消审批', '该分支终止审批，不继续执行审批结论。');
          } else if (handler.kind === 'reaction') {
            for (const call of outgoing(handler.key).filter((e) => e.kind === 'targets')) {
              add(
                call.to,
                [target, handler],
                handler.attrs.tx === 'same' ? '成功后 · 同一事务' : '成功后 · 异步处理',
                '是否调用及输入由映射函数决定；返回 null 时跳过。',
              );
            }
          } else {
            add(
              handler.key,
              [target],
              handler.kind === 'approval' ? '成功后 · 异步启动审批' : '成功后 · 异步外部同步',
            );
          }
        }
      } else if (node.kind === 'approval' && edge.kind === 'binds' && target.kind === 'command') {
        add(
          target.key,
          [],
          node.attrs.onApproved === target.id ? '审批通过时' : '审批驳回时',
          '审批结论仍须通过目标业务操作的权限与规则检查。',
        );
      } else if (node.kind === 'outbound' && edge.kind === 'targets' && target.kind === 'command') {
        add(target.key, [], '外部调用成功后回写');
      } else if (node.kind === 'inbound' && edge.kind === 'targets' && target.kind === 'command') {
        add(target.key, [], '验签与映射后');
      } else if (node.kind === 'job' && edge.kind === 'calls') {
        add(target.key, [], '任务声明可调用', '实际调用条件和次数由任务实现决定。');
      } else if (node.kind === 'reaction' && edge.kind === 'targets') {
        add(target.key, [], node.attrs.tx === 'same' ? '同一事务' : '异步处理', '是否调用由映射函数决定。');
      } else if (node.kind === 'event' && edge.kind === 'triggers') {
        add(target.key, [], '结果触发的后续处理');
      }
    }
    return result;
  };
  let count = 0;
  const walk = (item: Next, path: string[], seen: Set<string>, depth: number): BusinessStep => {
    const nextPath = [...path, ...item.via.map((n) => n.key), item.node.key];
    const id = nextPath.join('>');
    const repeated = seen.has(item.node.key);
    // 取消审批是终止动作，不能再展示“通过/驳回”的后续调用。
    const children = item.label === '取消审批' ? [] : next(item.node);
    const boundary = !repeated && children.length > 0 && (depth >= maxDepth || count >= 60);
    count++;
    const step: BusinessStep = { ...item, id, children: [], repeated, boundary };
    if (!repeated && !boundary) {
      const visited = new Set([...seen, item.node.key]);
      step.children = children.map((child) => walk(child, nextPath, visited, depth + 1));
    }
    return step;
  };
  const node = nodes.get(root);
  return node && walk({ node, via: [], label: '业务入口', note: '' }, [], new Set(), 0);
}

export function flattenBusinessSteps(root: BusinessStep): BusinessStep[] {
  return [root, ...root.children.flatMap(flattenBusinessSteps)];
}

export function businessStateSummary(node: ViewNode, labels: Record<string, string>): string {
  if (node.kind !== 'command') return '';
  const owner = node.id.slice(0, node.id.lastIndexOf('.'));
  const name = (s: string) => (s === 'new' ? '新建' : (labels[`state:${owner}.${s}`] ?? '待命名状态'));
  const from = (Array.isArray(node.attrs.from) ? node.attrs.from : [node.attrs.from]) as string[];
  return `${from.filter(Boolean).map(name).join(' / ')} → ${node.attrs.to == null ? '保持当前状态' : name(String(node.attrs.to))}`;
}

export function businessConstraintLabel(name: string, owner: string, labels: Record<string, string>): string {
  const field = (id: string) => labels[`field:${owner}.${id}`] ?? id;
  const ceiling = /^ceiling\((.+)\)$/.exec(name);
  if (ceiling) return `${field(ceiling[1])}不超过审批额度`;
  const sod = /^sod\.notSameAs\((.+)\)$/.exec(name);
  if (sod) return `审批人与${field(sod[1])}不同`;
  return (
    (
      {
        stepUp: '需要二次认证',
        knownCapability: '能力点必须已声明',
        noEscalation: '不能授予超出自身的能力',
        noWiderScope: '不能授予超出自身的数据范围',
        noEscalationViaRoles: '不能通过分配角色提权',
      } as Record<string, string>
    )[name] ?? name
  );
}
