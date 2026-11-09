/**
 * 对象与字段视图的卡片测量、布局和引用连线工具，供 app 渲染数据字典。
 * 按本体 field 边收集真实声明字段，卡片高度随字段数变化，关联从具体字段行连至目标表头。
 * 不推测数据库隐藏列，不把虚拟集合关系当物理列；坐标为缩放前画布单位，拖动时重新计算路径。
 */
import type { GraphModel, Position, ViewEdge, ViewNode } from './model.js';

/**
 * 字段卡片固定宽度，单位为画布单位；布局与引用线共享该值。
 */
export const TABLE_WIDTH = 336;
/**
 * 字段卡片标题区高度，引用目标连接到其中心。
 */
export const TABLE_HEADER = 58;
/**
 * 单字段行高度，字段引用起点用此值定位行中心。
 */
export const TABLE_ROW = 38;
/**
 * 字段卡片尾部留白高度，与动态字段数一起确定总高。
 */
export const TABLE_FOOTER = 34;

/**
 * 聚合与其显式字段的卡片投影，height 为测量高度，不表示数据库表真实行数。
 */
export interface TableCard {
  /** 卡片对应的聚合展示节点，保留完整 key。 */
  node: ViewNode;
  /** 通过显式 field 关系归属的字段，保持声明顺序。 */
  fields: ViewNode[];
  /** 按表头、字段行和页脚计算的缩放前高度。 */
  height: number;
}

/** 对象卡片展示声明字段，而不是猜测完整数据库结构。系统自动添加的列不在
 * 抽取结果中，因此这里不补造 id 或主键。集合关系也留在 fields 中展示，
 * 用类型和虚拟关系标记区分物理列，基数来自抽取器明确记录的声明。
 * 字段仍保留原节点身份，搜索、点击和关系解释都能回到同一份声明。 */
/**
 * 沿 field 边收集聚合声明字段并计算卡片高度，不补造系统列。
 * @param model 展示图。
 * @returns 所有聚合卡片，虚拟关系仍作为声明字段展示。
 */
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
/**
 * 通过完整 key 找到聚合或字段所属卡片。
 * @param cards 卡片列表。
 * @param key 聚合或字段身份。
 * @returns 匹配卡片或 undefined，命令不会被当字段。
 */
export function tableOwner(cards: TableCard[], key: string): TableCard | undefined {
  return cards.find((card) => card.node.key === key || card.fields.some((field) => field.key === key));
}

/** 关联较多的对象优先放置，再按实际卡片高度分配到最短列。
 * 两列上限保持字段字可读；卡片高度由字段数决定，避免固定网格裁掉长表。 */
/**
 * 优先放置关系多且较高的卡片，再将每张卡放入当前最短列。
 * @param cards 卡片数组，不修改。
 * @param edges 引用关系，用于连接度排序。
 * @param columns 调用方按可用宽度给出的列数。
 * @returns 卡片坐标映射，未连接数据库或保存布局。
 */
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
/**
 * 从具体字段行中心连接到目标卡片表头，随拖动位置实时计算。
 * @param edge 已确认有效的字段引用边。
 * @param cards 可见卡片。
 * @param positions 卡片坐标。
 * @returns SVG 曲线路径，同列侧绕避免穿过表体。
 */
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

/**
 * 将已抽取字段 kind 显示为中文类型。
 * @param field 字段节点。
 * @returns 已知中文类型或原 kind，不推断数据库实际类型。
 */
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
