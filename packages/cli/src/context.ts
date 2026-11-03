// 开发前的上下文包：沿声明截取一小块业务图，并列出继续阅读的源码及检查线索。
// 这里只读取工程源码、文件名和已抽取元数据，不读取 .env，不连接业务数据库。
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { kebab, lowerFirst } from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { deriveTests } from './derive.js';
import { selectRelatedTests } from './impact.js';
import type { GraphSnapshot } from './graph-snapshot.js';
import type { ViewEdge } from './graph-model.js';
import {
  graphReader,
  relationMarkdown,
  reportFooter,
  reportHeader,
  sourceText,
  type GraphNodeInfo,
} from './graph-query.js';

/** 只去掉实现哈希，保留输入、状态、约束、范围等可读事实。要看完整原始属性用 inspect。 */
function compactNode(node: GraphNodeInfo): GraphNodeInfo {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs).filter(
      ([key]) =>
        !['src', 'invariantSrc', 'sql', 'build'].includes(key) || (key === 'sql' && node.kind === 'field'),
    ),
  );
  return { ...node, attrs };
}

function contextResources(cfg: CageConfig, snapshot: GraphSnapshot, nodes: GraphNodeInfo[], roots: string[]) {
  const sourceFiles = [...new Set(nodes.flatMap((node) => (node.source ? [node.source.file] : [])))].sort();
  const aggregates = [
    ...new Set(
      nodes
        .filter((node) => ['aggregate', 'command', 'field', 'state', 'capability'].includes(node.kind))
        .map((node) => node.id.split('.')[0]),
    ),
  ];
  const contracts = aggregates.map((id) => ({
    file: join(cfg.contracts, 'aggregates', kebab(id), 'index.ts').replace(/\\/g, '/'),
    reason: `聚合 ${id} 的生成 API、类型和 hooks；通过 gen 更新`,
  }));
  if (nodes.some((node) => node.kind === 'query'))
    contracts.push({
      file: join(cfg.contracts, 'queries/index.ts').replace(/\\/g, '/'),
      reason: '生成查询 API；通过 gen 更新',
    });
  const testFiles = globSync(
    ['packages/**/src/**/*.{test,spec}.{ts,tsx}', 'apps/api/**/*.{test,spec}.{ts,tsx}'],
    {
      cwd: cfg.root,
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  ).sort();
  // 所属聚合只是附带资料时，不把该聚合的全部派生测试都塞进来；命令按 subject 挑选。
  const subjects = new Set(
    nodes.filter((node) => node.kind !== 'aggregate' || roots.includes(node.key)).map((node) => node.id),
  );
  const tests = selectRelatedTests(
    subjects,
    deriveTests(cfg, snapshot.graph).tests,
    testFiles.map((file) => abs(cfg, file)),
  );
  const terms = [
    ...new Set([
      ...aggregates.flatMap((id) => [id, lowerFirst(id)]),
      ...nodes.filter((node) => node.kind === 'query').map((node) => node.id),
    ]),
  ];
  const frontend = existsSync(abs(cfg, cfg.web))
    ? globSync('src/**/*.{ts,tsx}', {
        cwd: abs(cfg, cfg.web),
        exclude: ['**/node_modules/**', '**/dist/**'],
      })
        .sort()
        .flatMap((file) => {
          const text = readFileSync(abs(cfg, join(cfg.web, file)), 'utf8');
          const matches = terms.filter((term) => text.includes(term));
          return matches.length
            ? [{ file: join(cfg.web, file).replace(/\\/g, '/'), matches, basis: 'text-match' as const }]
            : [];
        })
    : [];
  return {
    sourceFiles,
    contracts: contracts.map((ref) => ({ ...ref, exists: existsSync(abs(cfg, ref.file)), generated: true })),
    migrations: {
      directory: cfg.migrations,
      note: '字段/关联存储变化时生成并审查新迁移；不改写已执行迁移。本命令不比较真实数据库。',
    },
    tests: {
      basis: '派生测试按 subject 选择，项目测试按源码名称匹配；只是候选，未执行。',
      derived: tests.derived.slice(0, 20),
      project: tests.project.map((file) => relative(cfg.root, file).replace(/\\/g, '/')),
      derivedTotal: tests.derived.length,
      truncated: tests.derived.length > 20,
    },
    frontend: {
      candidates: frontend.slice(0, 12),
      total: frontend.length,
      truncated: frontend.length > 12,
      note: '仅按聚合/查询的代码名称查找引用，不是完整的前端依赖分析。',
    },
  };
}

export function buildContext(
  cfg: CageConfig,
  snapshot: GraphSnapshot,
  query: string,
  options: { depth?: number; limit?: number; freshness?: 'fresh-extraction' | 'displayed-snapshot' } = {},
) {
  const reader = graphReader(snapshot, options.freshness);
  const depth = options.depth ?? 3,
    limit = options.limit ?? 40;
  const resolution = reader.resolve(query);
  const candidates = reader.search(query);
  // 完整 key / 唯一名称可精确定位；其余用得分接近的最多三个候选作为入口，报告中
  // 明示选择依据。用户可复制某个 key 再请求上下文，不让关键词匹配冒充需求确认。
  const roots =
    resolution.status === 'ok'
      ? resolution.candidates.map((hit) => hit.key)
      : candidates
          .filter((hit) => hit.score >= (candidates[0]?.score ?? 0) * 0.8)
          .slice(0, Math.min(3, limit))
          .map((hit) => hit.key);
  const selected = new Set(roots);
  const rootSet = new Set(roots);
  const queue = roots.map((key) => ({ key, distance: 0 }));
  const omitted = new Set<string>();
  // 实际业务链优先于归属和字段结构，避免聚合这个高连接度节点挤掉取消→释放链。
  const edges = [...reader.model.edges].sort(
    (a, b) =>
      Number(a.derived) - Number(b.derived) || Number(a.kind === 'field') - Number(b.kind === 'field'),
  );
  const participants = (edge: ViewEdge) => [
    edge.from,
    edge.to,
    ...(edge.kind === 'transition' && reader.byKey.has(`command:${edge.via}`) ? [`command:${edge.via}`] : []),
  ];
  for (const current of queue) {
    for (const edge of edges) {
      const keys = participants(edge);
      if (!keys.includes(current.key)) continue;
      for (const key of keys) {
        if (selected.has(key)) continue;
        if (current.distance >= depth) continue;
        if (selected.size >= limit) {
          omitted.add(key);
          continue;
        }
        selected.add(key);
        const node = reader.byKey.get(key)!;
        // 读依赖指向的表、命令所属对象、状态和字段作为阅读资料收进来；只有业务
        // 行为继续扩展，避免经“所属采购单”顺带把全部用户/部门和无关命令都展开。
        if (rootSet.has(key) || !['aggregate', 'field', 'state', 'entry', 'capability'].includes(node.kind))
          queue.push({ key, distance: current.distance + 1 });
      }
    }
  }
  const boundary = queue
    .filter(
      (current) =>
        current.distance >= depth &&
        edges.some((edge) => {
          const keys = participants(edge);
          return keys.includes(current.key) && keys.some((key) => !selected.has(key));
        }),
    )
    .map((current) => current.key);
  const nodes = [...selected].map((key) => compactNode(reader.nodeInfo(reader.byKey.get(key)!)));
  const relations = reader.model.edges
    .filter((edge) => participants(edge).every((key) => selected.has(key)))
    .map(reader.relationInfo);
  const review: string[] = [];
  if (nodes.some((n) => n.kind === 'command' || n.kind === 'capability'))
    review.push('涉及命令能力、数据范围或额度时复核管理员授权；新增能力不自动授予生产角色。');
  if (nodes.some((n) => n.kind === 'approval'))
    review.push('复核 start/cancelOn、审批分支、选人、结论命令和额度约束；取消审批与释放资源分别检查。');
  if (nodes.some((n) => n.kind === 'reaction' && (n.attrs.acquires || n.attrs.releases)))
    review.push('资源获取/释放标签只证明声明配对；阅读 map 的执行条件、null 返回以及同事务/异步方式。');
  if (nodes.some((n) => n.kind === 'event')) review.push('已部署事件保持兼容；核对载荷字段和所有订阅方。');
  if (nodes.some((n) => ['connector', 'outbound', 'inbound'].includes(n.kind)))
    review.push('复核外部请求/回调协议、字段映射和幂等；fake 或声明通过不等于真实外部联调通过。');
  return {
    ...reader.meta,
    operation: 'context' as const,
    status: roots.length ? ('ok' as const) : ('not-found' as const),
    query,
    selection: {
      mode: resolution.status === 'ok' ? 'exact' : 'keyword-candidates',
      roots,
      candidates: candidates.slice(0, 8),
      candidateTotal: candidates.length,
      candidatesTruncated: candidates.length > 8,
      note:
        resolution.status === 'ok'
          ? '精确节点入口。'
          : '按名称与中文词片段匹配的候选入口；请核对需求，可复制完整 key 缩小到单个节点。',
    },
    coverage: {
      depth,
      limit,
      selectedNodes: nodes.length,
      truncated: omitted.size > 0,
      omittedByLimit: omitted.size,
      depthBoundary: boundary,
      note: '仅输出相关子图；附带的表/字段/状态不继续展开。边界和截断不代表外部没有其他依赖。',
    },
    nodes,
    relations,
    resources: contextResources(cfg, snapshot, nodes, roots),
    review,
    nextSteps: [
      '先按源码位置阅读实现，确认候选入口符合需求；不要仅凭箭头推断条件与运行结果。',
      '改动前 cage snapshot save before-change，保存带时间与版本的独立基线；查询不修改命名快照。',
      '修改后运行 cage check、cage gen、cage doctor，审查契约/迁移，再 cage impact --snapshot before-change。',
      '阅读候选测试，按实际风险运行必要验证；报告通过、跳过、未执行项。',
    ],
  };
}

export function formatContext(report: ReturnType<typeof buildContext>): string {
  const lines = reportHeader(report, 'Cage 业务开发上下文');
  lines.push(`需求/节点：${report.query}`, '', report.selection.note, '', '## 候选入口与匹配依据', '');
  for (const hit of report.selection.candidates)
    lines.push(
      `- ${report.selection.roots.includes(hit.key) ? '【本次入口】' : '候选'} **${hit.label}** \`${hit.key}\`（得分 ${hit.score}）`,
      `  - ${hit.matches.map((m) => `${m.field}=${m.value}，命中 ${m.terms.join('、')}`).join('；')}`,
    );
  if (!report.nodes.length)
    lines.push('未找到相关声明；尝试更短的中文词或代码标识。空白模板不会注册参考资料中的采购业务。');
  lines.push(
    '',
    '## 子图范围',
    '',
    `深度 ${report.coverage.depth}，节点 ${report.nodes.length}/${report.coverage.limit}；${report.coverage.truncated ? '已截断，请提高 --limit 或缩小入口' : '节点上限未截断'}。`,
    report.coverage.note,
    ...(report.coverage.depthBoundary.length
      ? [`深度边界：${report.coverage.depthBoundary.join('、')}；需要时提高 --depth。`]
      : []),
    '',
    '## 业务事实与源码',
    '',
  );
  for (const node of report.nodes)
    lines.push(
      `### ${node.label} · ${node.key}`,
      '',
      `源码：${sourceText(node.source)}`,
      '',
      '```json',
      JSON.stringify(node.attrs, null, 2),
      '```',
      '',
    );
  lines.push(
    '## 关系：为什么连接、有什么用',
    '',
    ...report.relations.flatMap(relationMarkdown),
    '',
    '## 继续阅读的文件',
    '',
    ...report.resources.sourceFiles.map((file) => `- 源码：${file}`),
    ...report.resources.contracts.map(
      (ref) => `- 契约：${ref.file}${ref.exists ? '' : '（尚未生成）'}；${ref.reason}`,
    ),
    ...report.resources.frontend.candidates.map(
      (ref) => `- 前端候选：${ref.file}；文本命中 ${ref.matches.join('、')}`,
    ),
    report.resources.frontend.note,
    ...(report.resources.frontend.truncated ? ['前端候选已截断。'] : []),
    '',
    `迁移目录：${report.resources.migrations.directory}；${report.resources.migrations.note}`,
    '',
    '## 验证候选与审查提示',
    '',
    report.resources.tests.basis,
    ...report.resources.tests.project.map((file) => `- 项目测试候选：${file}`),
    ...report.resources.tests.derived.map((test) => `- 派生测试候选：${test.file} · ${test.name}`),
    ...(report.resources.tests.truncated
      ? [`派生测试候选共 ${report.resources.tests.derivedTotal} 项，仅列前 20 项。`]
      : []),
    ...report.review.map((item) => `- ${item}`),
    '',
    '## 接下来',
    '',
    ...report.nextSteps.map((step, i) => `${i + 1}. ${step}`),
  );
  return [...lines, ...reportFooter(report)].join('\n');
}
