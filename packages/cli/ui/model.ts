/**
 * 浏览器图谱的颜色、节点尺寸与确定性布局适配，语义与检索复用 src 共享模块。
 * 小聚焦图按入边/出边排布，大图按类型平衡分列后迭代邻接排序，连线根据实际坐标生成。
 * 不使用随机力导向或远程图形服务；位置只是页面展示，不能据几何距离推断业务关系。
 */
// 页面只保留颜色、布局和筛选；语义投影由 Web 与 CLI 共用。
import type { NodeKind } from '../src/ontology.js';
import { kindLabels, type ViewNode, type ViewEdge } from '../src/graph-model.js';
export { nodeLabel, projectGraph, neighborhood, edgeLabels } from '../src/graph-model.js';
export type { ViewNode, ViewEdge, GraphModel } from '../src/graph-model.js';
export { matchesNode } from '../src/graph-search.js';
/**
 * 节点类型对应的中文标签、颜色、短字和布局列优先级；只影响图谱呈现。
 */
export const kinds: Record<
  NodeKind | 'entry',
  { label: string; color: string; short: string; column: number }
> = {
  aggregate: { label: kindLabels.aggregate, color: '#197c72', short: '表', column: 0 },
  command: { label: kindLabels.command, color: '#547db2', short: '令', column: 1 },
  event: { label: kindLabels.event, color: '#c08c36', short: '事', column: 2 },
  reaction: { label: kindLabels.reaction, color: '#aa7288', short: '应', column: 3 },
  query: { label: kindLabels.query, color: '#648c5b', short: '查', column: 1 },
  approval: { label: kindLabels.approval, color: '#9c739f', short: '审', column: 3 },
  route: { label: kindLabels.route, color: '#9c739f', short: '路', column: 3 },
  job: { label: kindLabels.job, color: '#7f82a0', short: '时', column: 0 },
  connector: { label: kindLabels.connector, color: '#b57452', short: '连', column: 4 },
  outbound: { label: kindLabels.outbound, color: '#b57452', short: '出', column: 3 },
  inbound: { label: kindLabels.inbound, color: '#b57452', short: '入', column: 4 },
  field: { label: kindLabels.field, color: '#67998f', short: '字', column: 1 },
  state: { label: kindLabels.state, color: '#898b69', short: '态', column: 2 },
  capability: { label: kindLabels.capability, color: '#81949f', short: '权', column: 1 },
  entry: { label: kindLabels.entry, color: '#89938e', short: '+', column: 0 },
  process: { label: kindLabels.process, color: '#397a56', short: '流', column: 0 },
  stage: { label: kindLabels.stage, color: '#648c5b', short: '段', column: 1 },
};

/**
 * 按组织聚合前缀识别默认隐藏对象，不是能力或租户授权判断。
 */
export const isSystem = (node: ViewNode) => /^(User|Role|Dept)(\.|$)/.test(node.id);
/**
 * 缩放前的二维画布坐标，单位为 SVG 用户单位，屏幕显示再经相机变换。
 */
export interface Position {
  /** 缩放前节点左上角的水平画布坐标。 */
  x: number;
  /** 缩放前节点左上角的垂直画布坐标。 */
  y: number;
}
/**
 * 完整本体普通节点的固定宽度，单位为画布单位，与 edgePath 端点计算保持一致。
 */
export const NODE_WIDTH = 190;
/**
 * 完整本体普通节点高度，单位为画布单位；对象字段卡片使用独立动态高度。
 */
export const NODE_HEIGHT = 56;

/** 按类型分组的平衡列 + 邻接排序。相同声明每次打开位置相同，没有持续运动的力导向
 * 动画；读长名称、比较刷新前后的关系时不会被随机布局打断。 */
/**
 * 按语义列与邻接平均纵坐标计算确定性位置，避免随机布局干扰阅读。
 * @param nodes 可见节点，不修改原数组。
 * @param edges 可见关系。
 * @param focusKey 小于等于 12 节点时以该节点作为中间列。
 * @returns 节点 key 到坐标映射；没有持续动画或 DOM 副作用。
 */
export function layoutGraph(
  nodes: ViewNode[],
  edges: ViewEdge[],
  focusKey?: string | null,
): Map<string, Position> {
  const positions = new Map<string, Position>();
  // 小范围聚焦按关系方向排布：依赖方在左、当前节点居中、目标在右。
  // 大图继续使用平衡列，避免高连接度聚合把所有邻居挤成一条长列。
  if (focusKey && nodes.some((n) => n.key === focusKey) && nodes.length <= 12) {
    positions.set(focusKey, { x: 330, y: 0 });
    const incoming = new Set(edges.filter((e) => e.to === focusKey).map((e) => e.from));
    const neighbors = nodes.filter((n) => n.key !== focusKey);
    for (const [column, items] of [
      neighbors.filter((n) => incoming.has(n.key)),
      neighbors.filter((n) => !incoming.has(n.key)),
    ].entries()) {
      items.forEach((n, row) =>
        positions.set(n.key, { x: column * 660, y: (row - (items.length - 1) / 2) * 105 }),
      );
    }
    return positions;
  }
  // 命令通常远多于其他节点；强制“一类一列”会形成极长列，适应画布后字体
  // 小到无法阅读。保持语义排序，再均衡分列，让概览尽量利用二维空间。
  const ordered = [...nodes].sort(
    (a, b) => kinds[a.kind].column - kinds[b.kind].column || a.id.localeCompare(b.id),
  );
  const columnCount = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(nodes.length / 1.6))));
  const perColumn = Math.ceil(nodes.length / columnCount);
  const columns = Array.from({ length: columnCount }, (_, i) =>
    ordered.slice(i * perColumn, (i + 1) * perColumn),
  );
  const place = () =>
    columns.forEach((items, column) =>
      items.forEach((n, row) => {
        positions.set(n.key, { x: column * 330, y: (row - (items.length - 1) / 2) * 105 });
      }),
    );
  place();
  // 只做排序，节点仍各占一行；邻居平均纵坐标让同一业务链尽量接近。
  for (let pass = 0; pass < 4; pass++) {
    for (const items of columns) {
      const score = (node: ViewNode) => {
        const ys = edges
          .filter((e) => e.from === node.key || e.to === node.key)
          .map((e) => positions.get(e.from === node.key ? e.to : e.from)?.y)
          .filter((y): y is number => y !== undefined);
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      };
      items.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
      place();
    }
  }
  return positions;
}

/**
 * 根据两个普通节点位置绘制曲线，同列及自环从侧面绕行。
 * @param from 起点左上角。
 * @param to 终点左上角。
 * @param self 是否自环。
 * @returns SVG d 属性，不绘制或修改节点。
 */
export function edgePath(from: Position, to: Position, self: boolean): string {
  if (self)
    return `M${from.x + NODE_WIDTH - 25},${from.y} C${from.x + NODE_WIDTH + 50},${from.y - 65} ${from.x + NODE_WIDTH + 50},${from.y + 100} ${from.x + NODE_WIDTH - 25},${from.y + NODE_HEIGHT}`;
  // 同列关系从右侧绕行，给标签留出空间，也避免穿过中间节点。
  if (from.x === to.x) {
    const x = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2,
      y2 = to.y + NODE_HEIGHT / 2;
    const bend = 110 + Math.abs(y2 - y1) * 0.12;
    return `M${x},${y1} C${x + bend},${y1} ${x + bend},${y2} ${x},${y2}`;
  }
  const forward = to.x >= from.x;
  const x1 = from.x + (forward ? NODE_WIDTH : 0),
    x2 = to.x + (forward ? 0 : NODE_WIDTH);
  const y1 = from.y + NODE_HEIGHT / 2,
    y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(60, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
