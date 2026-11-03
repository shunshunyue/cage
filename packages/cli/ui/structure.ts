import type { GraphModel, Position, ViewEdge, ViewNode } from './model.js';

export const TABLE_WIDTH = 336;
export const TABLE_HEADER = 58;
export const TABLE_ROW = 38;
export const TABLE_FOOTER = 34;

export interface TableCard {
  node: ViewNode;
  fields: ViewNode[];
  height: number;
}

/** 对象卡片展示声明字段，而不是猜测完整数据库结构。系统自动添加的列不在
 * 抽取结果中，因此这里不补造 id 或主键。集合关系也留在 fields 中展示，
 * 用类型和虚拟关系标记区分物理列，基数来自抽取器明确记录的声明。
 * 字段仍保留原节点身份，搜索、点击和关系解释都能回到同一份声明。 */
export function tableCards(model: GraphModel): TableCard[] {
  return model.nodes
    .filter((n) => n.kind === 'aggregate')
    .map((node) => {
      const fieldKeys = model.edges.filter((e) => e.kind === 'field' && e.from === node.key).map((e) => e.to);
      const fields = fieldKeys.map((key) => model.nodes.find((n) => n.key === key)!);
      return { node, fields, height: TABLE_HEADER + fields.length * TABLE_ROW + TABLE_FOOTER };
    });
}

/** 用真实字段归属解析端点；不能把两个同名字段合并，也不能把命令算成列。 */
export function tableOwner(cards: TableCard[], key: string): TableCard | undefined {
  return cards.find((card) => card.node.key === key || card.fields.some((field) => field.key === key));
}

/** 关联较多的对象优先放置，再按实际卡片高度分配到最短列。
 * 两列上限保持字段字可读；卡片高度由字段数决定，避免固定网格裁掉长表。 */
export function layoutTables(cards: TableCard[], edges: ViewEdge[], columns: number): Map<string, Position> {
  const positions = new Map<string, Position>();
  const heights = Array.from({ length: Math.min(columns, cards.length) }, () => 0);
  const degree = (card: TableCard) =>
    edges.filter((e) => e.to === card.node.key || card.fields.some((f) => f.key === e.from)).length;
  const ordered = [...cards].sort(
    (a, b) => degree(b) - degree(a) || b.height - a.height || a.node.id.localeCompare(b.node.id),
  );
  for (const card of ordered) {
    const column = heights.indexOf(Math.min(...heights));
    positions.set(card.node.key, { x: column * (TABLE_WIDTH + 155), y: heights[column]! });
    heights[column]! += card.height + 84;
  }
  return positions;
}

/** 引用线从具体字段行连接到目标对象表头。端点随卡片拖动一起计算，
 * 不把整张卡片的中心当成字段位置；同列时从侧边绕开表体。 */
export function tableEdgePath(edge: ViewEdge, cards: TableCard[], positions: Map<string, Position>): string {
  const source = tableOwner(cards, edge.from)!;
  const target = tableOwner(cards, edge.to)!;
  const from = positions.get(source.node.key)!;
  const to = positions.get(target.node.key)!;
  const row = source.fields.findIndex((f) => f.key === edge.from);
  const y1 = from.y + TABLE_HEADER + row * TABLE_ROW + TABLE_ROW / 2;
  const y2 = to.y + TABLE_HEADER / 2;
  if (from.x === to.x) {
    const x = from.x + TABLE_WIDTH;
    const bend = 88 + row * 14;
    return `M${x},${y1} C${x + bend},${y1} ${x + bend},${y2} ${x},${y2}`;
  }
  const forward = to.x > from.x;
  const x1 = from.x + (forward ? TABLE_WIDTH : 0);
  const x2 = to.x + (forward ? 0 : TABLE_WIDTH);
  const bend = Math.max(65, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}

export function fieldType(field: ViewNode): string {
  const types: Record<string, string> = {
    text: '文本',
    int: '整数',
    money: '金额',
    decimal: '小数',
    float: '浮点数',
    bool: '布尔',
    boolean: '布尔',
    id: '标识',
    ref: '引用',
    hasMany: '一对多',
    manyToMany: '多对多',
    file: '文件',
    files: '多文件',
    list: '列表',
    json: 'JSON',
    date: '日期',
    datetime: '时间',
    enum: '枚举',
  };
  return types[String(field.attrs.kind)] ?? String(field.attrs.kind);
}
