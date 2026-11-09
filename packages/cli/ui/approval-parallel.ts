/**
 * 结构化审批树的纯 SVG 布局：顺序串接、条件旁路及 AND 并行分叉/汇合递归组合。
 * 分支占独立横向通道，下一步只连接汇合出口；图只解释声明，不表示实例执行顺序或当前完成状态。
 * 各子图先测量后平移，长标题和嵌套宽度都进入外层布局，避免把并行关系压平为串行或框外裁切。
 */
import type { ApprovalFlow, ApprovalGroup, ApprovalTask } from '../src/graph-approvals.js';
import { wrapApprovalText, type ApprovalBox, type ApprovalFlowLayout } from './approval-flow.js';

/** 子树的单入口/单出口几何；结构化 AND 保证可以作为后续顺序节点的一块整体组合。 */
interface Fragment {
  width: number;
  height: number;
  /** 所有入口/出口沿本片段中心轴，坐标为相对片段左上角的 SVG 单位。 */
  axis: number;
  boxes: ApprovalBox[];
  paths: ApprovalFlowLayout['paths'];
  merges: ApprovalFlowLayout['merges'];
}

/** 创建空容器；空条件分支仍有一条可连接直线，不假造审批节点或已经运行的票。 */
function fragment(width = 348, height = 0): Fragment {
  return { width, height, axis: width / 2, boxes: [], paths: [], merges: [] };
}

/**
 * 把已测量子图复制平移到父图，路径坐标只由本模块产生的 M/L/H/V 绝对指令转换。
 * 不改源片段，递归兄弟分支共享文本对象也不会互相污染；标题与输入不拼入 SVG path。
 */
function append(parent: Fragment, child: Fragment, dx: number, dy: number): void {
  parent.boxes.push(...child.boxes.map(box => ({ ...box, x: box.x + dx, y: box.y + dy })));
  for (const path of child.paths) parent.paths.push({ ...path,
    d: path.d.replace(/([ML])(-?[\d.]+),(-?[\d.]+)|([HV])(-?[\d.]+)/g, (_match, point: string, x: string, y: string, axis: string, value: string) =>
      point ? `${point}${Number(x) + dx},${Number(y) + dy}` : `${axis}${Number(value) + (axis === 'H' ? dx : dy)}`),
    ...(path.x === undefined ? {} : { x: path.x + dx }), ...(path.y === undefined ? {} : { y: path.y + dy }) });
  parent.merges.push(...child.merges.map(point => ({ x: point.x + dx, y: point.y + dy })));
}

/** 把一个审批叶节点测量成普通任务框；编号只是声明定位，不决定并行分支的实际运行顺序。 */
function taskFragment(task: ApprovalTask): Fragment {
  const title = wrapApprovalText(task.title, 14), actor = wrapApprovalText(`审批人：${task.actor}`, 19), rule = wrapApprovalText(task.rule, 18);
  const height = 18 + title.length * 18 + actor.length * 16 + rule.length * 16, result = fragment(348, height);
  result.boxes.push({ kind: 'task', x: 50, y: 0, width: 248, height, title, actor, rule, task });
  return result;
}

/** 各顺序子片段在最大宽度中心对齐，连接只经过相邻片段之间的空隙。 */
function sequence(parts: Fragment[]): Fragment {
  // 条件旁路使子图左右不对称，按中心轴两侧的最大占用测量，不能只取原始 width 后居中导致右侧越界。
  const result = fragment(Math.max(348, ...parts.map(part => 2 * Math.max(part.axis, part.width - part.axis))));
  if (!parts.length) {
    result.height = 20; result.paths.push({ d: `M${result.axis},0 V20` }); return result;
  }
  for (const [index, part] of parts.entries()) {
    if (index) {
      result.paths.push({ d: `M${result.axis},${result.height} V${result.height + 28}` }); result.height += 28;
    }
    append(result, part, result.axis - part.axis, result.height); result.height += part.height;
  }
  return result;
}

/**
 * 条件未满足的路径在整个子树外侧绕行并汇合，包含并行网关时也不能跳过一半后进入内部支路。
 * 中心轴保持子树入口，额外宽度只用于右侧旁路；祖先会按 axis 平移，避免嵌套时斜穿节点。
 */
function conditional(body: Fragment, condition: string): Fragment {
  const result = fragment(body.width + 76), title = wrapApprovalText(`${condition}？`, 13), height = Math.max(64, title.length * 36);
  result.axis = body.axis;
  result.boxes.push({ kind: 'condition', x: result.axis - 124, y: 0, width: 248, height, title, actor: [], rule: [] });
  const top = height + 30, merge = top + body.height + 26;
  append(result, body, 0, top);
  result.paths.push({ d: `M${result.axis},${height} V${top}`, label: '是', x: result.axis + 16, y: height + 18 },
    { d: `M${result.axis},${top + body.height} V${merge}` },
    { d: `M${result.axis + 124},${height / 2} H${body.width + 38} V${merge} H${result.axis}`,
      label: '否 · 跳过', x: body.width + 38, y: (height / 2 + merge) / 2, skip: true });
  result.merges.push({ x: result.axis, y: merge }); result.height = merge;
  return result;
}

/**
 * 并行分支分别测量，入口共享同一 fork，出口统一接 join；短分支等待线停留在自己通道内。
 * 分支内部可以有条件或嵌套并行，所有子树完成后才绘制后续出口，不把任一分支画成可独自通过。
 */
function parallelFragment(parallel: NonNullable<ApprovalGroup['parallel']>): Fragment {
  const branches = parallel.branches.map(branch => ({ title: wrapApprovalText(branch.title, 14), body: groupsFragment(branch.groups) }));
  const gap = 30, width = branches.reduce((sum, branch) => sum + branch.body.width, 0) + gap * (branches.length - 1);
  const result = fragment(Math.max(348, width)), title = wrapApprovalText(`${parallel.title} · AND 分叉`, 24), forkHeight = 20 + title.length * 17;
  result.boxes.push({ kind: 'fork', x: result.axis - 150, y: 0, width: 300, height: forkHeight, title, actor: [], rule: [] });
  const splitY = forkHeight + 20, branchTop = splitY + 20;
  let dx = 0, bottom = branchTop;
  const ends: { x: number; y: number }[] = [];
  for (const branch of branches) {
    const axis = dx + branch.body.axis, labelHeight = 16 + branch.title.length * 17;
    result.boxes.push({ kind: 'branch', x: axis - 124, y: branchTop, width: 248, height: labelHeight,
      title: branch.title, actor: [], rule: [] });
    const bodyTop = branchTop + labelHeight + 24;
    result.paths.push({ d: `M${result.axis},${forkHeight} V${splitY} H${axis} V${branchTop}` },
      { d: `M${axis},${branchTop + labelHeight} V${bodyTop}` });
    append(result, branch.body, dx, bodyTop);
    const end = bodyTop + branch.body.height; ends.push({ x: axis, y: end }); bottom = Math.max(bottom, end);
    dx += branch.body.width + gap;
  }
  const mergeY = bottom + 24, joinY = mergeY + 20, joinHeight = 40;
  for (const end of ends) result.paths.push({ d: `M${end.x},${end.y} V${mergeY} H${result.axis} V${joinY}` });
  result.boxes.push({ kind: 'join', x: result.axis - 150, y: joinY, width: 300, height: joinHeight,
    title: ['AND 汇合 · 等待全部活动分支'], actor: [], rule: [] });
  result.height = joinY + joinHeight;
  return result;
}

/** 将保留的声明组递归转换为几何，条件包裹整个子树，parallel 和普通 tasks 不混为串行。 */
function groupsFragment(groups: readonly ApprovalGroup[]): Fragment {
  return sequence(groups.map(group => {
    const body = group.parallel ? parallelFragment(group.parallel) : group.groups ? groupsFragment(group.groups) : sequence(group.tasks.map(taskFragment));
    return group.condition ? conditional(body, group.condition) : body;
  }));
}

/**
 * 为带嵌套容器的审批投影生成完整布局；外层主流程使用返回宽高避免与邻接业务节点重叠。
 * 结构输入由已校验声明派生；此处不重新执行条件，也不猜测当前实例哪些分支已跳过。
 */
export function layoutStructuredApproval(flow: ApprovalFlow, name: string): ApprovalFlowLayout {
  const title = wrapApprovalText(name, 18), body = groupsFragment(flow.groups), top = 64 + title.length * 20;
  const framed = fragment(body.width + 52); append(framed, body, 26, top);
  const footer = top + body.height + 42;
  framed.paths.push({ d: `M${26 + body.axis},${top + body.height} V${footer - 16}` });
  return { flow, title, width: framed.width, height: footer + 60, boxes: framed.boxes, paths: framed.paths, merges: framed.merges, footer };
}
