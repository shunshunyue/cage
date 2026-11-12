/**
 * 把语义图整理为业务板块、显式流程、对象生命周期和操作触发树。
 * 供图谱浏览器使用，优先采用 businessProcess 声明，旧项目按模块或聚合归属组织。
 * 所有投影只辅助阅读，不调度操作；状态迁移、读取依赖、声明调用能力与真实自动触发分别处理。
 */
import { nodeLabel, type GraphModel, type ViewNode } from './graph-model.js';

/**
 * 浏览器业务板块，包含对象、可阅读操作与显式流程；分组不新增执行关系。
 */
export interface BusinessBlock {
  /** 稳定板块身份，来源于显式流程板块、模块路径或回退分组。 */
  id: string;
  /** 板块中文标题，可由展示配置覆盖。 */
  title: string;
  /** 归入板块的聚合展示节点。 */
  objects: ViewNode[];
  /** 板块内可探索的操作/查询等入口节点。 */
  flows: ViewNode[];
  /** 板块显式声明的业务流程节点，区别于自动触发链。 */
  processes: ViewNode[];
  /** 显式板块说明，缺省时不虚构业务目的。 */
  description?: string;
  /** 是否属于系统组织板块，决定默认过滤。 */
  system: boolean;
}

/**
 * 识别 User、Role、Dept 及其成员的系统组织前缀，供默认隐藏开关使用；不表示权限检查。
 */
export const isSystemObject = (node: ViewNode) => /^(User|Role|Dept)(\.|$)/.test(node.id);

/**
 * 只对有明确标识归属的节点寻找聚合，取最长匹配前缀。
 * @param model 语义图。
 * @param node 待定位节点。
 * @returns 聚合或 undefined；事件/查询等任意名称不会按前缀误归属。
 */
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
/**
 * 按显式业务区、模块路径或聚合整理板块，并附声明相关查询与任务。
 * @param model 语义图，不被修改。
 * @param labels 显示覆盖。
 * @param showSystem 是否保留系统组织对象。
 * @returns 稳定排序的板块；同一操作可出现在多个相关板块，不表示重复执行。
 */
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

/**
 * 业务阅读树节点，保留实现依据、连线语义、重复引用和截断边界；不是运行中任务状态。
 */
export interface BusinessStep {
  /** 路径身份区分相同命令在不同分支中的映射来源。 */
  id: string;
  /** 当前阶段或执行主体的展示节点。 */
  node: ViewNode;
  /** 从父步骤到本步骤的中间事件/反应等证据。 */
  via: ViewNode[];
  /** 父子连线的阅读说明，保留事务或条件语义。 */
  label: string;
  /** 步骤补充边界，例如 map 可返回 null 或仅声明可调用。 */
  note: string;
  /** 已展开的后续步骤，不代表运行时一定都会执行。 */
  children: BusinessStep[];
  /** 当前路径重复命中已有节点，布局应回连而非无限展开。 */
  repeated: boolean;
  /** 深度限制等导致停止展开，不能当作业务终点。 */
  boundary: boolean;
  /** 人工、自动、等待、关联或状态图的展示语义；缺省沿传统触发链解释。 */
  mode?: 'manual' | 'automatic' | 'wait' | 'association' | 'lifecycle';
  /** 来自业务流程声明的次要分支，只影响阅读与布线，不推断取消等业务含义。 */
  branch?: boolean;
}

/**
 * 按显示覆盖、声明标题、描述、原始标识的顺序选择业务阅读名称。
 * 与完整本体共用名称规则，避免缺少文案时把不同状态或操作变成同一个“待命名”节点；
 * 不从标识或源码注释猜测业务含义，新建入口仍使用业务阅读专用文案。
 * @param node 展示节点。
 * @param labels 声明文案与 graph.labels 合并后的显示映射。
 * @returns 阅读标题，不修改节点、实际标识或业务规则，也不执行 IO。
 */
export function businessLabel(node: ViewNode, labels: Record<string, string> = {}): string {
  if (node.kind === 'entry') return '新建业务';
  return nodeLabel(node, labels);
}

/**
 * 优先返回板块显式流程并保持源码顺序；没有流程规格时返回有状态迁移的对象供生命周期阅读。
 */
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
/**
 * 把显式流程阶段组织成阅读树，汇合/循环只保留回连标记。
 * @param model 语义图。
 * @param process 已声明业务流程。
 * @param options branches 控制次要分支，related 控制对象关联。
 * @returns 流程入口树；关联不充当下一步，遍历不执行命令。
 */
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
/**
 * 对没有业务流程规格的对象沿允许状态迁移生成阅读树。
 * @param model 语义图。
 * @param object 目标聚合。
 * @param labels 中文文案。
 * @returns 从新建入口或初始状态开始的树；只表示允许操作，不推断自动触发。
 */
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
    // invokedBy 只声明允许的调用身份，process 本身不能证明存在审批绑定。
    // 生命周期沿状态迁移展示操作；具体审批通过/驳回语义由触发链中的 binds 关系解释。
    const label = action
      ? `${actor.includes('user') ? '人工' : actor.includes('external') ? '外部通知' : actor.includes('process') ? '内部流程' : '业务操作'} · ${businessLabel(action, labels)}`
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
/**
 * 沿事件、反应、审批结论及外部回写构建有界操作树。
 * @param model 语义图。
 * @param root 完整节点 key。
 * @param maxDepth 默认 6，另以累计步骤计数限制膨胀。
 * @returns 入口树或 undefined；取消审批停止展开，循环/上限通过 repeated/boundary 显示。
 */
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

/**
 * 按先序把已经有界的阅读树展开成列表。
 * @param root 由追踪函数生成的根。
 * @returns 包含重复引用占位节点的数组，不去重、不执行关系。
 */
export function flattenBusinessSteps(root: BusinessStep): BusinessStep[] {
  return [root, ...root.children.flatMap(flattenBusinessSteps)];
}

/**
 * 把命令 from/to 转成状态迁移摘要，供操作卡片、流程节点和详情复用。
 * 优先读取所属聚合的状态显示名，缺失时保留当前命令内可区分的状态标识；
 * 不从状态标识推测中文含义，也不把多个无标签状态合并成同一占位词。
 * @param node 非命令返回空字符串。
 * @param labels 状态声明标签与 graph.labels 合并后的显示映射。
 * @returns 允许起始状态与目标，to=null 描述保持当前状态；不修改节点或执行命令。
 */
export function businessStateSummary(node: ViewNode, labels: Record<string, string>): string {
  if (node.kind !== 'command') return '';
  const owner = node.id.slice(0, node.id.lastIndexOf('.'));
  const name = (s: string) => (s === 'new' ? '新建' : (labels[`state:${owner}.${s}`] || s));
  const from = (Array.isArray(node.attrs.from) ? node.attrs.from : [node.attrs.from]) as string[];
  return `${from.filter(Boolean).map(name).join(' / ')} → ${node.attrs.to == null ? '保持当前状态' : name(String(node.attrs.to))}`;
}

/**
 * 把已知约束名翻译为业务提示，并解析职责分离字段。
 * @param name 内核约束标识。
 * @param owner 所属聚合 ID。
 * @param labels 字段中文标签。
 * @returns 展示文案，未知约束保留原名，不求值或授予能力。
 */
export function businessConstraintLabel(name: string, owner: string, labels: Record<string, string>): string {
  const field = (id: string) => labels[`field:${owner}.${id}`] ?? id;
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
