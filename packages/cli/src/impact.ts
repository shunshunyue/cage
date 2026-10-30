// 影响分析：在基线和当前各生成一张图，找出变化的节点，再沿着边向外扩散。
// handler 文件的改动会被映射到它所属的命令节点，所以只改实现、不改声明也能算出影响。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { DerivedTest } from './derive.js';
import { checkEventCompat } from './rules.js';
import { diffOntology, type NodeDiff, type OntNode, type Ontology } from './ontology.js';
import type { Finding } from './findings.js';

export interface ImpactResult {
  diff: NodeDiff;
  start: string[];
  affected: string[];
  /** 受影响节点 → 通过哪条边、以什么身份受影响 */
  reasons: Map<string, string>;
  tests: DerivedTest[];
  projectTests: string[];
  confirm: string[];
  unsafe: { base: number; head: number };
  findings: Finding[];
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

export function changedFiles(root: string, base: string): string[] {
  const out = new Set<string>();
  const add = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => out.add(x));
  try {
    add(git(root, ['diff', '--relative', '--name-only', `${base}...HEAD`]));
  } catch {
    /* 基线不存在 */
  }
  try {
    add(git(root, ['diff', '--relative', '--name-only']));
    add(git(root, ['diff', '--relative', '--name-only', '--cached']));
    add(git(root, ['ls-files', '--others', '--exclude-standard']));
  } catch {
    /* 非 git */
  }
  return [...out];
}

export function readOntology(path: string): Ontology {
  return JSON.parse(readFileSync(path, 'utf8')) as Ontology;
}

const LABEL: Record<string, string> = {
  command: '命令',
  event: '事件',
  reaction: '反应',
  query: '查询',
  approval: '审批绑定',
  route: '路由',
  outbound: '外部',
  inbound: '入站',
  job: '任务',
  aggregate: '聚合',
  field: '字段',
  state: '状态',
  connector: '连接器',
  capability: '能力点',
};

export function impact(
  base: Ontology,
  head: Ontology,
  files: string[],
  tests: DerivedTest[] = [],
  projectTestFiles: string[] = [],
): ImpactResult {
  const diff = diffOntology(base, head);
  const start = new Set<string>(
    [...diff.added, ...diff.removed, ...diff.changed.map((c) => c.after)].map((n) => n.id),
  );
  // handler 文件改动映射到它所属的命令（以及文件里的其他声明）
  const norm = (p: string) => p.replace(/\\/g, '/');
  for (const n of head.nodes) if (n.file && files.map(norm).includes(norm(n.file))) start.add(n.id);
  const reasons = new Map<string, string>();
  for (const id of start) reasons.set(id, '直接变化');
  const affected = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const n = queue.shift()!;
    // 删除节点时关系已从 head 消失；同时遍历旧图才能找到旧字段的消费者。
    for (const e of [...base.edges, ...head.edges]) {
      let next: string | null = null;
      let why = '';
      if (e.kind === 'reads' && e.to === n) {
        next = e.from;
        why = `读依赖 ${n}`;
      } else if (e.kind === 'queries' && e.to === n) {
        next = e.from;
        why = `读取 ${n}`;
      } else if (e.kind === 'uses' && e.to === n) {
        next = e.from;
        why = `${e.as ?? '使用'}用到 ${n}`;
      } else if (e.kind === 'emits' && e.from === n) {
        next = e.to;
        why = `由 ${n} 发出`;
      } else if (e.kind === 'triggers' && e.from === n) {
        next = e.to;
        why = `订阅 ${n}`;
      } else if (e.kind === 'targets' && e.from === n) {
        next = e.to;
        why = `被 ${n} 调用`;
      } else if (e.kind === 'binds' && e.to === n) {
        next = e.from;
        why = `结论落到 ${n}`;
      } else if (e.kind === 'binds' && e.from === n) {
        next = e.to;
        why = `由 ${n} 调用`;
      } else if (e.kind === 'field' && e.from === n && diff.changed.some((c) => c.after.id === n)) {
        /* 聚合变化不扩散到每个字段 */
      }
      if (next && !affected.has(next)) {
        affected.add(next);
        reasons.set(next, why);
        queue.push(next);
      }
    }
  }
  const pick = tests.filter((t) => affected.has(t.subject) || affected.has(t.subject.split('.')[0]));
  const names = [...affected].map((id) => id.split('.').pop()!);
  const projectTests = projectTestFiles.filter((f) => {
    try {
      const text = readFileSync(f, 'utf8');
      return names.some((n) => n.length > 2 && text.includes(n));
    } catch {
      return false;
    }
  });

  // 需要人工确认的点
  const confirm: string[] = [];
  const headById = new Map(head.nodes.map((n) => [n.id, n]));
  for (const c of diff.changed) {
    if (c.after.kind === 'field') {
      const ceilings = head.edges.filter(
        (e) => e.kind === 'uses' && e.to === c.after.id && String(e.as).includes('ceiling'),
      );
      if (ceilings.length) confirm.push(`角色上的审批额度参数是否按 ${c.after.id} 的新口径调整`);
      if (c.before.attrs.description !== c.after.attrs.description)
        confirm.push(`${c.after.id} 的口径说明变了：下游报表、外部系统是否同步`);
    }
  }
  for (const n of diff.added) {
    if (n.kind === 'command') confirm.push(`新能力点 ${n.id} 默认无人拥有，需要管理员在 /admin 授权`);
  }
  for (const n of [...affected].map((id) => headById.get(id)).filter((x): x is OntNode => !!x)) {
    if (n.kind === 'outbound' && !start.has(n.id)) confirm.push(`外部同步 ${n.id} 受影响：对方系统是否兼容`);
  }
  return {
    diff,
    start: [...start],
    affected: [...affected],
    reasons,
    tests: pick,
    projectTests,
    confirm: [...new Set(confirm)],
    unsafe: { base: base.unsafeCount ?? 0, head: head.unsafeCount ?? 0 },
    findings: checkEventCompat(base, head),
  };
}

function describeNode(n: OntNode): string {
  if (n.kind === 'command') {
    const from = n.attrs.from === 'new' ? '新建' : (n.attrs.from as string[]).join('/');
    return `${LABEL.command} ${n.id}（${from} → ${n.attrs.to ?? '保持当前状态'}）`;
  }
  if (n.kind === 'reaction')
    return `${LABEL.reaction} ${n.id}${n.attrs.acquires ? `（acquires: ${n.attrs.acquires}）` : ''}${n.attrs.releases ? `（releases: ${n.attrs.releases}）` : ''}`;
  return `${LABEL[n.kind] ?? n.kind} ${n.id}`;
}

export function formatImpact(
  r: ImpactResult,
  head: Ontology,
  opts: { base: string; format: 'text' | 'md'; title?: string; gates?: string },
): string {
  const byId = new Map(head.nodes.map((n) => [n.id, n]));
  const md = opts.format === 'md';
  const L: string[] = [];
  const h = (s: string) => (md ? `**${s}**` : s);
  L.push(md ? `### cage 摘要${opts.title ? ` · ${opts.title}` : ''}` : `cage impact（相对 ${opts.base}）`);
  if (opts.gates) L.push(`${h('门禁：')}${opts.gates}`);
  const changes = [
    ...r.diff.added
      .filter((n) => n.kind !== 'state' && n.kind !== 'capability')
      .map((n) => `+ ${describeNode(n)}`),
    ...r.diff.removed
      .filter((n) => n.kind !== 'state' && n.kind !== 'capability')
      .map((n) => `- ${describeNode(n)}`),
    ...r.diff.changed.map(({ before, after }) => {
      const what =
        after.kind === 'field' && before.attrs.description !== after.attrs.description
          ? '口径说明被修改'
          : '声明被修改';
      return `~ ${describeNode(after)}（${what}）`;
    }),
    ...r.start
      .filter(
        (id) =>
          !r.diff.added.some((n) => n.id === id) &&
          !r.diff.removed.some((n) => n.id === id) &&
          !r.diff.changed.some((c) => c.after.id === id),
      )
      .map((id) => `~ ${byId.get(id) ? describeNode(byId.get(id)!) : id}（实现被修改）`),
  ];
  L.push(h('变化：'));
  L.push(...(changes.length ? changes.map((c) => `  ${c}`) : ['  无']));
  const affected = r.affected
    .filter((id) => !r.start.includes(id))
    .map((id) => byId.get(id))
    .filter((n): n is OntNode => !!n && n.kind !== 'state' && n.kind !== 'field');
  L.push(h('受影响：'));
  L.push(
    ...(affected.length
      ? affected.map(
          (n) => `  - ${(LABEL[n.kind] ?? n.kind).padEnd(4, '　')} ${n.id}（${r.reasons.get(n.id)}）`,
        )
      : ['  无']),
  );
  L.push(`${h('必须运行的测试：')}派生测试 ${r.tests.length} 个，项目测试 ${r.projectTests.length} 个`);
  L.push(
    `${h('unsafe：')}${r.unsafe.head}（${r.unsafe.head === r.unsafe.base ? '与基线持平' : r.unsafe.head > r.unsafe.base ? `比基线多 ${r.unsafe.head - r.unsafe.base}` : `比基线少 ${r.unsafe.base - r.unsafe.head}`}）`,
  );
  if (r.findings.length) {
    L.push(h('兼容性问题：'));
    for (const f of r.findings) L.push(`  [${f.code}] ${f.reason}`);
  }
  if (r.confirm.length) {
    L.push(h('需要人工确认：'));
    L.push(...r.confirm.map((c) => `  - ${c}`));
  }
  return md
    ? L.map((l) => (l.startsWith('  ') ? l.replace(/^ {2}/, '- ').replace(/^- - /, '  - ') : l)).join('\n')
    : L.join('\n');
}
