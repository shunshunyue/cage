/**
 * 比较两个本体版本并沿声明依赖推导受影响节点和验证候选。
 * 入口可补充 Git 改动文件，随后合并新旧关系追踪字段、事件、审批及外部协作影响。
 * 结果不是完整程序依赖分析；测试按 subject 或源码名称匹配，授权和外部兼容提示仍需实际核对。
 */
// 影响分析：在基线和当前各生成一张图，找出变化的节点，再沿着边向外扩散。
// handler 文件的改动会被映射到它所属的命令节点，所以只改实现、不改声明也能算出影响。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { DerivedTest } from './derive.js';
import { checkEventCompat } from './rules.js';
import { diffOntology, type NodeDiff, type OntNode, type Ontology } from './ontology.js';
import type { Finding } from './findings.js';

/**
 * 本体差异、受影响主体、候选测试及人工复核提示；不包含执行测试后的通过结论。
 */
export interface ImpactResult {
  /** 按节点身份和哈希计算的增删改。 */
  diff: NodeDiff;
  /** 直接变化或改动文件映射得到的起点 ID。 */
  start: string[];
  /** 沿相关新旧关系传播得到的受影响 ID。 */
  affected: string[];
  /** 受影响节点 → 通过哪条边、以什么身份受影响 */
  reasons: Map<string, string>;
  /** 按 subject 命中的派生验证候选，尚未执行。 */
  tests: DerivedTest[];
  /** 调用方提供且匹配到主体名称的项目测试文件。 */
  projectTests: string[];
  /** 需要人工或额外证据确认的授权、外部兼容等事项。 */
  confirm: string[];
  /** 基线与当前 unsafe 使用数量，不表示每一处风险已审查。 */
  unsafe: { base: number; head: number };
  /** 事件兼容等影响规则发现。 */
  findings: Finding[];
  /** 分析器交付的边界说明；兼容外部构造的旧结果时可省略，未列出或候选数量不代表完整覆盖。 */
  limitations?: string[];
}

/**
 * 在指定应用目录执行只读 Git 查询并返回去掉首尾空白的文本；异常由各调用点解释。
 */
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * 只读判断当前目录是否处于 Git 工作树。
 * @param root 检查目录。
 * @returns rev-parse 成功且为 true 时真，失败时假。
 */
export function isGitRepo(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/**
 * 汇总基线至 HEAD、暂存、未暂存与未跟踪文件名。
 * @param root 应用目录。
 * @param base Git 比较基线。
 * @returns 去重文件名；单次 Git 查询失败按该部分无结果处理，不负责验证基线有效性。
 */
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

/**
 * 读取本体 JSON 或带 graph 的快照信封并检查基础形状。
 * @param path 文件路径。
 * @returns version=1 的本体；形状、读取或 JSON 错误抛出，不做完整节点语义校验。
 */
export function readOntology(path: string): Ontology {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const graph = value.graph ?? value;
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('[CAGE-IMPACT-002] 基线文件不是有效本体图或命名快照');
  return graph as Ontology;
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
  process: '业务流程',
  stage: '业务阶段',
};

/** 影响分析与开发前上下文共用测试候选选择。项目测试只按源码里的名字匹配，
 * 调用方必须标明它是线索，不能据此声称已找到全部需要执行的测试。 */
/**
 * 选择主体相关派生用例和源码名称命中的项目测试。
 * @param subjects 受影响主体 ID 集合。
 * @param tests 派生索引。
 * @param projectTestFiles 调用方提供的候选文件；不存在的已删文件忽略。
 * @returns 测试候选，不代表完整覆盖或已执行；短于三字符的名称不匹配项目测试。
 */
export function selectRelatedTests(
  subjects: ReadonlySet<string>,
  tests: DerivedTest[],
  projectTestFiles: string[],
) {
  const derived = tests.filter((t) => subjects.has(t.subject) || subjects.has(t.subject.split('.')[0]));
  const names = [...subjects].map((id) => id.split('.').pop()!);
  const project = projectTestFiles.filter((file) => {
    // Git 候选可能包括本次删除的测试；不存在的用例不能再作为可执行候选。
    if (!existsSync(file)) return false;
    const text = readFileSync(file, 'utf8');
    return names.some((name) => name.length > 2 && text.includes(name));
  });
  return { derived, project };
}

/**
 * 比较节点哈希并沿新旧边传播影响，保留已删除节点的旧消费者。
 * @param base 修改前本体。
 * @param head 当前本体。
 * @param files 额外变化文件，映射到其中声明。
 * @param tests 派生测试索引，默认空。
 * @param projectTestFiles 需要调用方传入的项目测试路径，默认空。
 * @returns 变化、影响理由和复核项；不运行测试或验证真实外部系统。
 */
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
      if (['implements', 'contains', 'relates'].includes(e.kind) && e.to === n) {
        next = e.from;
        why = `业务规格引用 ${n}`;
      } else if (e.kind === 'reads' && e.to === n) {
        next = e.from;
        why = `读依赖 ${n}`;
      } else if (e.kind === 'queries' && e.to === n) {
        next = e.from;
        why = `读取 ${n}`;
      } else if (e.kind === 'uses' && e.to === n) {
        next = e.from;
        why = `${e.as ?? '使用'}用到 ${n}`;
      } else if (e.kind === 'refs' && e.to === n) {
        next = e.from;
        why = `关联目标 ${n}`;
      } else if (e.kind === 'field' && e.to === n) {
        next = e.from;
        why = `包含字段 ${n}`;
      } else if (e.kind === 'emits' && e.from === n) {
        next = e.to;
        why = `由 ${n} 发出`;
      } else if ((e.kind === 'triggers' || e.kind === 'cancels') && e.from === n) {
        next = e.to;
        why = e.kind === 'cancels' ? `由 ${n} 取消审批` : `订阅 ${n}`;
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
  const selectedTests = selectRelatedTests(affected, tests, projectTestFiles);

  // 需要人工确认的点
  const confirm: string[] = [];
  const headById = new Map(head.nodes.map((n) => [n.id, n]));
  for (const c of diff.changed) {
    if (c.after.kind === 'field') {
      if (c.before.attrs.description !== c.after.attrs.description)
        confirm.push(`${c.after.id} 的口径说明变了：下游报表、外部系统是否同步`);
    }
  }
  for (const n of diff.added) {
    if (n.kind === 'command') confirm.push(`新能力点 ${n.id} 由超级管理员自动拥有，普通角色需要在 /admin 显式授权`);
  }
  for (const n of [...affected].map((id) => headById.get(id)).filter((x): x is OntNode => !!x)) {
    if (n.kind === 'outbound' && !start.has(n.id)) confirm.push(`外部同步 ${n.id} 受影响：对方系统是否兼容`);
  }
  return {
    diff,
    start: [...start],
    affected: [...affected],
    reasons,
    tests: selectedTests.derived,
    projectTests: selectedTests.project,
    confirm: [...new Set(confirm)],
    unsafe: { base: base.unsafeCount ?? 0, head: head.unsafeCount ?? 0 },
    findings: checkEventCompat(base, head),
    limitations: [
      '影响仅按本体节点哈希、传入的改动文件和已抽取的新旧声明关系推导，不分析完整导入或函数调用依赖。',
      '辅助函数、闭包值、前端或外部协议变化可能未进入结果；未列出不代表不受影响。',
      '测试按 subject 或传入文件中的源码名称匹配，只是尚未执行的候选；仍需按业务规则选择与补充验证。',
    ],
  };
}

/**
 * 按节点类别生成简短变化描述，命令补状态、反应补资源标签；只用于报告文案。
 */
function describeNode(n: OntNode): string {
  if (n.kind === 'command') {
    const from = n.attrs.from === 'new' ? '新建' : (n.attrs.from as string[]).join('/');
    return `${LABEL.command} ${n.id}（${from} → ${n.attrs.to ?? '保持当前状态'}）`;
  }
  if (n.kind === 'reaction')
    return `${LABEL.reaction} ${n.id}${n.attrs.acquires ? `（acquires: ${n.attrs.acquires}）` : ''}${n.attrs.releases ? `（releases: ${n.attrs.releases}）` : ''}`;
  return `${LABEL[n.kind] ?? n.kind} ${n.id}`;
}

/**
 * 渲染本体变化摘要、影响范围、候选计数与兼容提示。
 * @param r impact 结果。
 * @param head 当前图用于查中文类别及属性。
 * @param opts 文本/Markdown 格式和可选标题、门禁描述。
 * @returns 报告文本；候选数量不等于测试完成或全覆盖。
 */
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
  L.push(`${h('验证候选（尚未执行）：')}派生测试 ${r.tests.length} 个，项目测试 ${r.projectTests.length} 个`);
  L.push(...(r.limitations ?? []).map((limitation) => `说明：${limitation}`));
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
