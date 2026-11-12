/**
 * 为编程 agent 组织需求相关子图、源码位置、契约及验证候选，供 CLI 与本地图谱共用。
 * 从精确节点或名称候选出发做有界扩展，再读取项目测试与 Web 源码补充文本匹配线索。
 * 不执行推荐测试、不访问业务数据；输出截断、深度边界与证据来源，不能替代源码阅读或业务验收。
 */
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
/**
 * 移除实现文本及实现哈希等大属性，保留输入、状态、约束和字段 SQL 等可读事实。
 * @param node 已附证据与源码位置的节点。
 * @returns 浅拷贝节点和筛选后的 attrs，不修改快照；完整原始属性仍由 inspect 提供。
 */
function compactNode(node: GraphNodeInfo): GraphNodeInfo {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs).filter(
      ([key]) =>
        !['src', 'invariantSrc', 'sql', 'build'].includes(key) || (key === 'sql' && node.kind === 'field'),
    ),
  );
  return { ...node, attrs };
}

/**
 * 补齐子图之外需要阅读的契约、测试、Web 候选和迁移目录说明。
 * 按聚合/查询名扫描源码，不进行完整导入图分析；候选只是线索，未执行或证明覆盖。
 * @param cfg 文件定位配置。
 * @param snapshot 本次抽取图，供派生测试筛选使用。
 * @param nodes 子图节点。
 * @param roots 真正选定入口，避免把附带聚合的全部测试都带入。
 * @returns 带存在性、截断数量及匹配依据的资源清单；只读项目文件。
 */
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

/**
 * 从需求候选或精确节点构建有界业务上下文。
 * 优先扩展执行关系，聚合/字段等附带资料停止继续传播，降低高连接节点造成的上下文膨胀。
 * @param cfg 应用文件位置。
 * @param snapshot 单次抽取快照，查询不会更新它。
 * @param query 业务词或完整节点 key。
 * @param options depth 默认 3，limit 默认 40，freshness 区分本次抽取与页面快照。
 * @returns 子图、选择依据、覆盖边界和建议；未命中返回 not-found，不猜造节点。
 */
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
    review.push('涉及命令能力或数据范围时复核管理员授权；新增能力不自动授予普通生产角色。');
  if (nodes.some((n) => n.kind === 'approval'))
    review.push('复核 start/cancelOn、审批分支、选人和结论命令的业务约束；取消审批与释放资源分别检查。');
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

/**
 * 把结构化上下文渲染为可交给 agent 的 Markdown，保留候选和证据限制。
 * @param report buildContext 的完整报告。
 * @returns Markdown 文本；不写文件、不执行报告中的下一步命令。
 */
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
