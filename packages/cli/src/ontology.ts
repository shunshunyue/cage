/**
 * 把运行时注册表和静态声明位置抽取成可序列化本体，并提供节点差异计算。
 * 聚合、字段、命令、事件、协作与业务流程生成节点和显式关系，源码及结构哈希用于影响判断。
 * 不执行 handler、查询或外部调用；JSON Schema 与函数文本只能表达当前可抽取事实，不能证明任意程序语义等价。
 */
// 抽取器：把声明变成一张本体图（节点 + 边），写到 .cage/ontology.json。规则检查、影响分析、测试生成都读这张图。
import { createHash } from 'node:crypto';
import { brandOf, isRelation, snake, stableStringify, type AnyAggregate, type BusinessAction, type Fields, type Registry } from '@yss123/cage-kernel';
import { z } from 'zod';
import type { DeclSite } from './static-check.js';
import { approvalRouteSteps } from './approval-tree.js';

/**
 * 本体节点语义类别，区分聚合、行为、字段、协作和业务阅读规格，身份须与 id 联合使用。
 */
export type NodeKind =
  | 'aggregate'
  | 'field'
  | 'state'
  | 'command'
  | 'event'
  | 'reaction'
  | 'query'
  | 'approval'
  | 'route'
  | 'job'
  | 'connector'
  | 'outbound'
  | 'inbound'
  | 'capability'
  | 'process'
  | 'stage';

/**
 * 可序列化节点，attrs 保存抽取事实，hash 表示当前可抽取内容而非运行状态。
 */
export interface OntNode {
  /** 领域声明类别，和 id 一起确定节点身份。 */
  kind: NodeKind;
  /** 领域原始标识，字段/状态通常带聚合前缀。 */
  id: string;
  /** 内容哈希：声明变化时哈希变化 */
  hash: string;
  /** 已定位声明的项目相对源码路径；库内声明可缺失。 */
  file?: string;
  /** 源码 1 起始行号，缺失表示尚无定位证据。 */
  line?: number;
  /** 可序列化的声明语义属性，不是运行时实体记录。 */
  attrs: Record<string, unknown>;
}

/**
 * 显式本体关系类型；读取、触发、状态迁移和阅读规格分别保留，不能混当执行先后。
 */
export type EdgeKind =
  | 'transition'
  | 'reads'
  | 'emits'
  | 'uses'
  | 'triggers'
  | 'cancels'
  | 'targets'
  | 'queries'
  | 'refs'
  | 'calls'
  | 'binds'
  | 'field'
  | 'contains'
  | 'implements'
  | 'follows'
  | 'relates';

/**
 * 节点关系的存储形式，端点通常为业务 ID，规格边可补 kind 消除同名歧义。
 */
export interface OntEdge {
  /** 关系种类，决定端点解释及影响传播方向。 */
  kind: EdgeKind;
  /** 原始源节点 ID，尚未附加种类前缀。 */
  from: string;
  /** 原始目标节点 ID。 */
  to: string;
  /** 状态迁移对应命令等中间声明标识。 */
  via?: string;
  /** reads/queries 等依赖在声明中的本地别名。 */
  alias?: string;
  /** 命令声明的资源获取标签，只用于静态配对。 */
  acquires?: string;
  /** 命令声明的资源释放标签，不会代替命令执行。 */
  releases?: string;
  /** uses 边的来源说明：约束、事件载荷、路由条件、出站映射、查询 */
  as?: string;
  /** 字段引用关系的基数，区分外键、反查和自动中间表。 */
  cardinality?: 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';
  /** 一对多反向引用的目标外键字段名。 */
  mappedBy?: string;
  /** 新的业务规格边显式保留端点类型，避免同名事件和命令混淆。 */
  fromKind?: NodeKind;
  /** 目标节点显式种类，消除同名声明歧义。 */
  toKind?: NodeKind;
  /** 流程阶段连线的人工作用、自动执行或等待语义。 */
  mode?: 'manual' | 'automatic' | 'wait';
  /** 显式业务连线标题，未声明时由解释层生成。 */
  label?: string;
  /** 次要分支标记，影响阅读和布局，不改变执行权限。 */
  branch?: boolean;
}

/**
 * 版本化本体文件形状，是分析与生成共享的静态快照，不含业务数据库记录。
 */
export interface Ontology {
  /** 当前本体 JSON 结构版本，固定为 1。 */
  version: 1;
  /** 抽取的语义节点，包含依赖声明与字段等细分事实。 */
  nodes: OntNode[];
  /** 节点之间可抽取的显式依赖与流程关系。 */
  edges: OntEdge[];
  /** 静态扫描发现的 unsafe 使用数，用于预算与影响提示。 */
  unsafeCount: number;
}

/**
 * 对稳定序列化值计算 SHA-256 并取前 12 位，作为本体节点语义变化标记，不用于密码或安全认证。
 */
const h = (v: unknown) => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 12);

/**
 * 尽量把输入 schema 转成 JSON Schema，无法表达时返回 null；不会执行校验函数。
 */
function jsonSchema(s: z.ZodType): unknown {
  try {
    return z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' });
  } catch {
    return null;
  }
}

/**
 * 抽取字段存储、可空、敏感、关系及文件限制，保留简化的列表结构供图规则和生成使用。
 */
function fieldAttrs(f: any) {
  return {
    kind: f.kind,
    sql: f.sql,
    optional: f.isOptional,
    sensitive: f.sensitiveKind ?? null,
    ref: f.ref ?? null,
    unique: !!f.isUnique,
    hidden: !!f.isHidden,
    ...(isRelation(f) ? { virtual: true, mappedBy: f.mappedBy ?? null, readOnly: f.kind === 'hasMany' } : {}),
    description: f.description ?? null,
    values: f.values ?? null,
    ...(f.filePolicy ? { filePolicy: f.filePolicy } : {}),
    shape: f.shape
      ? Object.fromEntries(
          Object.entries(f.shape).map(([k, sf]: [string, any]) => [
            k,
            { kind: sf.kind, optional: sf.isOptional },
          ]),
        )
      : null,
  };
}

/**
 * 从已构建注册表和源码位置生成本体节点与关系。
 * @param reg 已校验注册表。
 * @param sites 顶层声明位置及调用文本，依赖包可以没有位置。
 * @param unsafeCount 静态扫描的逃生口数量，默认零。
 * @returns version=1 本体；函数只读声明，不执行命令、查询或连接器。
 */
export function extract(reg: Registry, sites: DeclSite[] = [], unsafeCount = 0): Ontology {
  const nodes: OntNode[] = [];
  const edges: OntEdge[] = [];
  const siteOf = new Map(sites.map((s) => [s.exportName, s]));
  const where = (v: object) => {
    const n = reg.nameOf(v);
    const s = n ? siteOf.get(n) : undefined;
    return s ? { file: s.file, line: s.line } : {};
  };
  const textHash = (v: object) => {
    const n = reg.nameOf(v);
    const s = n ? siteOf.get(n) : undefined;
    // Git 的 autocrlf 会改变检出文件的换行。源码哈希统一换行，避免没有业务改动
    // 却把整张命令图都报成变化；字符串字面量的转义内容仍保留原样。
    return s ? h(s.text.replace(/\r\n/g, '\n')) : null;
  };
  const push = (
    kind: NodeKind,
    id: string,
    attrs: Record<string, unknown>,
    at: { file?: string; line?: number } = {},
  ) => nodes.push({ kind, id, hash: h({ kind, id, attrs }), ...at, attrs });

  const aggOfField = new Map<string, AnyAggregate>();
  for (const a of reg.aggregates) {
    push(
      'aggregate',
      a.name,
      {
        table: `${a.table.schema}.${a.table.name}`,
        scope: { dept: a.scope.deptField ?? null, owner: a.scope.ownerField ?? null },
        invariants: Object.keys(a.invariants),
        invariantSrc: Object.fromEntries(Object.entries(a.invariants).map(([k, fn]) => [k, h(String(fn))])),
        description: a.description ?? null,
        defaultStates: a.states.values.join() === 'active,deleted',
      },
      where(a),
    );
    for (const [k, f] of Object.entries(a.fields as Fields)) {
      push('field', `${a.name}.${k}`, { ...fieldAttrs(f),
        ...(f.kind === 'manyToMany' ? { through: `${a.table.schema}.${a.table.name}__${snake(k)}` } : {}),
      });
      edges.push({ kind: 'field', from: a.name, to: `${a.name}.${k}` });
      aggOfField.set(`${a.name}.${k}`, a);
      if (f.ref) edges.push({ kind: 'refs', from: `${a.name}.${k}`, to: f.ref,
        cardinality: f.kind === 'hasMany' ? 'one-to-many' : f.kind === 'manyToMany' ? 'many-to-many' : f.isUnique ? 'one-to-one' : 'many-to-one',
        ...(f.mappedBy ? { mappedBy: f.mappedBy } : {}),
      });
    }
    for (const s of a.states.values) {
      push('state', `${a.name}.${s}`, {
        terminal: a.states.terminal.includes(s),
        initial: a.states.initial === s,
      });
    }
    push('capability', `${a.name}.read`, { kind: 'read' });
    push('capability', `${a.name}.export`, { kind: 'export' });
  }

  for (const e of reg.events) {
    push(
      'event',
      e.name,
      { fields: Object.fromEntries(Object.entries(e.fields as Fields).map(([k, f]) => [k, fieldAttrs(f)])) },
      where(e),
    );
  }

  for (const c of reg.commands) {
    const { cmd, capability } = c;
    const agg = cmd.agg.name;
    push(
      'command',
      capability,
      {
        from: cmd.from,
        to: cmd.to,
        invokedBy: cmd.invokedBy,
        input: jsonSchema(cmd.input),
        reads: Object.fromEntries(Object.entries(cmd.reads).map(([k, a]) => [k, a.name])),
        emits: cmd.emits.map((e) => e.event.name),
        customEmit: cmd.emits.filter((e) => e.map).map((e) => e.event.name),
        constraints: cmd.constraints.map((k) => k.name),
        src: textHash(cmd) ?? h(String(cmd.handler)),
        domainCodes: sites.find((s) => s.exportName === c.exportName)?.domainCodes ?? [],
        public: cmd.public,
      },
      where(cmd),
    );
    const froms = cmd.from === 'new' ? ['[new]'] : (cmd.from as string[]);
    for (const f of froms) {
      edges.push({
        kind: 'transition',
        from: f === '[new]' ? `${agg}.[new]` : `${agg}.${f}`,
        // to: null 是各允许起始状态上的自环，不能生成名为 null 的虚假状态。
        to: `${agg}.${cmd.to ?? f}`,
        via: capability,
      });
    }
    for (const [alias, a] of Object.entries(cmd.reads))
      edges.push({ kind: 'reads', from: capability, to: a.name, alias });
    for (const spec of cmd.emits) {
      edges.push({ kind: 'emits', from: capability, to: spec.event.name });
      // 事件载荷用到了聚合的哪些字段（默认映射按同名字段）
      if (!spec.map) {
        for (const k of Object.keys(spec.event.fields)) {
          if (k in cmd.agg.fields)
            edges.push({ kind: 'uses', from: spec.event.name, to: `${agg}.${k}`, as: '事件载荷' });
        }
      }
    }
    for (const k of cmd.constraints) {
      for (const f of k.fields ?? [])
        edges.push({ kind: 'uses', from: capability, to: `${agg}.${f}`, as: `约束 ${k.name}` });
    }
  }

  for (const { r, name } of reg.reactions) {
    push(
      'reaction',
      name,
      {
        tx: r.tx,
        order: (r as any).order ?? null,
        collection: (r as any).collection ?? null,
        acquires: r.acquires ?? null,
        releases: r.releases ?? null,
        event: r.event.name,
        command: reg.capabilityOf(r.command),
        src: h((r as any).collection ? sites.find(s => s.exportName === name)?.text ?? String(r.map) : String(r.map)),
      },
      where(r),
    );
    edges.push({ kind: 'triggers', from: r.event.name, to: name });
    edges.push({
      kind: 'targets',
      from: name,
      to: reg.capabilityOf(r.command),
      acquires: r.acquires,
      releases: r.releases,
    });
  }

  for (const q of reg.queries) {
    push(
      'query',
      q.name,
      {
        reads: q.reads.map((a) => a.name),
        sql: q.sql ? h(q.sql) : null,
        build: q.build ? h(String(q.build)) : null,
        input: jsonSchema(q.input),
        sqlText: q.sql ?? null,
      },
      where(q),
    );
    for (const a of q.reads) {
      edges.push({ kind: 'queries', from: q.name, to: a.name });
      const text = (q.sql ?? String(q.build ?? '')).toLowerCase();
      for (const k of Object.keys(a.fields)) {
        if (new RegExp(`\\b(${snake(k)}|${k.toLowerCase()})\\b`).test(text))
          edges.push({ kind: 'uses', from: q.name, to: `${a.name}.${k}`, as: '查询' });
      }
    }
  }

  for (const { a, name } of reg.approvals) {
    push(
      'approval',
      name,
      {
        process: a.process,
        aggregate: a.agg.name,
        start: a.start.name,
        routable: a.routable,
        onApproved: reg.capabilityOf(a.onApproved),
        onRejected: reg.capabilityOf(a.onRejected),
        ...(a.onReturned ? { onReturned: reg.capabilityOf(a.onReturned) } : {}),
        ...(a.automatedBy ? { automatedBy: a.automatedBy } : {}),
        cancelOn: a.cancelOn.map((e) => e.name),
      },
      where(a),
    );
    edges.push({ kind: 'triggers', from: a.start.name, to: name });
    // cancelOn 原本只留在属性中，沿图查取消逻辑时会漏掉审批。把声明中的事件
    // 也抽成关系，明确它负责取消流程，不能与 start 混成“启动审批”。
    for (const event of a.cancelOn) edges.push({ kind: 'cancels', from: event.name, to: name });
    edges.push({ kind: 'binds', from: name, to: reg.capabilityOf(a.onApproved) });
    edges.push({ kind: 'binds', from: name, to: reg.capabilityOf(a.onRejected) });
    if (a.onReturned) edges.push({ kind: 'binds', from: name, to: reg.capabilityOf(a.onReturned) });
    for (const f of a.routable)
      edges.push({ kind: 'uses', from: name, to: `${a.agg.name}.${f}`, as: '可路由字段' });
  }

  for (const j of reg.jobs) {
    push(
      'job',
      j.name,
      {
        cron: j.cron,
        reads: j.reads.map((a) => a.name),
        calls: j.calls.map((c) => reg.capabilityOf(c)),
        src: h(String(j.run)),
      },
      where(j),
    );
    for (const a of j.reads) edges.push({ kind: 'queries', from: j.name, to: a.name });
    for (const c of j.calls) edges.push({ kind: 'calls', from: j.name, to: reg.capabilityOf(c) });
  }

  for (const e of reg.extensions) {
    const v = e.value;
    if (e.kind === 'ROUTE') {
      const binding = reg.approvalByProcess(v.process);
      push(
        'route',
        `route:${v.process}`,
        { process: v.process, nodes: v.nodes, ...(v.reminders ? { reminders: v.reminders } : {}) },
        { ...(siteOf.get(e.name) ? { file: siteOf.get(e.name)!.file, line: siteOf.get(e.name)!.line } : {}) },
      );
      if (binding) {
        edges.push({ kind: 'binds', from: `route:${v.process}`, to: binding.name });
        // 条件和并行可嵌套，取证依赖必须完整遍历叶节点；不能只展开第一层而漏掉分支中的 AI。
        for (const step of approvalRouteSteps(v.nodes).filter(node => node.kind === 'ai')) {
          for (const field of step.context?.fields ?? []) edges.push({ kind: 'uses', from: `route:${v.process}`, to: `${binding.a.agg.name}.${field}`, as: 'AI 上下文' });
          for (const query of step.context?.queries ?? []) edges.push({ kind: 'queries', from: `route:${v.process}`, to: query });
        }
        for (const f of v.fieldsUsed as string[])
          edges.push({
            kind: 'uses',
            from: `route:${v.process}`,
            to: `${binding.a.agg.name}.${f}`,
            // 催办申请人同样来自 routable，但它决定实例操作归属，不是审批分支或审批人。
            as: v.reminders?.requesterField === f ? '催办申请人' : '路由条件',
          });
      }
    } else if (e.kind === 'CONNECTOR') {
      push(
        'connector',
        `connector:${v.name}`,
        {
          hosts: v.hosts,
          secret: v.secret ?? null,
          operations: Object.fromEntries(
            Object.entries(v.operations).map(([k, o]: [string, any]) => [
              k,
              {
                effect: o.effect,
                method: o.method,
                path: o.path,
                request: jsonSchema(o.request),
                response: jsonSchema(o.response),
              },
            ]),
          ),
        },
        siteOf.get(e.name) ? { file: siteOf.get(e.name)!.file, line: siteOf.get(e.name)!.line } : {},
      );
    } else if (e.kind === 'OUTBOUND') {
      const id = e.name;
      push(
        'outbound',
        id,
        {
          event: v.event.name,
          connector: v.op.connector.name,
          operation: v.op.name,
          onSuccess: v.onSuccess ? reg.capabilityOf(v.onSuccess.command) : null,
          src: h(String(v.map)),
        },
        siteOf.get(e.name) ? { file: siteOf.get(e.name)!.file, line: siteOf.get(e.name)!.line } : {},
      );
      edges.push({ kind: 'triggers', from: v.event.name, to: id });
      edges.push({ kind: 'targets', from: id, to: `connector:${v.op.connector.name}` });
      if (v.onSuccess) edges.push({ kind: 'targets', from: id, to: reg.capabilityOf(v.onSuccess.command) });
      // 出站映射用到的事件字段 → 这些字段在聚合里的同名字段
      const emitters = reg.commands.filter((c) => c.cmd.emits.some((s) => s.event === v.event));
      for (const f of (v.fields as string[]) ?? []) {
        for (const c of emitters)
          if (f in c.cmd.agg.fields)
            edges.push({ kind: 'uses', from: id, to: `${c.cmd.agg.name}.${f}`, as: '出站映射' });
      }
    } else if (e.kind === 'INBOUND') {
      const id = e.name;
      push(
        'inbound',
        id,
        {
          connector: v.connector.name,
          event: v.event,
          command: reg.capabilityOf(v.command),
          payload: jsonSchema(v.payload),
        },
        siteOf.get(e.name) ? { file: siteOf.get(e.name)!.file, line: siteOf.get(e.name)!.line } : {},
      );
      edges.push({ kind: 'targets', from: id, to: reg.capabilityOf(v.command) });
    }
  }

  // 业务阶段引用真实声明。流程规格关系与实际调用关系使用不同边类型，
  // 静态检查及 UI 都不能把“下一步”当作 worker 会自动执行的证据。
  const actionRef = (action: BusinessAction): { kind: NodeKind; id: string } => {
    const kind = brandOf(action)!;
    const named = action as { name?: string };
    if (kind === 'COMMAND') return { kind: 'command', id: reg.capabilityOf(action as Parameters<Registry['capabilityOf']>[0]) };
    return {
      kind: kind.toLowerCase() as NodeKind,
      id: ['EVENT', 'QUERY', 'JOB', 'REACTION'].includes(kind) ? named.name ?? reg.nameOf(action)! : reg.nameOf(action)!,
    };
  };
  for (const process of reg.businessProcesses) {
    push('process', process.name, {
      title: process.title, description: process.description, area: process.area,
      subject: process.subject.name, entry: `${process.name}.${process.entry}`, transitions: process.transitions,
    }, where(process));
    edges.push({ kind: 'relates', from: process.name, to: process.subject.name, fromKind: 'process', toKind: 'aggregate', label: '主业务对象' });
    for (const [id, stage] of Object.entries(process.stages)) {
      const stageId = `${process.name}.${id}`;
      const primary = actionRef(stage.action);
      push('stage', stageId, {
        process: process.name, title: stage.title, description: stage.description,
        actor: stage.actor ?? null, stageKind: stage.kind ?? 'action', primary: `${primary.kind}:${primary.id}`,
        details: (stage.details ?? []).map(ref => { const n = actionRef(ref); return `${n.kind}:${n.id}`; }),
        related: (stage.related ?? []).map(r => { const via = actionRef(r.via); return { object: r.object.name, label: r.label, via: `${via.kind}:${via.id}` }; }),
      }, where(process));
      edges.push({ kind: 'contains', from: process.name, to: stageId, fromKind: 'process', toKind: 'stage' });
      for (const ref of new Set([stage.action, ...(stage.details ?? [])])) {
        const target = actionRef(ref);
        edges.push({ kind: 'implements', from: stageId, to: target.id, fromKind: 'stage', toKind: target.kind });
      }
      for (const related of stage.related ?? []) {
        const via = actionRef(related.via);
        edges.push({ kind: 'relates', from: stageId, to: related.object.name, fromKind: 'stage', toKind: 'aggregate',
          label: related.label, via: `${via.kind}:${via.id}` });
      }
    }
    for (const transition of process.transitions) edges.push({
      kind: 'follows', from: `${process.name}.${transition.from}`, to: `${process.name}.${transition.to}`,
      fromKind: 'stage', toKind: 'stage', mode: transition.mode, label: transition.label, branch: transition.branch ?? false,
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
  return { version: 1, nodes, edges, unsafeCount };
}

/**
 * 按 kind+id 比较后的新增、删除和内容哈希变化，边变化通过相关节点属性体现。
 */
export interface NodeDiff {
  /** 当前图新出现的节点。 */
  added: OntNode[];
  /** 基线有而当前没有的节点。 */
  removed: OntNode[];
  /** 同一身份内容哈希变化的前后节点对。 */
  changed: { before: OntNode; after: OntNode }[];
}

/**
 * 比较两份本体节点稳定身份与内容哈希。
 * @param base 修改前图。
 * @param head 当前图。
 * @returns 新增、删除和 before/after 变化对，不修改输入，不单独比较边数组。
 */
export function diffOntology(base: Ontology, head: Ontology): NodeDiff {
  const key = (n: OntNode) => `${n.kind}:${n.id}`;
  const b = new Map(base.nodes.map((n) => [key(n), n]));
  const hd = new Map(head.nodes.map((n) => [key(n), n]));
  const out: NodeDiff = { added: [], removed: [], changed: [] };
  for (const [k, n] of hd) {
    const old = b.get(k);
    if (!old) out.added.push(n);
    else if (old.hash !== n.hash) out.changed.push({ before: old, after: n });
  }
  for (const [k, n] of b) if (!hd.has(k)) out.removed.push(n);
  return out;
}

/**
 * 按原始 ID 建立节点 Map；同名 ID 会由后出现节点覆盖，调用方须确认身份无歧义，公开查询使用完整 key。
 */
export const nodeById = (g: Ontology) => new Map(g.nodes.map((n) => [n.id, n]));
