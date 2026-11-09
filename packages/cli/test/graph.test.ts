/**
 * 验证本体图的身份、中文解释、结构卡片布局及本地浏览服务。
 * 纯函数用例检查派生边与原始图隔离；服务用例使用临时声明和真实 HTTP 覆盖刷新、源码白名单及跨站拒绝。
 * 服务与临时目录在结束时关闭清理，不访问业务数据库。
 */
import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildRegistry, aggregate, command, text, states } from '@yss123/cage-kernel';
import { extract, type Ontology } from '../src/ontology.js';
import { projectGraph, layoutGraph, neighborhood, nodeLabel, matchesNode } from '../ui/model.js';
import { explainEdge } from '../ui/relations.js';
import {
  tableCards,
  tableOwner,
  layoutTables,
  tableEdgePath,
  TABLE_WIDTH,
  TABLE_HEADER,
  TABLE_ROW,
  TABLE_FOOTER,
} from '../ui/structure.js';
// 服务通过已构建的入口启动，顺便验证图谱资源与抽取子进程能随 CLI 分发。
import { serveGraph } from '../dist/graph.js';
import { loadConfig } from '../src/config.js';

const Ticket = aggregate('Ticket', {
  fields: { title: text() },
  states: states('open', 'closed', { terminal: ['closed'] }),
});
const create = command(Ticket, { from: 'new', to: 'open', handler: () => ({}) });
const close = command(Ticket, { from: 'open', to: 'closed', handler: () => ({}) });
const graph = extract(buildRegistry({ Ticket, create, close }));

it('图谱保留声明关系，单独标记归属与新建入口，不修改原始图', () => {
  const before = JSON.stringify(graph);
  const view = projectGraph(graph);
  expect(JSON.stringify(graph)).toBe(before);
  expect(view.edges.filter((e) => !e.derived)).toHaveLength(graph.edges.length);
  expect(view.nodes.some((n) => n.kind === 'entry' && n.id === 'Ticket.[new]')).toBe(true);
  expect(view.edges).toContainEqual(
    expect.objectContaining({
      kind: 'ownership',
      from: 'aggregate:Ticket',
      to: 'command:Ticket.close',
      derived: true,
    }),
  );
  expect(neighborhood(view, 'aggregate:Ticket')).toContain('command:Ticket.close');
});

it('同名命令和能力点仍为两个独立节点，布局结果稳定且节点不重叠', () => {
  const input = structuredClone(graph);
  input.nodes.push({ kind: 'capability', id: 'Ticket.close', hash: 'test', attrs: {} });
  const view = projectGraph(input);
  expect(new Set(view.nodes.map((n) => n.key)).size).toBe(view.nodes.length);
  const a = layoutGraph(view.nodes, view.edges);
  expect(a).toEqual(layoutGraph(view.nodes, view.edges));
  expect(new Set([...a.values()].map((p) => `${p.x},${p.y}`)).size).toBe(view.nodes.length);
});

it('中文展示名支持双语搜索，不替换命令标识或本体哈希', () => {
  const view = projectGraph(graph);
  const node = view.nodes.find((n) => n.id === 'Ticket.close')!;
  const labels = { 'command:Ticket.close': '关闭工单' };
  const before = JSON.stringify(node);
  expect(nodeLabel(node, labels)).toBe('关闭工单');
  expect(matchesNode(node, '关闭', labels)).toBe(true);
  expect(matchesNode(node, 'ticket.CLOSE', labels)).toBe(true);
  expect(nodeLabel(node, {})).toBe('Ticket.close');
  expect(JSON.stringify(node)).toBe(before);
});

// 这些用例约束解释的业务含义：同样连向字段的 uses 边，审批白名单、选人、
// 条件判断和文本匹配不能混为一谈。测试不依赖 SVG 样式或文字排版。
const relationGraph: Ontology = {
  version: 1,
  unsafeCount: 0,
  nodes: [
    { kind: 'aggregate', id: 'Order', hash: '', attrs: {} },
    { kind: 'aggregate', id: 'Dept', hash: '', attrs: {} },
    { kind: 'field', id: 'Order.deptId', hash: '', attrs: { ref: 'Dept' } },
    { kind: 'field', id: 'Order.amount', hash: '', attrs: {} },
    {
      kind: 'approval',
      id: 'approval',
      hash: '',
      attrs: { routable: ['deptId', 'amount'], onApproved: 'Order.close', onRejected: 'Order.cancel' },
    },
    {
      kind: 'route',
      id: 'route:order',
      hash: '',
      file: 'approvals.ts',
      line: 15,
      attrs: {
        nodes: [
          { kind: 'step', title: '部门经理审批', approver: { kind: 'deptLeader', field: 'deptId' } },
          {
            kind: 'when',
            cond: { field: 'amount', op: 'gt', value: 50000 },
            steps: [{ kind: 'step', title: '财务审批', approver: { kind: 'role', code: 'finance' } }],
          },
        ],
      },
    },
    { kind: 'query', id: 'summary', hash: '', attrs: {} },
    { kind: 'outbound', id: 'push', hash: '', attrs: { onSuccess: 'Order.close' } },
    { kind: 'command', id: 'Order.close', hash: '', attrs: {} },
    { kind: 'command', id: 'Order.cancel', hash: '', attrs: {} },
  ],
  edges: [
    { kind: 'field', from: 'Order', to: 'Order.deptId' },
    { kind: 'refs', from: 'Order.deptId', to: 'Dept' },
    { kind: 'uses', from: 'approval', to: 'Order.deptId', as: '可路由字段' },
    { kind: 'uses', from: 'route:order', to: 'Order.deptId', as: '路由条件' },
    { kind: 'uses', from: 'route:order', to: 'Order.amount', as: '路由条件' },
    { kind: 'uses', from: 'summary', to: 'Order.deptId', as: '查询' },
    { kind: 'queries', from: 'summary', to: 'Order' },
    { kind: 'binds', from: 'approval', to: 'Order.close' },
    { kind: 'binds', from: 'approval', to: 'Order.cancel' },
    { kind: 'targets', from: 'push', to: 'Order.close' },
  ],
};
const relationModel = projectGraph(relationGraph);
const labels = {
  'field:Order.deptId': '所属部门',
  'aggregate:Dept': '部门',
  'field:Order.amount': '采购金额',
};
/**
 * 根据完整端点 key 选取夹具中唯一关系，再调用公共解释器；中文覆盖只影响说明文案。
 * 夹具确保关系存在，缺失时应让测试失败，不在这里补造边。
 */
const explanation = (from: string, to: string) =>
  explainEdge(
    relationModel.edges.find((e) => e.from === from && e.to === to)!,
    relationModel,
    labels,
  );

it('字段归属与对象引用保留各自方向，聚焦布局把依赖方与目标分开放置', () => {
  expect(explanation('aggregate:Order', 'field:Order.deptId').label).toBe('包含字段');
  const ref = explanation('field:Order.deptId', 'aggregate:Dept');
  expect(ref.why).toContain('保存所关联对象的标识');
  expect(ref.direction).toContain('“所属部门” → “部门”');
  const focus = 'field:Order.deptId';
  const neighbors = neighborhood(relationModel, focus);
  const positions = layoutGraph(
    relationModel.nodes.filter((n) => neighbors.has(n.key)),
    relationModel.edges.filter((e) => e.from === focus || e.to === focus),
    focus,
  );
  expect(positions.get('aggregate:Order')!.x).toBeLessThan(positions.get(focus)!.x);
  expect(positions.get('aggregate:Dept')!.x).toBeGreaterThan(positions.get(focus)!.x);
});

it('审批可用字段只解释为授权读取，不声称它一定用于分支判断', () => {
  const allowed = explanation('approval:approval', 'field:Order.deptId');
  expect(allowed.label).toBe('允许审批读取');
  expect(allowed.purpose).toContain('这里只表示允许使用');
  expect(allowed.evidence).toContain('approval.routable 包含 deptId');
});

it('路由明确区分部门选人与金额条件，并展示具体步骤、比较值及声明位置', () => {
  const who = explanation('route:route:order', 'field:Order.deptId');
  expect(who.label).toBe('确定审批人');
  expect(who.why).toContain('部门经理审批');
  expect(who.why).toContain('对应部门的负责人');
  expect(who.source.file).toBe('approvals.ts');
  const branch = explanation('route:route:order', 'field:Order.amount');
  expect(branch.label).toBe('判断审批分支');
  expect(branch.why).toContain('大于 50000');
  expect(branch.why).toContain('财务审批');
});

it('查询字段匹配说明推断局限，读取箭头指向数据来源而不是执行顺序', () => {
  expect(explanation('query:summary', 'field:Order.deptId').purpose).toContain('字段名文本匹配');
  expect(explanation('query:summary', 'aggregate:Order').purpose).toContain('不表示先执行它');
  expect(explanation('aggregate:Order', 'command:Order.close').purpose).toContain('不会触发命令');
});

it('审批结论和出站成功回写不会被混成普通的目标调用', () => {
  expect(explanation('approval:approval', 'command:Order.close').label).toBe('通过后执行');
  expect(explanation('approval:approval', 'command:Order.cancel').label).toBe('驳回后执行');
  expect(explanation('outbound:push', 'command:Order.close').purpose).toContain('失败时不执行成功回写');
});

it('状态迁移解释回溯到命令位置，保持状态的自环不会虚构新状态', () => {
  const input = structuredClone(graph);
  const closeNode = input.nodes.find((n) => n.kind === 'command' && n.id === 'Ticket.close')!;
  closeNode.file = 'ticket.ts';
  closeNode.line = 20;
  closeNode.attrs.to = null;
  input.edges.find((e) => e.kind === 'transition' && e.via === 'Ticket.close')!.to = 'Ticket.open';
  const view = projectGraph(input);
  const detail = explainEdge(
    view.edges.find((e) => e.kind === 'transition' && e.via === 'Ticket.close')!,
    view,
  );
  expect(detail.label).toBe('保持状态');
  expect(detail.source.id).toBe('Ticket.close');
  expect(detail.source.line).toBe(20);
  expect(detail.why).toContain('保持原状态');
});

it('表卡片只收纳明确归属的字段，保留节点身份和声明次序，不补造数据库列', () => {
  const before = JSON.stringify(relationModel);
  const cards = tableCards(relationModel);
  const order = cards.find((c) => c.node.id === 'Order')!;
  // Order.amount 虽有字段节点，但此用例没有 field 归属边，不可凭名称猜列。
  expect(order.fields.map((f) => f.id)).toEqual(['Order.deptId']);
  expect(order.fields[0]).toBe(relationModel.nodes.find((n) => n.id === 'Order.deptId'));
  expect(tableOwner(cards, 'field:Order.deptId')).toBe(order);
  expect(tableOwner(cards, 'command:Order.close')).toBeUndefined();
  expect(cards.find((c) => c.node.id === 'Dept')!.height).toBe(TABLE_HEADER + TABLE_FOOTER);
  expect(JSON.stringify(relationModel)).toBe(before);
});

it('字段数不同的表卡片在单列和双列排布时均不重叠，长表不会被截为固定高度', () => {
  const input = structuredClone(relationGraph);
  for (let index = 0; index < 12; index++) {
    const id = `Order.extra${index}`;
    input.nodes.push({ kind: 'field', id, hash: '', attrs: {} });
    input.edges.push({ kind: 'field', from: 'Order', to: id });
  }
  const view = projectGraph(input),
    cards = tableCards(view);
  expect(cards.find((c) => c.node.id === 'Order')!.height).toBe(TABLE_HEADER + 13 * TABLE_ROW + TABLE_FOOTER);
  for (const columns of [1, 2]) {
    const positions = layoutTables(
      cards,
      view.edges.filter((e) => e.kind === 'refs'),
      columns,
    );
    const a = positions.get(cards[0]!.node.key)!,
      b = positions.get(cards[1]!.node.key)!;
    const overlaps =
      a.x < b.x + TABLE_WIDTH &&
      a.x + TABLE_WIDTH > b.x &&
      a.y < b.y + cards[1]!.height &&
      a.y + cards[0]!.height > b.y;
    expect(overlaps).toBe(false);
  }
});

it('引用线从具体字段行连到目标表头，拖动后和自引用仍保留正确端点', () => {
  const cards = tableCards(relationModel);
  const edge = relationModel.edges.find((e) => e.kind === 'refs')!;
  const positions = new Map([
    ['aggregate:Order', { x: 0, y: 0 }],
    ['aggregate:Dept', { x: 500, y: 40 }],
  ]);
  const rowY = TABLE_HEADER + TABLE_ROW / 2;
  const path = tableEdgePath(edge, cards, positions);
  expect(path.startsWith(`M${TABLE_WIDTH},${rowY} `)).toBe(true);
  expect(path.endsWith(`500,${40 + TABLE_HEADER / 2}`)).toBe(true);
  positions.set('aggregate:Order', { x: 20, y: 70 });
  expect(tableEdgePath(edge, cards, positions).startsWith(`M${20 + TABLE_WIDTH},${rowY + 70} `)).toBe(true);
  const self = tableEdgePath({ ...edge, to: 'aggregate:Order' }, cards, positions);
  expect(self.endsWith(`${20 + TABLE_WIDTH},${70 + TABLE_HEADER / 2}`)).toBe(true);
});

const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cage-graph-test-')));
afterAll(() => {
  // Windows 的递归清理只允许落在本次创建的临时目录，不接收用户路径。
  const target = resolve(temporary);
  if (!target.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('临时测试目录不在预期范围内');
  rmSync(target, { recursive: true, force: true });
});

it('Web 服务从最新声明刷新，保留可定位的图规则问题，并拒绝跨站刷新与文件探测', async () => {
  const file = join(temporary, 'domain.ts');
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'graph-fixture', type: 'module' }));
  writeFileSync(
    join(temporary, 'cage.config.json'),
    JSON.stringify({
      domain: 'domain.ts',
      graph: { title: '通知业务', labels: { 'field:Note.title': '通知标题' } },
    }),
  );
  const source = (field: string) =>
    `import { aggregate, command, text, businessProcess } from ${JSON.stringify(import.meta.resolve('@yss123/cage-kernel'))};\nexport const Note = aggregate('Note', { description: '通知', fields: { ${field}: text() } });\nexport const publish = command(Note, { from: 'new', to: 'active', handler: () => ({}) });\nexport const noticeFlow = businessProcess('notice-flow', { title: '发布通知', description: '登记通知并结束。', area: { id: 'notice', title: '通知管理', description: '通知发布。' }, subject: Note, entry: 'publish', stages: { publish: { title: '发布通知', description: '填写通知内容。', kind: 'end', action: publish } }, transitions: [] });\n`;
  writeFileSync(file, source('title'));
  const { server, url } = await serveGraph(loadConfig(temporary), 0);
  try {
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('业务关系探索');
    expect((await fetch(`${url}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${url}/relations.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${url}/structure.js`)).headers.get('content-type')).toContain('javascript');
    for (const module of [
      'graph-model',
      'graph-search',
      'graph-relations',
      'graph-business',
      'business',
      'flowchart',
      'flowchart-interaction',
      'approval-flow',
      'approval-parallel',
      'approval-tree',
      'graph-approvals',
    ])
      expect((await fetch(`${url}/${module}.js`)).status).toBe(200);
    expect((await fetch(`${url}/business.css`)).status).toBe(200);
    const first = await (await fetch(`${url}/api/graph`)).json();
    expect(first.graph.nodes.some((n: { id: string }) => n.id === 'Note.title')).toBe(true);
    expect(first.presentation.title).toBe('通知业务');
    expect(first.presentation.labels['aggregate:Note']).toBe('通知');
    expect(first.presentation.labels['field:Note.title']).toBe('通知标题');
    expect(first.sources).toBeUndefined();
    const stageSource = await (await fetch(`${url}/api/source?node=stage:notice-flow.publish`)).json();
    expect(stageSource.code).toContain("businessProcess('notice-flow'");
    expect(stageSource.line).toBe(4);
    const actionSource = await (await fetch(`${url}/api/source?node=command:Note.publish`)).json();
    expect(actionSource.code).toContain('handler: () => ({})');
    const stageContext = await (await fetch(`${url}/api/context?node=stage:notice-flow.publish`)).json();
    expect(stageContext.nodes.some((n: { key: string }) => n.key === 'command:Note.publish')).toBe(true);
    const implementation = await (await fetch(`${url}/api/source?node=aggregate:Note`)).json();
    expect(implementation.code).toContain('fields: { title: text() }');
    expect(implementation.file).toBe('domain.ts');
    expect(implementation.line).toBe(2);
    expect(implementation.freshness).toBe('displayed-snapshot');
    const fieldSource = await (await fetch(`${url}/api/source?node=field:Note.title`)).json();
    expect(fieldSource.precision).toBe('aggregate');
    expect(fieldSource.sourceKey).toBe('aggregate:Note');
    expect((await fetch(`${url}/api/source`)).status).toBe(400);
    expect((await fetch(`${url}/api/source?node=../../.env`)).status).toBe(404);
    expect(first.findings.some((f: { code: string }) => f.code === 'CAGE-ORG-001')).toBe(true);
    const context = await (await fetch(`${url}/api/context?node=aggregate:Note`)).json();
    expect(context.freshness).toBe('displayed-snapshot');
    expect(context.extractedAt).toBe(first.generatedAt);
    expect(context.nodes.some((node: { label: string }) => node.label === '通知标题')).toBe(true);
    const markdown = await (await fetch(`${url}/api/context?node=aggregate:Note&format=md`)).text();
    expect(markdown).toContain('Cage 业务开发上下文');
    expect((await fetch(`${url}/api/context`)).status).toBe(400);
    expect((await fetch(`${url}/.env`)).status).toBe(404);
    expect(
      (
        await fetch(`${url}/api/refresh`, {
          method: 'POST',
          headers: { Origin: 'https://unrelated.example' },
        })
      ).status,
    ).toBe(403);
    // 真正改写 domain 后刷新，能检出 ESM 缓存导致的“假刷新”。
    writeFileSync(file, source('message'));
    // 修改磁盘但未重新抽取时，源码预览必须仍与显示中的图谱对应。
    expect((await (await fetch(`${url}/api/source?node=aggregate:Note`)).json()).code).toBe(implementation.code);
    const fresh = await (
      await fetch(`${url}/api/refresh`, { method: 'POST', headers: { Origin: url } })
    ).json();
    expect(fresh.graph.nodes.some((n: { id: string }) => n.id === 'Note.message')).toBe(true);
    expect(fresh.graph.nodes.some((n: { id: string }) => n.id === 'Note.title')).toBe(false);
    expect((await (await fetch(`${url}/api/source?node=aggregate:Note`)).json()).code).toContain('fields: { message: text() }');
    expect((await fetch(`${url}/api/source?node=field:Note.title`)).status).toBe(404);
    writeFileSync(file, 'this is not valid TypeScript');
    expect((await fetch(`${url}/api/refresh`, { method: 'POST', headers: { Origin: url } })).status).toBe(
      500,
    );
    const retained = await (await fetch(`${url}/api/graph`)).json();
    expect(retained.generatedAt).toBe(fresh.generatedAt);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
