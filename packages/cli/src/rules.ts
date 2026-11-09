/**
 * 分析阶段的领域图规则集合，检查组织模型、状态可达性、资源配对及事件兼容。
 * 规则消费本体而不执行命令，生成带错误码的 Finding；提供旧基线时才检查跨版本事件载荷。
 * 静态资源标签、SQL 文本和状态图只是结构证据，实际事务、权限与 map 分支仍由运行时及业务测试验证。
 */
// 图规则：每条规则是一个函数，输入本体图，输出带错误码和修复方法的问题列表。
import type { Finding } from './findings.js';
import { checkBusinessProcesses } from './process-rules.js';
import type { OntEdge, OntNode, Ontology } from './ontology.js';

/**
 * 将已有节点源码位置转成诊断定位，缺少文件时返回 undefined，不虚构跨包路径。
 */
const at = (n?: OntNode) => (n?.file ? `${n.file}:${n.line ?? 1}` : undefined);

/**
 * 为当前本体建立 kind+id 节点索引及按边方向筛选器，避免同名类别混淆；不缓存跨次分析状态。
 */
function index(g: Ontology) {
  const byId = new Map(g.nodes.map((n) => [`${n.kind}:${n.id}`, n]));
  const get = (kind: string, id: string) => byId.get(`${kind}:${id}`);
  const out = (kind: OntEdge['kind'], from: string) =>
    g.edges.filter((e) => e.kind === kind && e.from === from);
  const into = (kind: OntEdge['kind'], to: string) => g.edges.filter((e) => e.kind === kind && e.to === to);
  return { get, out, into };
}

/** 状态 → 进入时获得的资源：命令迁移到 S、发出事件、事件触发标注了 acquires 的反应 */
/**
 * 沿迁移→事件→反应→命令的 acquires 标签归纳持有状态。
 * @param g 本体图。
 * @returns 状态、资源名和来源命令；只说明静态配对，不保证 map 每次执行。
 */
export function statesHoldingResources(g: Ontology): { state: string; resource: string; via: string }[] {
  const { out } = index(g);
  const held: { state: string; resource: string; via: string }[] = [];
  for (const t of g.edges.filter((e) => e.kind === 'transition')) {
    for (const ev of out('emits', t.via!)) {
      for (const tr of out('triggers', ev.to)) {
        for (const tg of out('targets', tr.to)) {
          if (tg.acquires && !held.some((h) => h.state === t.to && h.resource === tg.acquires))
            held.push({ state: t.to, resource: tg.acquires, via: t.via! });
        }
      }
    }
  }
  return held;
}

/**
 * 沿给定命令发出的事件查找直接反应 releases 标签；只认声明配对，不执行释放动作或递归证明任意程序。
 */
function releasesOnPath(g: Ontology, via: string, resource: string): boolean {
  const { out } = index(g);
  for (const ev of out('emits', via)) {
    for (const tr of out('triggers', ev.to)) {
      if (out('targets', tr.to).some((tg) => tg.releases === resource)) return true;
    }
  }
  return false;
}

/** CAGE-PAIR-002：进入某状态时获得了资源，从该状态出发的每一条迁移都必须释放它，或进入一个同样持有它的状态 */
/**
 * 检查离开持有状态的迁移是否声明释放，或进入同样持有资源的状态。
 * @param g 当前图。
 * @returns CAGE-PAIR-002 问题；标签一致不等于真实库存等业务动作已验证。
 */
export function checkPairing(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  const held = statesHoldingResources(g);
  const holds = (state: string, resource: string) =>
    held.some((h) => h.state === state && h.resource === resource);
  for (const h of held) {
    for (const t of g.edges.filter(
      (e) => e.kind === 'transition' && e.from === h.state && e.to !== h.state,
    )) {
      if (!releasesOnPath(g, t.via!, h.resource) && !holds(t.to, h.resource)) {
        findings.push({
          code: 'CAGE-PAIR-002',
          at: at(get('command', t.via!)),
          reason: `${t.via} 让单据离开 ${h.state}，但没有释放 ${h.resource}`,
          fix: `新增订阅 ${t.via} 所发事件的反应，并标注 releases: '${h.resource}'`,
        });
      }
    }
  }
  return findings;
}

/** CAGE-STATE-010：每个状态都能从初始状态到达；CAGE-STATE-011：非终态必须有出边 */
/**
 * 从新建或初始状态计算可达性，并检查非终态出边。
 * @param g 当前图。
 * @returns 状态规则问题；默认 active/deleted 生命周期按框架约定特别处理。
 */
export function checkStates(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  for (const a of g.nodes.filter((n) => n.kind === 'aggregate')) {
    const states = g.nodes.filter((n) => n.kind === 'state' && n.id.startsWith(`${a.id}.`));
    const trans = g.edges.filter((e) => e.kind === 'transition' && e.to.startsWith(`${a.id}.`));
    const reached = new Set<string>(trans.filter((t) => t.from === `${a.id}.[new]`).map((t) => t.to));
    if (reached.size === 0) {
      const init = states.find((s) => s.attrs.initial);
      if (init) reached.add(init.id);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of trans)
        if (reached.has(t.from) && !reached.has(t.to)) {
          reached.add(t.to);
          grew = true;
        }
    }
    const defaults = !!a.attrs.defaultStates;
    for (const s of states) {
      if (defaults && s.id.endsWith('.deleted')) continue; // 默认生命周期的 deleted 由框架提供
      if (!reached.has(s.id)) {
        findings.push({
          code: 'CAGE-STATE-010',
          at: at(a),
          reason: `状态 ${s.id} 从初始状态不可达`,
          fix: '增加一个迁移到它的命令，或从 states 里删掉它',
        });
      }
      const outs = trans.filter((t) => t.from === s.id);
      if (!s.attrs.terminal && outs.length === 0 && !defaults) {
        findings.push({
          code: 'CAGE-STATE-011',
          at: at(a),
          reason: `非终态 ${s.id} 没有任何出边，单据会卡在这里`,
          fix: '增加离开它的命令，或在 states 里把它标记为 terminal',
        });
      }
    }
  }
  void get;
  return findings;
}

/** CAGE-SENS-001：敏感字段不得原样进入事件载荷 */
/**
 * 检查事件同名载荷字段是否保留聚合敏感标记。
 * @param g 当前图。
 * @returns 可能进入 outbox 的敏感字段诊断；任意自定义映射仍须业务审查。
 */
export function checkSensitiveEvents(g: Ontology): Finding[] {
  const { get, out } = index(g);
  const findings: Finding[] = [];
  for (const c of g.nodes.filter((n) => n.kind === 'command')) {
    const agg = c.id.split('.')[0];
    const custom = new Set((c.attrs.customEmit as string[]) ?? []);
    for (const e of out('emits', c.id)) {
      const ev = get('event', e.to);
      if (!ev) continue;
      for (const [k, f] of Object.entries((ev.attrs.fields ?? {}) as Record<string, any>)) {
        const af = get('field', `${agg}.${k}`);
        if (af?.attrs.sensitive && !f.sensitive) {
          findings.push({
            code: 'CAGE-SENS-001',
            at: at(ev),
            reason: `事件 ${ev.id} 的载荷字段 ${k}${custom.has(ev.id) ? '（自定义映射）' : ''} 对应敏感字段 ${agg}.${k}，会原样进入 outbox 和下游系统`,
            fix: `在事件声明里把 ${k} 标成 .sensitive('${af.attrs.sensitive}')（载荷里自动掩码），或从载荷里去掉它`,
          });
        }
      }
    }
  }
  return findings;
}

/** CAGE-APPR-010：invokedBy 为 process 的命令必须有审批绑定或反应调用它，否则没有人能调用 */
/**
 * 检查仅流程/外部可调用的命令是否有声明调用入口。
 * @param g 当前图。
 * @returns 缺流程入口错误或缺外部入口警告；有入口不表示已授权。
 */
export function checkProcessCommands(g: Ontology): Finding[] {
  const { into } = index(g);
  const findings: Finding[] = [];
  for (const c of g.nodes.filter((n) => n.kind === 'command')) {
    const by = c.attrs.invokedBy as string[];
    const callers = [...into('binds', c.id), ...into('targets', c.id), ...into('calls', c.id)];
    if (by.includes('process') && !by.includes('user') && callers.length === 0) {
      findings.push({
        code: 'CAGE-APPR-010',
        at: at(c),
        reason: `命令 ${c.id} 只接受流程调用，但没有审批绑定或反应调用它`,
        fix: '用 approval(...) 把它绑定为 onApproved/onRejected，或让一个反应调用它；也可能是 invokedBy 写错了',
      });
    }
    if (by.includes('external') && !by.includes('user') && callers.length === 0) {
      findings.push({
        code: 'CAGE-CONN-012',
        at: at(c),
        reason: `命令 ${c.id} 只接受外部调用，但没有入站回调或出站映射调用它`,
        fix: '用 inbound(...) 或 outbound(..., { onSuccess }) 调用它',
        severity: 'warning',
      });
    }
  }
  return findings;
}

/** CAGE-QUERY-003：手写 SQL 只能引用 reads 里聚合的安全视图 */
/**
 * 从 SQL 文本检查 safe 视图与 reads 对应关系及显式基表引用。
 * @param g 当前图。
 * @returns 文本可识别的读取问题；不是完整 SQL 解析器，运行时只读账号仍是边界。
 */
export function checkQueries(g: Ontology): Finding[] {
  const { get } = index(g);
  const findings: Finding[] = [];
  for (const q of g.nodes.filter((n) => n.kind === 'query')) {
    const text = q.attrs.sqlText as string | null;
    if (!text) continue;
    const allowed = new Set(
      ((q.attrs.reads as string[]) ?? []).map(
        (a) => String(get('aggregate', a)?.attrs.table ?? '').split('.')[1],
      ),
    );
    for (const m of text.matchAll(/\bsafe\.("?)([a-z_][a-z0-9_]*)\1/gi)) {
      if (!allowed.has(m[2])) {
        findings.push({
          code: 'CAGE-QUERY-003',
          at: at(q),
          reason: `查询 ${q.id} 引用了 safe.${m[2]}，但 reads 里没有声明对应的聚合`,
          fix: `在 reads 里加上 safe.${m[2]} 对应的聚合，影响分析才能找到这个查询`,
        });
      }
    }
    if (
      /\b(from|join)\s+(?!safe\.|\(|lateral\b|unnest\b|generate_series\b|jsonb_|json_)("?[a-z_][a-z0-9_]*"?)\s*(\.|\b)/i.test(
        text.replace(/--.*$/gm, ''),
      )
    ) {
      const m =
        /\b(from|join)\s+(?!safe\.|\(|lateral\b|unnest\b|generate_series\b|jsonb_|json_)("?[a-z_][a-z0-9_.]*"?)/i.exec(
          text,
        );
      if (m && m[2].includes('.'))
        findings.push({
          code: 'CAGE-QUERY-003',
          at: at(q),
          reason: `查询 ${q.id} 引用了 ${m[2]}，只允许引用 safe.* 安全视图`,
          fix: '改为查询对应的安全视图',
        });
    }
  }
  return findings;
}

/** CAGE-ORG-001：domain 必须包含框架自带的组织模型 */
/**
 * 确认 domain 注册了 User、Dept、Role 三个框架组织聚合。
 * @param g 当前图。
 * @returns 缺少时单条 CAGE-ORG-001，否则空数组；不初始化组织数据。
 */
export function checkOrg(g: Ontology): Finding[] {
  const has = (id: string) => g.nodes.some((n) => n.kind === 'aggregate' && n.id === id);
  return has('User') && has('Dept') && has('Role')
    ? []
    : [
        {
          code: 'CAGE-ORG-001',
          reason: 'domain 没有导出组织模型（User、Dept、Role）',
          fix: "在 domain 的 index.ts 里加上 export * from '@yss123/cage-admin/domain'",
        },
      ];
}

/** CAGE-EVENT-002：事件载荷只允许向后兼容的变更（只能新增可选字段） */
/**
 * 比较同名事件字段的删除、类型改变及新增必填项。
 * @param base 旧本体，代表可能仍有在途事件的声明。
 * @param head 新本体。
 * @returns 可识别的载荷兼容问题，不改写已入 outbox 的事件。
 */
export function checkEventCompat(base: Ontology, head: Ontology): Finding[] {
  const findings: Finding[] = [];
  const b = new Map(base.nodes.filter((n) => n.kind === 'event').map((n) => [n.id, n]));
  for (const ev of head.nodes.filter((n) => n.kind === 'event')) {
    const old = b.get(ev.id);
    if (!old) continue;
    const of = (old.attrs.fields ?? {}) as Record<string, any>;
    const nf = (ev.attrs.fields ?? {}) as Record<string, any>;
    for (const [k, f] of Object.entries(of)) {
      if (!(k in nf))
        findings.push({
          code: 'CAGE-EVENT-002',
          at: at(ev),
          reason: `事件 ${ev.id} 删除了载荷字段 ${k}，下游消费者会出错`,
          fix: '保留旧字段（标注废弃），新增字段承载新含义；或新建一个事件',
        });
      else if (nf[k].kind !== f.kind) {
        findings.push({
          code: 'CAGE-EVENT-002',
          at: at(ev),
          reason: `事件 ${ev.id} 的字段 ${k} 类型从 ${f.kind} 变成了 ${nf[k].kind}`,
          fix: '新增一个字段承载新类型，旧字段保留',
        });
      }
    }
    for (const [k, f] of Object.entries(nf)) {
      if (!(k in of) && !f.optional)
        findings.push({
          code: 'CAGE-EVENT-002',
          at: at(ev),
          reason: `事件 ${ev.id} 新增了必填字段 ${k}，已在 outbox 里的旧事件没有它`,
          fix: `把 ${k} 声明为 .optional()`,
        });
    }
  }
  return findings;
}

/**
 * 汇总当前结构规则，存在基线时再加入事件兼容检查。
 * @param g 当前本体。
 * @param base 可选旧本体。
 * @returns 按规则顺序拼接的发现，不修改图或尝试自动修复。
 */
export function runRules(g: Ontology, base?: Ontology | null): Finding[] {
  return [
    ...checkBusinessProcesses(g),
    ...checkOrg(g),
    ...checkStates(g),
    ...checkPairing(g),
    ...checkSensitiveEvents(g),
    ...checkProcessCommands(g),
    ...checkQueries(g),
    ...(base ? checkEventCompat(base, g) : []),
  ];
}
