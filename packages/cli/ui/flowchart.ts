import type { BusinessStep } from '../src/graph-business.js';
import { isApprovalRejection, type ApprovalFlow } from '../src/graph-approvals.js';
import { layoutApprovalFlow, renderApprovalFlow, type ApprovalFlowLayout } from './approval-flow.js';
import {
  createFlowGestures,
  wheelFlowCamera,
  zoomFlowCamera,
  revealFlowPosition,
  MIN_FLOW_ZOOM,
  MAX_FLOW_ZOOM,
  type FlowCamera,
  type FlowPoint,
} from './flowchart-interaction.js';

export type FlowDirection = 'tb' | 'lr';
export interface FlowPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FlowEdge {
  from: string;
  to: string;
  step: BusinessStep;
  loop: boolean;
  routing?: FlowEdgeRouting;
}
export interface FlowEdgeRouting {
  lane: number;
  sourcePort: number;
  targetPort: number;
  targetLane: number;
  sourceOffset?: number;
  sourceDecision?: boolean;
  targetDecision?: boolean;
}
export interface FlowLayout {
  nodes: {
    step: BusinessStep;
    position: FlowPosition;
    title: string[];
    state: string[];
    decision: boolean;
    association?: boolean;
    approval?: ApprovalFlowLayout;
  }[];
  edges: FlowEdge[];
  width: number;
  height: number;
}
export interface FlowChartState {
  camera: FlowCamera;
  positions: Map<string, FlowPoint>;
  tool: 'select' | 'pan';
  expanded: boolean;
  selection: string | null;
}

export const createFlowChartState = (): FlowChartState => ({
  camera: { x: 0, y: 0, scale: 1, initialized: false },
  positions: new Map(),
  tool: 'select',
  expanded: false,
  selection: null,
});

/** 按实际字宽换行，长中文完整留在节点内；业务标题不再用省略号截断。 */
function wrap(text: string, length: number): string[] {
  const lines: string[] = [];
  let line = '',
    used = 0;
  for (const character of text) {
    const width = /[\u0000-\u00ff]/.test(character) ? 0.55 : 1;
    if (used + width > length && line) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += character;
    used += width;
  }
  if (line) lines.push(line);
  return lines;
}

/** 主流程分层，对象关联放在阶段侧面。循环和汇合回连已有阶段，
 * 关联节点不参与流程深度，避免把“涉及设备”误读为“下一步执行设备”。 */
export function layoutBusinessFlow(
  root: BusinessStep,
  name: (step: BusinessStep) => string,
  state: (step: BusinessStep) => string,
  direction: FlowDirection = 'tb',
  approvals: ReadonlyMap<string, ApprovalFlow> = new Map(),
): FlowLayout {
  const nodes: FlowLayout['nodes'] = [];
  const edges: FlowEdge[] = [];
  const sizes = new Map<string, { cross: number; along: number; rank: number }>();
  const related = new Map<string, FlowLayout['nodes']>();
  const relatedGaps = new Map<string, number>();
  const walk = (step: BusinessStep, depth: number, ancestors: BusinessStep[]) => {
    if (step.repeated) {
      const ancestor = [...ancestors].reverse().find((n) => n.node.key === step.node.key);
      const target = ancestor ?? nodes.find((n) => n.step.node.key === step.node.key)?.step;
      if (target)
        edges.push({
          from: ancestors[ancestors.length - 1].id,
          to: target.id,
          step,
          loop: Boolean(ancestor),
        });
      return;
    }
    const approval = approvals.has(step.id)
      ? layoutApprovalFlow(approvals.get(step.id)!, name(step))
      : undefined;
    const decision =
      !approval &&
      ((step.node.kind === 'approval' && step.label !== '取消审批') ||
        step.node.attrs.stageKind === 'decision');
    const title = wrap((step.label === '取消审批' ? '取消：' : '') + name(step), decision ? 9 : 12);
    const summary = decision || approval ? [] : wrap(state(step), 21);
    const width = approval?.width ?? (decision ? 198 : 208);
    const height =
      approval?.height ??
      (decision ? Math.max(116, title.length * 21 + 58) : 52 + title.length * 22 + summary.length * 16);
    nodes.push({ step, title, state: summary, decision, approval, position: { x: 0, y: 0, width, height } });
    const associations = step.children
      .filter((child) => child.mode === 'association')
      .map((child) => {
        const title = wrap(name(child), 11);
        const summary = wrap(state(child), 18);
        return {
          step: child,
          title,
          state: summary,
          decision: false,
          association: true,
          position: { x: 0, y: 0, width: 190, height: 52 + title.length * 22 + summary.length * 16 },
        };
      });
    related.set(step.id, associations);
    // 关联说明放在线上方，横向空隙至少容纳完整文字，避免盖到两侧对象卡片。
    const relatedGap =
      direction === 'tb'
        ? Math.max(
            110,
            ...associations.map(
              (item) =>
                Math.max(
                  ...wrap(item.step.label, 20).map((line) =>
                    [...line].reduce((size, char) => size + (/[\u0000-\u00ff]/.test(char) ? 0.55 : 1), 0),
                  ),
                ) *
                  11 +
                44,
            ),
          )
        : 110;
    relatedGaps.set(step.id, relatedGap);
    const relatedAlong =
      associations.reduce(
        (total, n) => total + (direction === 'tb' ? n.position.height : n.position.width),
        0,
      ) +
      Math.max(0, associations.length - 1) * 36;
    const along = Math.max(direction === 'tb' ? height : width, relatedAlong);
    const cross =
      (direction === 'tb' ? width : height) +
      (associations.length
        ? relatedGap +
          Math.max(...associations.map((n) => (direction === 'tb' ? n.position.width : n.position.height)))
        : 0);
    sizes.set(step.id, { along, cross, rank: 0 });
    for (const child of step.children.filter((child) => child.mode !== 'association')) {
      if (!child.repeated) edges.push({ from: step.id, to: child.id, step: child, loop: false });
      walk(child, depth + 1, [...ancestors, step]);
    }
  };
  walk(root, 0, []);
  // 汇合阶段排在所有前置步骤之后。DFS 深度会把较晚遇到的分支画成倒流。
  const forward = edges.filter((edge) => !edge.loop);
  const incoming = new Map(
    nodes.map((n) => [n.step.id, forward.filter((edge) => edge.to === n.step.id).length]),
  );
  const ready = nodes.filter((n) => incoming.get(n.step.id) === 0).map((n) => n.step.id);
  for (let i = 0; i < ready.length; i++)
    for (const edge of forward.filter((edge) => edge.from === ready[i])) {
      const target = sizes.get(edge.to)!;
      target.rank = Math.max(target.rank, sizes.get(edge.from)!.rank + 1);
      incoming.set(edge.to, incoming.get(edge.to)! - 1);
      if (incoming.get(edge.to) === 0) ready.push(edge.to);
    }
  const paths = edges.filter((edge) => edge.step.mode !== 'association');
  const side = paths.filter(
    (edge) =>
      edge.loop ||
      edge.step.repeated ||
      edge.step.branch ||
      paths.find(
        (candidate) =>
          candidate.from === edge.from &&
          !candidate.step.branch &&
          !candidate.loop &&
          !candidate.step.repeated,
      ) !== edge,
  );
  const afterRank: number[] = [],
    beforeRank: number[] = [];
  for (const edge of side) {
    const outgoing = side.filter((candidate) => candidate.from === edge.from);
    const incoming = side.filter((candidate) => candidate.to === edge.to);
    const mainIncoming = paths.some((candidate) => candidate.to === edge.to && !side.includes(candidate));
    const sourceOffset =
      outgoing.length > 1
        ? outgoing.slice(0, outgoing.indexOf(edge) + 1).reduce((sum, item) => {
            const target = nodes.find((node) => node.step.id === item.to)!.step;
            const lines = [...wrap(item.step.label, 14), ...wrap(`到：${name(target)}`, 14)];
            const extent =
              direction === 'tb'
                ? lines.length * 14 + 6
                : Math.max(
                    ...lines.map((line) =>
                      [...line].reduce((size, char) => size + (/[\u0000-\u00ff]/.test(char) ? 0.55 : 1), 0),
                    ),
                  ) *
                    11 +
                  20;
            return sum + extent + 32;
          }, 0)
        : undefined;
    edge.routing = {
      lane: 0,
      sourcePort: (outgoing.indexOf(edge) + 1) / (outgoing.length + 1),
      targetPort:
        (mainIncoming ? 0.12 : 0.16) +
        ((mainIncoming ? 0.3 : 0.68) * (incoming.indexOf(edge) + 1)) / (incoming.length + 1),
      targetLane: incoming.indexOf(edge),
      sourceOffset,
      sourceDecision: nodes.find((node) => node.step.id === edge.from)!.decision,
      targetDecision: nodes.find((node) => node.step.id === edge.to)!.decision,
    };
    const sourceRank = sizes.get(edge.from)!.rank,
      targetRank = sizes.get(edge.to)!.rank;
    afterRank[sourceRank] = Math.max(afterRank[sourceRank] ?? 0, sourceOffset ?? 0);
    beforeRank[targetRank] = Math.max(beforeRank[targetRank] ?? 0, 24 + incoming.indexOf(edge) * 14);
  }
  const levels: number[] = [];
  for (const size of sizes.values()) levels[size.rank] = Math.max(levels[size.rank] ?? 0, size.along);
  const offsets: number[] = [];
  levels.forEach((value, depth) => {
    offsets[depth] = depth
      ? offsets[depth - 1] +
        levels[depth - 1] +
        Math.max(direction === 'lr' ? 240 : 104, (afterRank[depth - 1] ?? 0) + (beforeRank[depth] ?? 0) + 32)
      : 34;
  });
  // 第一条后续路径与父节点共用轴线，分支只在重叠的层级让位。
  // 这样主线不会因为侧面的对象关联左右摇摆，结束分支也不会占据整列。
  type Packed = { centers: Map<string, number>; contour: Map<number, { left: number; right: number }> };
  const pack = (step: BusinessStep): Packed => {
    const size = sizes.get(step.id)!;
    const item = nodes.find((n) => n.step.id === step.id)!;
    const half = (direction === 'tb' ? item.position.width : item.position.height) / 2;
    const result: Packed = {
      centers: new Map([[step.id, 0]]),
      contour: new Map([[size.rank, { left: -half, right: size.cross - half }]]),
    };
    const children = step.children.filter((child) => !child.repeated && child.mode !== 'association');
    for (const [index, child] of children.entries()) {
      const subtree = pack(child);
      let shift = 0;
      if (index > 0)
        for (const [rank, bounds] of subtree.contour) {
          const occupied = result.contour.get(rank);
          if (occupied) shift = Math.max(shift, occupied.right + 64 - bounds.left);
        }
      for (const [id, center] of subtree.centers) result.centers.set(id, center + shift);
      for (const [rank, bounds] of subtree.contour) {
        const occupied = result.contour.get(rank);
        result.contour.set(rank, {
          left: Math.min(occupied?.left ?? Infinity, bounds.left + shift),
          right: Math.max(occupied?.right ?? -Infinity, bounds.right + shift),
        });
      }
    }
    return result;
  };
  const packed = pack(root);
  const origin = 34 - Math.min(...[...packed.contour.values()].map((bounds) => bounds.left));
  for (const item of nodes) {
    const size = sizes.get(item.step.id)!;
    const depth = size.rank;
    const cross =
      origin +
      packed.centers.get(item.step.id)! -
      (direction === 'tb' ? item.position.width : item.position.height) / 2;
    const nodeAlong = direction === 'tb' ? item.position.height : item.position.width;
    const along = offsets[depth] + (levels[depth] - nodeAlong) / 2;
    item.position.x = direction === 'tb' ? cross : along;
    item.position.y = direction === 'tb' ? along : cross;
    const associations = related.get(item.step.id)!;
    const total =
      associations.reduce((n, a) => n + (direction === 'tb' ? a.position.height : a.position.width), 0) +
      Math.max(0, associations.length - 1) * 36;
    let position = offsets[depth] + (levels[depth] - total) / 2;
    for (const association of associations) {
      association.position.x =
        direction === 'tb'
          ? item.position.x + item.position.width + relatedGaps.get(item.step.id)!
          : position;
      association.position.y =
        direction === 'tb'
          ? position
          : item.position.y + item.position.height + relatedGaps.get(item.step.id)!;
      position += (direction === 'tb' ? association.position.height : association.position.width) + 36;
      edges.push({ from: item.step.id, to: association.step.id, step: association.step, loop: false });
    }
  }
  nodes.push(...[...related.values()].flat());
  // 后续路径从侧面独立引出，不能与主线共用出口或与其他取消路径共用长线。
  // 不相交的区间可以复用外侧通道，避免展开分支后图谱无限变宽。
  const byId = new Map(nodes.map((node) => [node.step.id, node.position]));
  const lanes: { start: number; end: number }[][] = [];
  for (const edge of side) {
    const a = byId.get(edge.from)!,
      b = byId.get(edge.to)!;
    const start =
      direction === 'tb'
        ? a.y + a.height + (edge.routing!.sourceOffset ?? 0)
        : a.x + a.width + (edge.routing!.sourceOffset ?? 0);
    const end =
      direction === 'tb'
        ? b.y - 24 - edge.routing!.targetLane * 14
        : b.x - 24 - edge.routing!.targetLane * 14;
    const span = { start: Math.min(start, end) - 30, end: Math.max(start, end) + 30 };
    let lane = lanes.findIndex((spans) => spans.every((s) => s.end < span.start || s.start > span.end));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(span);
    edge.routing!.lane = lane;
  }
  return {
    nodes,
    edges,
    width: Math.max(...nodes.map((n) => n.position.x + n.position.width)) + 50,
    height: Math.max(...nodes.map((n) => n.position.y + n.position.height)) + 50,
  };
}

const shortEdgeLabel = (label: string) =>
  (
    ({
      '成功后 · 同一事务': '同一事务',
      '成功后 · 异步处理': '异步处理',
      '成功后 · 异步启动审批': '异步启动',
      '成功后 · 异步外部同步': '异步同步',
      审批通过时: '通过',
      审批驳回时: '驳回',
      外部调用成功后回写: '成功回写',
      成功后产生的结果: '产生结果',
      任务声明可调用: '按任务条件调用',
    }) as Record<string, string>
  )[label] ?? label;

/** 连线几何从实时节点位置生成；手动移动节点后，箭头与标签共同跟随。 */
export function flowEdgeGeometry(
  a: FlowPosition,
  b: FlowPosition,
  direction: FlowDirection,
  loop = false,
  obstacles: readonly FlowPosition[] = [],
  routing?: FlowEdgeRouting,
) {
  let path: string, labelX: number, labelY: number;
  let points: FlowPoint[];
  if (direction === 'lr') {
    const forward = b.x + b.width / 2 >= a.x + a.width / 2;
    const x1 = a.x + (forward ? a.width : 0),
      x2 = b.x + (forward ? 0 : b.width);
    const y1 = a.y + a.height / 2,
      y2 = b.y + b.height / 2;
    const middle = (x1 + x2) / 2;
    path = `M${x1},${y1} H${middle} V${y2} H${x2}`;
    points = [
      { x: x1, y: y1 },
      { x: middle, y: y1 },
      { x: middle, y: y2 },
      { x: x2, y: y2 },
    ];
    labelX = middle;
    labelY = y2 - 12;
  } else {
    const forward = b.y + b.height / 2 >= a.y + a.height / 2;
    const x1 = a.x + a.width / 2,
      x2 = b.x + b.width / 2;
    const y1 = a.y + (forward ? a.height : 0),
      y2 = b.y + (forward ? 0 : b.height);
    const middle = (y1 + y2) / 2;
    path = `M${x1},${y1} V${middle} H${x2} V${y2}`;
    points = [
      { x: x1, y: y1 },
      { x: x1, y: middle },
      { x: x2, y: middle },
      { x: x2, y: y2 },
    ];
    labelX = x2;
    labelY = middle - 24;
  }
  const crosses = (points: FlowPoint[], box: FlowPosition) =>
    points.some((point, i) => {
      if (!i) return false;
      const previous = points[i - 1];
      return point.x === previous.x
        ? point.x > box.x &&
            point.x < box.x + box.width &&
            Math.max(point.y, previous.y) > box.y &&
            Math.min(point.y, previous.y) < box.y + box.height
        : point.y > box.y &&
            point.y < box.y + box.height &&
            Math.max(point.x, previous.x) > box.x &&
            Math.min(point.x, previous.x) < box.x + box.width;
    });
  if (routing) {
    const boxes = [...obstacles, a, b];
    if (direction === 'tb') {
      const channel = Math.min(...boxes.map((p) => p.x)) - 190 - routing.lane * 28;
      const source = { x: a.x, y: a.y + a.height * routing.sourcePort };
      const target = { x: b.x + b.width * routing.targetPort, y: b.y };
      if (routing.sourceDecision) source.x += (Math.abs(source.y - a.y - a.height / 2) * a.width) / a.height;
      if (routing.targetDecision) target.y += (Math.abs(target.x - b.x - b.width / 2) * b.height) / b.width;
      const row = boxes.filter((p) => p.y < b.y + b.height && p.y + p.height > b.y);
      const entry = Math.min(...row.map((p) => p.y)) - 24 - routing.targetLane * 14;
      const sourceRow = boxes.filter((p) => p.y < a.y + a.height && p.y + p.height > a.y);
      const exit =
        routing.sourceOffset === undefined
          ? source.y
          : Math.max(...sourceRow.map((p) => p.y + p.height)) + routing.sourceOffset;
      const knee = a.x - 22 - routing.sourcePort * 26;
      points =
        routing.sourceOffset === undefined
          ? [source, { x: channel, y: exit }]
          : [source, { x: knee, y: source.y }, { x: knee, y: exit }, { x: channel, y: exit }];
      if (boxes.some((p) => p !== a && p !== b && crosses(points, p))) {
        const row = boxes.filter((p) => p.y < a.y + a.height && p.y + p.height > a.y);
        const exit = Math.max(...row.map((p) => p.y + p.height)) + Math.max(72, routing.sourceOffset ?? 0);
        points = [
          { x: a.x + a.width / 2, y: a.y + a.height },
          { x: a.x + a.width / 2, y: exit },
          { x: channel, y: exit },
        ];
      }
      const captionStart = points[points.length - 2],
        captionEnd = points[points.length - 1];
      points.push({ x: channel, y: entry }, { x: target.x, y: entry }, target);
      path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
      labelX = (captionStart.x + captionEnd.x) / 2;
      labelY = captionEnd.y;
    } else {
      const channel = Math.min(...boxes.map((p) => p.y)) - 150 - routing.lane * 28;
      const source = { x: a.x + a.width * routing.sourcePort, y: a.y };
      const target = { x: b.x, y: b.y + b.height * routing.targetPort };
      if (routing.sourceDecision) source.y += (Math.abs(source.x - a.x - a.width / 2) * a.height) / a.width;
      if (routing.targetDecision) target.x += (Math.abs(target.y - b.y - b.height / 2) * b.width) / b.height;
      const row = boxes.filter((p) => p.x < b.x + b.width && p.x + p.width > b.x);
      const entry = Math.min(...row.map((p) => p.x)) - 24 - routing.targetLane * 14;
      const sourceRow = boxes.filter((p) => p.x < a.x + a.width && p.x + p.width > a.x);
      const exit =
        routing.sourceOffset === undefined
          ? source.x
          : Math.max(...sourceRow.map((p) => p.x + p.width)) + routing.sourceOffset;
      const knee = a.y - 22 - routing.sourcePort * 26;
      points =
        routing.sourceOffset === undefined
          ? [source, { x: exit, y: channel }]
          : [source, { x: source.x, y: knee }, { x: exit, y: knee }, { x: exit, y: channel }];
      if (boxes.some((p) => p !== a && p !== b && crosses(points, p))) {
        const row = boxes.filter((p) => p.x < a.x + a.width && p.x + p.width > a.x);
        const exit = Math.max(...row.map((p) => p.x + p.width)) + 24;
        points = [
          { x: a.x + a.width, y: a.y + a.height / 2 },
          { x: exit, y: a.y + a.height / 2 },
          { x: exit, y: channel },
        ];
      }
      const captionStart = points[points.length - 2],
        captionEnd = points[points.length - 1];
      points.push({ x: entry, y: channel }, { x: entry, y: target.y }, target);
      path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
      labelX = captionEnd.x;
      labelY = (captionStart.y + captionEnd.y) / 2;
    }
    return { path, labelX, labelY, points, side: true };
  }
  const blocked = obstacles.some((box) => box !== a && box !== b && crosses(points, box));
  if (loop || blocked) {
    // 回路与跨层连线绕到图外，进出横线使用该层的空隙，避免穿过主线和侧面对象。
    const boxes = [...obstacles, a, b];
    if (direction === 'tb') {
      const down = loop || b.y + b.height / 2 >= a.y + a.height / 2;
      const sourceRow = boxes.filter((p) => p.y < a.y + a.height && p.y + p.height > a.y);
      const targetRow = boxes.filter((p) => p.y < b.y + b.height && p.y + p.height > b.y);
      const exit = down
        ? Math.max(...sourceRow.map((p) => p.y + p.height)) + 26
        : Math.min(...sourceRow.map((p) => p.y)) - 26;
      const entry = down
        ? Math.min(...targetRow.map((p) => p.y)) - 26
        : Math.max(...targetRow.map((p) => p.y + p.height)) + 26;
      const side = Math.min(...boxes.map((p) => p.x)) - 48;
      const x1 = a.x + a.width / 2,
        x2 = b.x + b.width / 2;
      const y1 = a.y + (down ? a.height : 0),
        y2 = b.y + (down ? 0 : b.height);
      path = `M${x1},${y1} V${exit} H${side} V${entry} H${x2} V${y2}`;
      points = [
        { x: x1, y: y1 },
        { x: x1, y: exit },
        { x: side, y: exit },
        { x: side, y: entry },
        { x: x2, y: entry },
        { x: x2, y: y2 },
      ];
      labelX = (x1 + side) / 2;
      labelY = exit;
    } else {
      const right = loop || b.x + b.width / 2 >= a.x + a.width / 2;
      const sourceRow = boxes.filter((p) => p.x < a.x + a.width && p.x + p.width > a.x);
      const targetRow = boxes.filter((p) => p.x < b.x + b.width && p.x + p.width > b.x);
      const exit = right
        ? Math.max(...sourceRow.map((p) => p.x + p.width)) + 26
        : Math.min(...sourceRow.map((p) => p.x)) - 26;
      const entry = right
        ? Math.min(...targetRow.map((p) => p.x)) - 26
        : Math.max(...targetRow.map((p) => p.x + p.width)) + 26;
      const side = Math.min(...boxes.map((p) => p.y)) - 48;
      const y1 = a.y + a.height / 2,
        y2 = b.y + b.height / 2;
      const x1 = a.x + (right ? a.width : 0),
        x2 = b.x + (right ? 0 : b.width);
      path = `M${x1},${y1} H${exit} V${side} H${entry} V${y2} H${x2}`;
      points = [
        { x: x1, y: y1 },
        { x: exit, y: y1 },
        { x: exit, y: side },
        { x: entry, y: side },
        { x: entry, y: y2 },
        { x: x2, y: y2 },
      ];
      labelX = exit;
      labelY = (y1 + side) / 2;
    }
  }
  return { path, labelX, labelY, points, side: loop || blocked };
}

/** 箭头同时出现在终点与长线中段，目标在画布之外时也能看出走向。 */
export function flowDirectionArrow(points: readonly FlowPoint[]): string {
  let length = 0,
    start: FlowPoint | undefined,
    end: FlowPoint | undefined;
  for (let i = 1; i < points.length; i++) {
    length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (length >= 140) {
      start = points[i - 1];
      end = points[i];
      break;
    }
  }
  if (!start || !end) return '';
  const dx = (end.x - start.x) / length,
    dy = (end.y - start.y) / length;
  // 箭头离源节点最多 90 个画布单位；终点和长通道在屏幕外时仍能看见方向。
  const distance = Math.min(90, length / 2);
  const x = start.x + dx * distance,
    y = start.y + dy * distance;
  return `${x},${y} ${x - dx * 12 - dy * 6},${y - dy * 12 + dx * 6} ${x - dx * 12 + dy * 6},${y - dy * 12 - dx * 6}`;
}

export function createFlowChart(
  root: BusinessStep,
  options: {
    name: (step: BusinessStep) => string;
    state: (step: BusinessStep) => string;
    direction: FlowDirection;
    selected: string | null;
    view: FlowChartState;
    select: (step: BusinessStep) => void;
    directionChanged: (direction: FlowDirection) => void;
    /** 完整业务图先保证字号可读；全图缩略由用户主动点击“适应”。 */
    readable?: boolean;
    approvals?: ReadonlyMap<string, ApprovalFlow>;
  },
) {
  const ns = 'http://www.w3.org/2000/svg';
  const vector = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
    text = '',
  ) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    node.textContent = text;
    return node;
  };
  const host = document.createElement('section');
  host.className = 'business-flowchart';
  host.setAttribute('aria-label', '业务流程图');
  const toolbar = document.createElement('div');
  toolbar.className = 'flowchart-toolbar';
  const title = document.createElement('strong');
  title.textContent = '业务流程图';
  const controls = document.createElement('div');
  controls.className = 'flowchart-controls';
  const button = (text: string, label: string, run: () => void, parent: HTMLElement = controls) => {
    const node = document.createElement('button');
    node.textContent = text;
    node.title = label;
    node.setAttribute('aria-label', label);
    node.onclick = run;
    parent.append(node);
    return node;
  };
  toolbar.append(title, controls);
  const canvas = document.createElement('div');
  canvas.className = 'flowchart-canvas';
  const svg = vector('svg', { role: 'group', 'aria-label': '可点击的流程节点与方向箭头', tabindex: 0 });
  const defs = vector('defs');
  for (const [id, color] of [
    ['flow-arrow', '#537f60'],
    ['flow-arrow-selected', '#397a56'],
    ['flow-arrow-branch', '#a57950'],
    ['flow-arrow-related', '#8ba28e'],
  ]) {
    const marker = vector('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: id === 'flow-arrow-related' ? 8 : 14,
      markerHeight: id === 'flow-arrow-related' ? 8 : 14,
      markerUnits: 'userSpaceOnUse',
      orient: 'auto-start-reverse',
    });
    marker.append(vector('path', { d: 'M0 0L10 5L0 10z', fill: color }));
    defs.append(marker);
  }
  const viewport = vector('g');
  svg.append(defs, viewport);
  canvas.append(svg);
  const layout = layoutBusinessFlow(root, options.name, options.state, options.direction, options.approvals);
  const obstacles = layout.nodes.map((n) => n.position);
  const defaults = new Map(layout.nodes.map((n) => [n.step.id, { x: n.position.x, y: n.position.y }]));
  for (const item of layout.nodes) Object.assign(item.position, options.view.positions.get(item.step.id));
  const byId = new Map(layout.nodes.map((n) => [n.step.id, n]));
  const targets = new Map<string, BusinessStep>();
  const nodeElements = new Map<string, SVGGElement>();
  const selectedEdge = layout.edges.find((edge) => edge.step.id === options.selected);
  const selectedItem =
    options.selected && (byId.get(options.selected) ?? (selectedEdge && byId.get(selectedEdge.to)));
  const emphasize = (edge?: FlowEdge) => {
    for (const [id, node] of nodeElements) {
      node.classList.toggle('path-source', id === edge?.from);
      node.classList.toggle('path-target', id === edge?.to);
    }
  };
  const edgeViews: { edge: FlowEdge; redraw: () => void }[] = [];
  for (const [index, edge] of layout.edges.entries()) {
    const a = byId.get(edge.from)!.position,
      b = byId.get(edge.to)!.position;
    const active = edge === selectedEdge;
    const group = vector('g', {
      class: `flow-edge${active ? ' selected' : ''}${!options.readable && edge.step.label.includes('异步') ? ' async' : ''}${edge.step.mode === 'association' ? ' association' : ''}${edge.step.branch ? ' branch' : ''}`,
      role: 'button',
      tabindex: 0,
      'aria-label': `${options.name(byId.get(edge.from)!.step)} → ${options.name(edge.step)}：${edge.step.label}`,
      'data-flow-target': `edge:${index}`,
    });
    const edgeDirection =
      edge.step.mode === 'association' ? (options.direction === 'tb' ? 'lr' : 'tb') : options.direction;
    const geometry = flowEdgeGeometry(a, b, edgeDirection, edge.loop, obstacles, edge.routing);
    const approval = byId.get(edge.from)!.approval;
    const rejection = approval && isApprovalRejection(approval.flow, edge.step);
    const actor = byId.get(edge.to)!.step.node.attrs.actor;
    const caption = (rejection ? '任一步骤驳回' : shortEdgeLabel(edge.step.label)).replace(
      /^人工 · /,
      actor ? `${actor} · ` : '人工 · ',
    );
    const captionLines = [
      ...wrap(caption, edge.routing ? 14 : 20),
      ...(edge.routing
        ? wrap(`${edge.loop ? '回到' : '到'}：${options.name(byId.get(edge.to)!.step)}`, 14)
        : []),
    ];
    const width =
      Math.max(
        ...captionLines.map((line) =>
          [...line].reduce((length, char) => length + (/[\u0000-\u00ff]/.test(char) ? 0.55 : 1), 0),
        ),
      ) *
        11 +
      20;
    const height = captionLines.length * 14 + 6;
    const captionPosition = (geometry: ReturnType<typeof flowEdgeGeometry>) => {
      if (geometry.side)
        return edgeDirection === 'tb'
          ? { x: geometry.labelX, y: geometry.labelY - height / 2 - 9 }
          : {
              x: geometry.labelX + (edge.routing?.sourceOffset === undefined ? 1 : -1) * (width / 2 + 12),
              y: geometry.labelY,
            };
      const start = geometry.points[0],
        end = geometry.points[geometry.points.length - 1];
      return edgeDirection === 'tb'
        ? { x: Math.max(start.x, end.x) + width / 2 + 12, y: (start.y + end.y) / 2 }
        : { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - height / 2 - 9 };
    };
    const position = captionPosition(geometry);
    const marker = active
      ? 'flow-arrow-selected'
      : edge.step.mode === 'association'
        ? 'flow-arrow-related'
        : edge.step.branch
          ? 'flow-arrow-branch'
          : 'flow-arrow';
    const hit = vector('path', { d: geometry.path, class: 'flow-edge-hit' });
    const line = vector('path', {
      d: geometry.path,
      class: 'flow-edge-line',
      'marker-end': `url(#${marker})`,
    });
    const arrow = vector('polygon', {
      points: edge.step.mode === 'association' ? '' : flowDirectionArrow(geometry.points),
      class: 'flow-edge-direction',
      'aria-hidden': 'true',
    });
    const captionGroup = vector('g', { transform: `translate(${position.x},${position.y})` });
    const box = vector('rect', {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
      rx: 4,
      class: 'flow-edge-label-box',
    });
    const label = vector('text', { 'text-anchor': 'middle', class: 'flow-edge-label' });
    captionLines.forEach((text, index) =>
      label.append(vector('tspan', { x: 0, y: 4 + (index - (captionLines.length - 1) / 2) * 14 }, text)),
    );
    captionGroup.append(box, label);
    const arrival = edge.loop ? vector('g', { class: 'flow-edge-arrival' }) : undefined;
    if (arrival) {
      const text = `来自：${options.name(byId.get(edge.from)!.step)}`;
      const lines = wrap(text, 18);
      const width = Math.max(...lines.map((line) => [...line].length)) * 11 + 16;
      const height = lines.length * 14 + 6;
      arrival.append(
        vector('rect', { x: -width / 2, y: -height / 2, width, height, rx: 4, class: 'flow-edge-label-box' }),
      );
      const label = vector('text', { 'text-anchor': 'middle', class: 'flow-edge-label' });
      lines.forEach((line, index) =>
        label.append(vector('tspan', { x: 0, y: 4 + (index - (lines.length - 1) / 2) * 14 }, line)),
      );
      arrival.append(label);
    }
    const moveArrival = (geometry: ReturnType<typeof flowEdgeGeometry>) => {
      if (!arrival) return;
      const a = geometry.points[geometry.points.length - 3],
        b = geometry.points[geometry.points.length - 2];
      arrival.setAttribute(
        'transform',
        edgeDirection === 'tb'
          ? `translate(${(a.x + b.x) / 2},${b.y - 20})`
          : `translate(${b.x + 30},${(a.y + b.y) / 2})`,
      );
    };
    moveArrival(geometry);
    group.append(
      vector(
        'title',
        {},
        `从 ${options.name(byId.get(edge.from)!.step)} 到 ${options.name(byId.get(edge.to)!.step)}：${edge.step.label}${edge.step.note ? `。${edge.step.note}` : ''}`,
      ),
      hit,
      line,
      arrow,
      captionGroup,
    );
    if (arrival) group.append(arrival);
    edgeViews.push({
      edge,
      redraw: () => {
        const geometry = flowEdgeGeometry(a, b, edgeDirection, edge.loop, obstacles, edge.routing);
        const position = captionPosition(geometry);
        hit.setAttribute('d', geometry.path);
        line.setAttribute('d', geometry.path);
        arrow.setAttribute(
          'points',
          edge.step.mode === 'association' ? '' : flowDirectionArrow(geometry.points),
        );
        moveArrival(geometry);
        captionGroup.setAttribute('transform', `translate(${position.x},${position.y})`);
      },
    });
    const targetStep = edge.step;
    group.onpointerenter = () => emphasize(edge);
    group.onpointerleave = () => emphasize(selectedEdge);
    group.onfocus = () => emphasize(edge);
    group.onblur = () => emphasize(selectedEdge);
    targets.set(`edge:${index}`, targetStep);
    group.onclick = (event) => {
      if (event.detail === 0) options.select(targetStep);
    };
    group.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        options.select(targetStep);
      }
    };
    viewport.append(group);
  }
  for (const item of layout.nodes) {
    const { step, position: p, decision } = item;
    const group = vector('g', {
      class: `flow-node${step.id === options.selected ? ' selected' : ''}${decision ? ' decision' : ''}${item.association ? ' association' : ''}${item.approval ? ' approval-subflow' : ''}`,
      transform: `translate(${p.x},${p.y})`,
      role: 'button',
      tabindex: 0,
      'aria-label': `${item.approval ? '审批子流程' : decision ? '审批分支' : '业务步骤'} ${options.name(step)}，点击查看说明与代码`,
      'data-step': step.id,
      'data-flow-target': step.id,
      'aria-pressed': String(step.id === options.selected),
    });
    group.append(vector('title', {}, `${options.name(step)}\n${step.note}\n点击查看业务说明与实现代码`));
    if (decision)
      group.append(
        vector('path', {
          d: `M${p.width / 2},0 L${p.width},${p.height / 2} L${p.width / 2},${p.height} L0,${p.height / 2}Z`,
          class: 'flow-node-shape',
        }),
      );
    else
      group.append(
        vector('rect', {
          width: p.width,
          height: p.height,
          rx:
            step.node.kind === 'event' || step.node.attrs.stageKind === 'end' || step.node.attrs.terminal
              ? 32
              : 9,
          class: 'flow-node-shape',
        }),
      );
    if (item.approval) group.append(renderApprovalFlow(item.approval));
    const textY = decision ? p.height / 2 - (item.title.length - 1) * 11 + 4 : 34;
    if (!item.approval)
      item.title.forEach((line, index) =>
        group.append(
          vector(
            'text',
            { x: p.width / 2, y: textY + index * 22, 'text-anchor': 'middle', class: 'flow-node-title' },
            line,
          ),
        ),
      );
    if (!decision && !item.approval)
      item.state.forEach((line, index) =>
        group.append(
          vector(
            'text',
            {
              x: p.width / 2,
              y: 34 + item.title.length * 22 + index * 16,
              'text-anchor': 'middle',
              class: 'flow-node-state',
            },
            line,
          ),
        ),
      );
    if (step.boundary)
      group.append(
        vector(
          'text',
          { x: p.width / 2, y: p.height - 10, 'text-anchor': 'middle', class: 'flow-node-boundary' },
          '后续已收起 · 点击继续查看',
        ),
      );
    targets.set(step.id, step);
    nodeElements.set(step.id, group);
    group.onclick = (event) => {
      if (event.detail === 0) options.select(step);
    };
    group.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        options.select(step);
      }
    };
    viewport.append(group);
  }
  emphasize(selectedEdge);
  const view = options.view,
    camera = view.camera;
  const zoomControls = document.createElement('div');
  zoomControls.className = 'flowchart-zoom';
  zoomControls.setAttribute('role', 'toolbar');
  zoomControls.setAttribute('aria-label', '画布缩放与布局');
  canvas.append(zoomControls);
  const shrink = button('−', '缩小流程图', () => zoom(1 / 1.2), zoomControls);
  const percentage = button('100%', '还原100%缩放', () => zoom(1 / camera.scale), zoomControls);
  percentage.className = 'flowchart-percentage';
  const grow = button('＋', '放大流程图', () => zoom(1.2), zoomControls);
  button('适应', '适应流程画布', () => fit(), zoomControls);
  button(
    '重排',
    '重置节点布局',
    () => {
      view.positions.clear();
      for (const item of layout.nodes) {
        Object.assign(item.position, defaults.get(item.step.id));
        nodeElements
          .get(item.step.id)!
          .setAttribute('transform', `translate(${item.position.x},${item.position.y})`);
      }
      for (const edge of edgeViews) edge.redraw();
      fit();
    },
    zoomControls,
  );
  const apply = () => {
    viewport.setAttribute('transform', `translate(${camera.x},${camera.y}) scale(${camera.scale})`);
    percentage.textContent = `${Math.round(camera.scale * 100)}%`;
    percentage.title = `当前 ${percentage.textContent} · 点击还原 100%`;
    shrink.disabled = camera.scale <= MIN_FLOW_ZOOM;
    grow.disabled = camera.scale >= MAX_FLOW_ZOOM;
    const grid = Math.max(10, 24 * camera.scale);
    canvas.style.backgroundSize = `${grid}px ${grid}px`;
    canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  };
  const fit = () => {
    // 手动移动后的节点也必须进入“适应”范围，包括移到原点左侧的节点。
    const bounds = viewport.getBBox();
    const left = bounds.x - 36,
      top = bounds.y - 36;
    const width = bounds.width + 106,
      height = bounds.height + 106;
    camera.scale = Math.max(
      MIN_FLOW_ZOOM,
      Math.min(1, (canvas.clientWidth - 32) / width, (canvas.clientHeight - 72) / height),
    );
    camera.x = (canvas.clientWidth - width * camera.scale) / 2 - left * camera.scale;
    camera.y = (canvas.clientHeight - height * camera.scale) / 2 - top * camera.scale - 16;
    camera.initialized = true;
    camera.width = canvas.clientWidth;
    camera.height = canvas.clientHeight;
    apply();
  };
  const readStart = () => {
    const start = byId.get(root.id)!.position;
    camera.scale = 0.9;
    camera.x =
      options.direction === 'tb'
        ? canvas.clientWidth / 2 - (start.x + start.width / 2) * camera.scale
        : 36 - start.x * camera.scale;
    camera.y =
      options.direction === 'tb'
        ? 30 - start.y * camera.scale
        : canvas.clientHeight / 2 - (start.y + start.height / 2) * camera.scale;
    camera.initialized = true;
    camera.width = canvas.clientWidth;
    camera.height = canvas.clientHeight;
    apply();
  };
  if (options.readable) button('起点', '以可读字号回到流程起点', readStart, zoomControls);
  // 保存画布尺寸而非 DOM 实例：切到其他视图时仍可能调整窗口大小。
  const resize = () => {
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (camera.width === width && camera.height === height) return;
    camera.x += (width - (camera.width ?? width)) / 2;
    camera.y += (height - (camera.height ?? height)) / 2;
    camera.width = width;
    camera.height = height;
    if (selectedItem) revealFlowPosition(camera, selectedItem.position);
    apply();
  };
  const zoom = (factor: number, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) => {
    zoomFlowCamera(camera, camera.scale * factor, { x, y });
    apply();
  };
  let space = false;
  const tools = new Map<'select' | 'pan', HTMLButtonElement>();
  const updateTool = () => {
    canvas.classList.toggle('mode-pan', view.tool === 'pan' || space);
    for (const [tool, node] of tools) node.setAttribute('aria-pressed', String(view.tool === tool));
  };
  for (const [tool, text] of [
    ['select', '选择'],
    ['pan', '抓手'],
  ] as const) {
    tools.set(
      tool,
      button(text, tool === 'select' ? '选择或拖动节点' : '抓手：拖动任意位置平移', () => {
        view.tool = tool;
        updateTool();
      }),
    );
  }
  for (const direction of ['tb', 'lr'] as const) {
    const node = button(
      direction === 'tb' ? '↓ 纵向' : '→ 横向',
      direction === 'tb' ? '从上到下排列流程' : '从左到右排列流程',
      () => options.directionChanged(direction),
    );
    node.setAttribute('aria-pressed', String(options.direction === direction));
  }
  const expanded = button('展开画布', '展开画布', () => expand(!view.expanded));
  const expand = (value: boolean) => {
    view.expanded = value;
    host.parentElement?.classList.toggle('expanded', value);
    expanded.textContent = value ? '退出展开' : '展开画布';
    expanded.setAttribute('aria-label', value ? '退出展开画布' : '展开画布');
    expanded.title = value ? '退出展开画布（Esc）' : '展开画布';
    expanded.setAttribute('aria-pressed', String(value));
  };
  const localPoint = (event: MouseEvent | PointerEvent | WheelEvent) => {
    const bounds = svg.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const gestures = createFlowGestures(camera, {
    position: (id) => byId.get(id)!.position,
    move: (id, point) => {
      Object.assign(byId.get(id)!.position, point);
      view.positions.set(id, { ...point });
      nodeElements.get(id)!.setAttribute('transform', `translate(${point.x},${point.y})`);
      // 移动的节点也可能是别的连线需要避让的对象。
      for (const edge of edgeViews) edge.redraw();
    },
    activate: (target) => options.select(targets.get(target)!),
    changed: apply,
  });
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    svg.focus({ preventScroll: true });
    const target = (event.target as Element).closest('[data-flow-target]');
    gestures.start({
      id: event.pointerId,
      point: localPoint(event),
      touch: event.pointerType === 'touch',
      pan: view.tool === 'pan' || space || event.button === 1,
      node: target?.classList.contains('flow-node') ? target.getAttribute('data-step')! : undefined,
      target: target?.getAttribute('data-flow-target') ?? undefined,
    });
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('interacting');
  });
  svg.addEventListener('pointermove', (event) => {
    gestures.move(event.pointerId, localPoint(event));
  });
  const stop = (event: PointerEvent) => {
    gestures.end(event.pointerId, event.type !== 'pointerup');
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    svg.classList.remove('interacting');
  };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
  svg.addEventListener('lostpointercapture', stop);
  // 指针点击由手势结束统一处理；辅助技术的无指针 click 仍由节点响应。
  svg.addEventListener(
    'click',
    (event) => {
      if (event.detail > 0) event.stopPropagation();
    },
    true,
  );
  svg.addEventListener('dragstart', (event) => event.preventDefault());
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      wheelFlowCamera(camera, event, localPoint(event));
      apply();
    },
    { passive: false },
  );
  svg.addEventListener('keydown', (event) => {
    if ((event.target as Element).closest('.flow-node,.flow-edge')) return;
    const move: Record<string, FlowPoint> = {
      ArrowLeft: { x: 50, y: 0 },
      ArrowRight: { x: -50, y: 0 },
      ArrowUp: { x: 0, y: 50 },
      ArrowDown: { x: 0, y: -50 },
    };
    if (move[event.key]) {
      event.preventDefault();
      camera.x += move[event.key].x;
      camera.y += move[event.key].y;
      apply();
    } else if (['+', '=', '-', '0', '1'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') fit();
      else zoom(event.key === '1' ? 1 / camera.scale : event.key === '-' ? 1 / 1.2 : 1.2);
    }
  });
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && view.expanded) {
      event.preventDefault();
      expand(false);
    }
    if (
      event.code !== 'Space' ||
      event.defaultPrevented ||
      (event.target as Element).closest('button,input,textarea,[contenteditable],.flow-node,.flow-edge')
    )
      return;
    if (canvas.matches(':hover') || canvas.contains(document.activeElement)) {
      event.preventDefault();
      space = true;
      updateTool();
    }
  };
  const releaseSpace = () => {
    space = false;
    updateTool();
  };
  const keyup = (event: KeyboardEvent) => {
    if (event.code === 'Space') releaseSpace();
  };
  const footer = document.createElement('div');
  footer.className = 'flowchart-footer';
  const hint = document.createElement('span');
  hint.textContent = '滚轮缩放 · 空白处拖动平移 · 节点可拖动 · 按住空格使用抓手';
  const legend = document.createElement('span');
  legend.textContent = options.readable
    ? '箭头：下一步　棕线：展开的其他分支　虚线：涉及对象'
    : '箭头：后续处理　虚线：异步';
  footer.append(hint, legend);
  host.append(toolbar, canvas, footer);
  let observer: ResizeObserver | undefined;
  return {
    element: host,
    mount() {
      expand(view.expanded);
      updateTool();
      if (!camera.initialized) {
        if (options.readable) readStart();
        else fit();
      } else resize();
      if (selectedItem && options.selected !== view.selection)
        revealFlowPosition(camera, selectedItem.position);
      view.selection = options.selected;
      apply();
      // 查看详情、切换代码页签和调整窗口只改变可用空间，保留用户的缩放与布局。
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      document.addEventListener('keydown', keydown);
      document.addEventListener('keyup', keyup);
      window.addEventListener('blur', releaseSpace);
    },
    dispose() {
      observer?.disconnect();
      gestures.cancel();
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', releaseSpace);
    },
  };
}
