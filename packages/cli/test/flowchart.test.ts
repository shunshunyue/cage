import { expect, it } from 'vitest';
import { flowDirectionArrow, flowEdgeGeometry, layoutBusinessFlow } from '../ui/flowchart.js';
import type { BusinessStep } from '../src/graph-business.js';

function step(id: string, children: BusinessStep[] = [], approval = false): BusinessStep {
  return {
    id,
    node: { kind: approval ? 'approval' : 'command', key: `command:${id}`, id, hash: '', attrs: {} },
    label: '通过',
    note: '',
    via: [],
    children,
    repeated: false,
    boundary: false,
  };
}

it('横向和纵向流程图均保留分支及完整长标题，节点不会重叠', () => {
  const root = step('提交审批', [
    step(
      '采购审批',
      [
        step('审批通过', [
          step('锁定库存'),
          step('推送外部系统', [step('成功后回写采购单外部系统编号并保持当前业务状态')]),
        ]),
        step('审批驳回'),
      ],
      true,
    ),
  ]);
  const before = JSON.stringify(root);
  for (const direction of ['tb', 'lr'] as const) {
    const layout = layoutBusinessFlow(
      root,
      (s) => s.node.id,
      () => '草稿 → 待审批',
      direction,
    );
    expect(layout.nodes).toHaveLength(7);
    expect(layout.edges).toHaveLength(6);
    expect(layout.nodes.find((n) => n.step.node.id === '采购审批')!.decision).toBe(true);
    for (const node of layout.nodes) expect(node.title.join('')).toBe(node.step.node.id);
    for (const a of layout.nodes)
      for (const b of layout.nodes) {
        if (a === b) continue;
        const p = a.position,
          q = b.position;
        expect(
          p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y,
        ).toBe(false);
      }
    for (const edge of layout.edges) {
      const from = layout.nodes.find((n) => n.step.id === edge.from)!.position;
      const to = layout.nodes.find((n) => n.step.id === edge.to)!.position;
      expect(direction === 'tb' ? to.y > from.y + from.height : to.x > from.x + from.width).toBe(true);
    }
  }
  expect(JSON.stringify(root)).toBe(before);
});

it('循环回连已有节点，取消审批按终止动作展示，不混成审批决定', () => {
  const repeated = { ...step('again'), repeated: true, node: step('start').node };
  const root = step('start', [step('next', [repeated])]);
  const layout = layoutBusinessFlow(
    root,
    (s) => s.node.id,
    () => '',
  );
  expect(layout.nodes.map((n) => n.step.id)).toEqual(['start', 'next']);
  expect(layout.edges).toContainEqual(expect.objectContaining({ from: 'next', to: 'start', loop: true }));
  const cancel = { ...step('审批流程', [], true), label: '取消审批' };
  const node = layoutBusinessFlow(
    cancel,
    (s) => s.node.id,
    () => '',
  ).nodes[0];
  expect(node.decision).toBe(false);
  expect(node.title.join('')).toBe('取消：审批流程');
});

it('手动移动节点后，箭头端点与标签跟随；节点移到前方时连线切换入口方向', () => {
  const from = { x: 10, y: 20, width: 200, height: 80 };
  const to = { x: 400, y: 300, width: 200, height: 100 };
  const before = flowEdgeGeometry(from, to, 'lr');
  expect(before.path).toBe('M210,60 H305 V350 H400');
  to.x = -300;
  to.y = -200;
  const after = flowEdgeGeometry(from, to, 'lr');
  expect(after.path).toBe('M10,60 H-45 V-150 H-100');
  expect(after.labelX).toBe(-45);
  expect(after.labelY).toBe(-162);
  const vertical = flowEdgeGeometry(from, to, 'tb');
  expect(vertical.path.startsWith('M110,20 ')).toBe(true);
  expect(vertical.path.endsWith('V-100')).toBe(true);
});

it('主线保持同一轴线，带关联的分支不会推歪下一阶段；长分支结束后再汇合', () => {
  const finish = step('完成');
  const again = { ...step('汇合'), node: finish.node, repeated: true };
  const association = { ...step('预算'), mode: 'association' as const };
  const main = step('主线', [finish, association]);
  const branch = step('支线', [step('核定', [again])]);
  const root = step('审批', [main, branch], true);
  for (const direction of ['tb', 'lr'] as const) {
    const layout = layoutBusinessFlow(
      root,
      (s) => s.node.id,
      () => '',
      direction,
    );
    const position = (id: string) => layout.nodes.find((n) => n.step.id === id)!.position;
    const axis = (id: string) => {
      const p = position(id);
      return direction === 'tb' ? p.x + p.width / 2 : p.y + p.height / 2;
    };
    expect(axis('审批')).toBe(axis('主线'));
    expect(axis('主线')).toBe(axis('完成'));
    for (const edge of layout.edges.filter((e) => e.step.mode !== 'association')) {
      const from = position(edge.from),
        to = position(edge.to);
      expect(direction === 'tb' ? to.y > from.y + from.height : to.x > from.x + from.width).toBe(true);
    }
  }
});

it('回到前序阶段与跨层连线绕开中间业务及关联对象，两个排列方向都可读', () => {
  const retry = { ...step('重提'), node: step('提交').node, repeated: true };
  const cancelled = step('取消');
  const repeatedCancel = { ...step('取消副本'), node: cancelled.node, repeated: true };
  const relation = { ...step('明细快照'), mode: 'association' as const };
  const root = step('填写', [
    step('提交', [step('审批', [step('通过', [cancelled]), step('驳回', [retry])], true), relation]),
    repeatedCancel,
  ]);
  for (const direction of ['tb', 'lr'] as const) {
    const layout = layoutBusinessFlow(
      root,
      (s) => s.node.id,
      () => '',
      direction,
    );
    const obstacles = layout.nodes.map((n) => n.position);
    for (const edge of layout.edges) {
      const a = layout.nodes.find((n) => n.step.id === edge.from)!.position;
      const b = layout.nodes.find((n) => n.step.id === edge.to)!.position;
      const edgeDirection = edge.step.mode === 'association' ? (direction === 'tb' ? 'lr' : 'tb') : direction;
      const geometry = flowEdgeGeometry(a, b, edgeDirection, edge.loop, obstacles, edge.routing);
      for (const box of obstacles.filter((p) => p !== a && p !== b)) {
        for (let i = 1; i < geometry.points.length; i++) {
          const p = geometry.points[i - 1],
            q = geometry.points[i];
          const crossing =
            p.x === q.x
              ? p.x > box.x &&
                p.x < box.x + box.width &&
                Math.max(p.y, q.y) > box.y &&
                Math.min(p.y, q.y) < box.y + box.height
              : p.y > box.y &&
                p.y < box.y + box.height &&
                Math.max(p.x, q.x) > box.x &&
                Math.min(p.x, q.x) < box.x + box.width;
          expect(
            crossing,
            `${edge.from} → ${edge.to} 穿过 ${layout.nodes.find((n) => n.position === box)!.step.id}`,
          ).toBe(false);
        }
      }
    }
  }
});

it('取消草稿和取消审批分别从侧边引出，不共用主线出口、长线通道或终点端口', () => {
  const cancelled = { ...step('取消租赁'), branch: true };
  const cancel = (id: string, label: string): BusinessStep => ({
    ...step(id),
    node: cancelled.node,
    branch: true,
    repeated: true,
    label,
  });
  const allocation = step('配发', [
    step('领取', [step('完成')]),
    cancelled,
    { ...step('仓管取消'), branch: true },
    { ...step('超时取消'), branch: true },
  ]);
  const submit = step('提交', [step('审批', [allocation]), cancel('取消审批', '取消审批中的申请')]);
  const root = step('填写', [submit, cancel('取消草稿', '取消草稿')]);
  for (const direction of ['tb', 'lr'] as const) {
    const layout = layoutBusinessFlow(
      root,
      (s) => s.node.id,
      () => '',
      direction,
    );
    const obstacles = layout.nodes.map((n) => n.position);
    const position = (id: string) => layout.nodes.find((n) => n.step.id === id)!.position;
    const cancellations = layout.edges.filter((e) => e.to === cancelled.id);
    expect(cancellations).toHaveLength(3);
    expect(new Set(cancellations.map((e) => e.routing?.lane)).size).toBe(3);
    expect(new Set(cancellations.map((e) => e.routing?.targetPort)).size).toBe(3);
    for (const edge of layout.edges) {
      const a = position(edge.from),
        b = position(edge.to);
      const geometry = flowEdgeGeometry(a, b, direction, edge.loop, obstacles, edge.routing);
      if (edge.step.branch) {
        expect(geometry.points[0]).toEqual(
          direction === 'tb'
            ? { x: a.x, y: a.y + a.height * edge.routing!.sourcePort }
            : { x: a.x + a.width * edge.routing!.sourcePort, y: a.y },
        );
        expect(flowDirectionArrow(geometry.points)).not.toBe('');
      }
      for (const box of obstacles.filter((p) => p !== a && p !== b))
        for (let i = 1; i < geometry.points.length; i++) {
          const p = geometry.points[i - 1],
            q = geometry.points[i];
          const crossing =
            p.x === q.x
              ? p.x > box.x &&
                p.x < box.x + box.width &&
                Math.max(p.y, q.y) > box.y &&
                Math.min(p.y, q.y) < box.y + box.height
              : p.y > box.y &&
                p.y < box.y + box.height &&
                Math.max(p.x, q.x) > box.x &&
                Math.min(p.x, q.x) < box.x + box.width;
          expect(crossing, `${edge.from} → ${edge.to} 穿过其他节点`).toBe(false);
        }
    }
    const branches = layout.edges.filter((e) => e.from === allocation.id && e.step.branch);
    const captions = branches.map((edge) =>
      flowEdgeGeometry(position(edge.from), position(edge.to), direction, edge.loop, obstacles, edge.routing),
    );
    expect(
      Math.abs(
        (direction === 'tb' ? captions[1].labelY : captions[1].labelX) -
          (direction === 'tb' ? captions[0].labelY : captions[0].labelX),
      ),
    ).toBeGreaterThan(direction === 'tb' ? 50 : 110);
  }
});

it('取消终点在屏幕外时，方向箭头仍靠近源节点；向左与返回上方均沿真实走向', () => {
  const left = flowDirectionArrow([
    { x: 300, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 6000 },
  ]);
  const points = left.split(' ').map((p) => p.split(',').map(Number));
  expect(points[0][0]).toBeLessThan(points[1][0]);
  expect(points[0][0]).toBeGreaterThanOrEqual(200);
  expect(points[0][1]).toBe(100);
  const up = flowDirectionArrow([
    { x: 50, y: 300 },
    { x: 50, y: 0 },
  ]);
  const vertices = up.split(' ').map((p) => p.split(',').map(Number));
  expect(vertices[0][1]).toBeLessThan(vertices[1][1]);
  expect(
    flowDirectionArrow([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]),
  ).toBe('');
});
