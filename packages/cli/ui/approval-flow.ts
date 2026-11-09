/**
 * 审批子图的纯测量与 SVG 绘制层，输入为已解释的 ApprovalFlow。
 * 按声明顺序纵向排列条件和人工/AI 步骤，测量文本高度，并为跳过分支留侧边通道与汇合点。
 * 只绘制规则，不计算当前执行人或实际审批进度；外部业务流程可横排，子图内部仍按纵向阅读。
 */
import type { ApprovalFlow, ApprovalGroup, ApprovalTask } from '../src/graph-approvals.js';
import { layoutStructuredApproval } from './approval-parallel.js';

/**
 * 审批容器中一块任务或条件的测量结果，坐标均相对该容器，文本已换行。
 */
export interface ApprovalBox {
  /** task 为审批任务，condition 为条件菱形；fork/join 为 AND 网关，branch 仅显示分支标题。 */
  kind: 'task' | 'condition' | 'fork' | 'join' | 'branch';
  /** 相对审批容器左上角的水平坐标，单位为缩放前 SVG 单位。 */
  x: number;
  /** 相对审批容器顶部的垂直坐标。 */
  y: number;
  /** 根据内容测量后的框宽。 */
  width: number;
  /** 根据换行和说明测量后的框高。 */
  height: number;
  /** 已按可用宽度换行的标题。 */
  title: string[];
  /** 已换行的选人说明，条件框为空数组。 */
  actor: string[];
  /** 已换行的通过规则，条件框为空数组。 */
  rule: string[];
  /** 任务框对应的声明投影；条件框不带任务。 */
  task?: ApprovalTask;
}
/**
 * 审批子图的完整测量结果，主流程布局用宽高预留空间，SVG 渲染复用相同路径。
 */
export interface ApprovalFlowLayout {
  /** 本次排布的审批元数据，用于结论和来源解释。 */
  flow: ApprovalFlow;
  /** 整个审批子图外框宽度，交给主流程布局预留空间。 */
  width: number;
  /** 整个审批子图外框高度，包含任务、分支和底部说明。 */
  height: number;
  /** 容器顶部已换行的审批标题。 */
  title: string[];
  /** 按阅读顺序排列的条件与任务框。 */
  boxes: ApprovalBox[];
  /** 内部连接路径与可选分支标签位置，skip 区分条件不满足支路。 */
  paths: { d: string; label?: string; x?: number; y?: number; skip?: boolean }[];
  /** 条件组的汇合点坐标，绘制小圆点说明回到主线。 */
  merges: { x: number; y: number }[];
  /** 底部结论说明的垂直起点，不是外框高度。 */
  footer: number;
}

/**
 * 按中英文近似字宽换行，返回完整文字行；不是浏览器字体精确测量。
 */
export function wrapApprovalText(text: string, limit: number): string[] {
  const lines: string[] = [];
  let line = '',
    length = 0;
  for (const char of text) {
    const width = /[\u0000-\u00ff]/.test(char) ? 0.55 : 1;
    if (length + width > limit && line) {
      lines.push(line);
      line = '';
      length = 0;
    }
    line += char;
    length += width;
  }
  if (line) lines.push(line);
  return lines;
}

/** 结构化条件或并行需要递归布局；只有原始平面顺序组时沿用既有紧凑图。 */
export function hasStructuredApproval(groups: readonly ApprovalGroup[]): boolean {
  return groups.some(group => !!group.parallel || !!group.groups);
}

/** 标题只在存在真实 AND 容器时说明同时启动，嵌套 when 本身仍是条件顺序而非并行。 */
function hasParallel(groups: readonly ApprovalGroup[]): boolean {
  return groups.some(group => !!group.parallel || (group.groups && hasParallel(group.groups)));
}

/** 审批始终在容器内纵向阅读，外部主流程可以横排。先测量再参与全图布局，
 * 条件与审批步骤都不会越出容器，跳过线在侧边汇合后才进入下一条条件。 */
/**
 * 测量审批标题、条件与步骤，侧边跳过分支在进入后续组之前汇合。
 * @param flow 静态审批阅读投影。
 * @param name 容器中文标题。
 * @returns 相对坐标、文本行与连线；不读取具体审批任务。
 */
export function layoutApprovalFlow(flow: ApprovalFlow, name: string): ApprovalFlowLayout {
  if (hasStructuredApproval(flow.groups)) return layoutStructuredApproval(flow, name);
  const title = wrapApprovalText(name, 18);
  const boxes: ApprovalBox[] = [];
  const paths: ApprovalFlowLayout['paths'] = [];
  const merges: ApprovalFlowLayout['merges'] = [];
  const axis = 174,
    left = 50,
    width = 248,
    bypass = 352;
  let y = 54 + title.length * 20;
  let previous: number | undefined;
  /**
   * 从上一个框的出口连接到目标 y，首个框没有前驱时不产生空悬连线。
   */
  const connect = (to: number, label?: string) => {
    if (previous !== undefined)
      paths.push({ d: `M${axis},${previous} V${to}`, label, x: axis + 17, y: (previous + to) / 2 + 4 });
  };
  /**
   * 测量任务标题、选人与规则，推进纵向游标并连接前驱；条件组首任务可标记“是”分支。
   */
  const addTask = (task: ApprovalTask, firstLabel?: string) => {
    const title = wrapApprovalText(task.title, 14),
      actor = wrapApprovalText(`审批人：${task.actor}`, 19),
      rule = wrapApprovalText(task.rule, 18);
    const height = 18 + title.length * 18 + actor.length * 16 + rule.length * 16;
    connect(y, firstLabel);
    boxes.push({ kind: 'task', x: left, y, width, height, title, actor, rule, task });
    previous = y + height;
    y = previous + 24;
  };
  for (const group of flow.groups) {
    if (!group.condition) {
      group.tasks.forEach((task) => addTask(task));
      continue;
    }
    const title = wrapApprovalText(`${group.condition}？`, 13);
    const height = Math.max(64, title.length * 36);
    connect(y);
    const top = y;
    boxes.push({ kind: 'condition', x: left, y, width, height, title, actor: [], rule: [] });
    previous = y + height;
    y = previous + 28;
    group.tasks.forEach((task, index) => addTask(task, index === 0 ? '是' : undefined));
    const merge = y - 4;
    paths.push({
      d: `M${left + width},${top + height / 2} H${bypass} V${merge} H${axis}`,
      label: '否 · 跳过',
      x: bypass,
      y: (top + height / 2 + merge) / 2,
      skip: true,
    });
    connect(merge);
    merges.push({ x: axis, y: merge });
    previous = merge;
    y = merge + 24;
  }
  if (previous !== undefined) connect(y + 2);
  const footer = y + 20;
  return { flow, title, width: 400, height: footer + (flow.route ? 52 : 60), boxes, paths, merges, footer };
}

/**
 * 按预先测量结果创建 SVG 子图。
 * @param layout layoutApprovalFlow 的结果。
 * @returns 未挂载 g 元素；文本使用 textContent，不执行审批或请求数据。
 */
export function renderApprovalFlow(layout: ApprovalFlowLayout): SVGGElement {
  const vector = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
    text = '',
  ) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    node.textContent = text;
    return node;
  };
  const content = vector('g', { class: 'approval-flow-content' });
  const text = (x: number, y: number, value: string, className: string, anchor = 'middle') =>
    vector('text', { x, y, class: className, 'text-anchor': anchor }, value);
  layout.title.forEach((line, index) =>
    content.append(text(24, 31 + index * 20, line, 'approval-flow-title', 'start')),
  );
  content.append(
    text(
      24,
      32 + layout.title.length * 20,
      !layout.flow.route
        ? '审批步骤待补充 · 点击查看声明'
        : hasParallel(layout.flow.groups)
          ? '分支同时启动 · 全部分支完成后汇合'
        : layout.flow.groups.some((group) => group.condition)
          ? '按顺序审批 · 条件满足时加审'
          : '按顺序审批 · 每一步通过后继续',
      'approval-flow-subtitle',
      'start',
    ),
  );
  for (const path of layout.paths) {
    content.append(
      vector('path', {
        d: path.d,
        class: `approval-flow-line${path.skip ? ' skip' : ''}`,
        'marker-end': 'url(#flow-arrow)',
      }),
    );
    if (path.label) {
      if (path.skip)
        content.append(
          vector('rect', {
            x: path.x! - 33,
            y: path.y! - 12,
            width: 66,
            height: 23,
            rx: 4,
            class: 'approval-flow-label-box',
          }),
        );
      content.append(text(path.x!, path.y! + (path.skip ? 4 : 0), path.label, 'approval-flow-branch'));
    }
  }
  for (const box of layout.boxes) {
    const item = vector('g', { class: `approval-flow-${box.kind}`, 'data-approval-kind': box.kind });
    if (box.kind === 'condition') {
      item.append(
        vector('path', {
          d: `M${box.x + box.width / 2},${box.y} L${box.x + box.width},${box.y + box.height / 2} L${box.x + box.width / 2},${box.y + box.height} L${box.x},${box.y + box.height / 2}Z`,
          class: 'approval-condition-shape',
        }),
      );
      box.title.forEach((line, index) =>
        item.append(
          text(
            box.x + box.width / 2,
            box.y + box.height / 2 + 4 + (index - (box.title.length - 1) / 2) * 16,
            line,
            'approval-condition-title',
          ),
        ),
      );
    } else if (box.kind === 'task') {
      item.append(
        vector('rect', {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          rx: 6,
          class: 'approval-task-shape',
        }),
      );
      item.append(
        vector('circle', { cx: box.x - 19, cy: box.y + 20, r: 11, class: 'approval-task-number-shape' }),
      );
      item.append(
        text(box.x - 19, box.y + 24, String(box.task!.number).padStart(2, '0'), 'approval-task-number'),
      );
      const center = box.x + box.width / 2;
      box.title.forEach((line, index) =>
        item.append(text(center, box.y + 23 + index * 18, line, 'approval-task-title')),
      );
      box.actor.forEach((line, index) =>
        item.append(
          text(center, box.y + 24 + box.title.length * 18 + index * 16, line, 'approval-task-actor'),
        ),
      );
      box.rule.forEach((line, index) =>
        item.append(
          text(
            center,
            box.y + 24 + box.title.length * 18 + box.actor.length * 16 + index * 16,
            line,
            'approval-task-rule',
          ),
        ),
      );
    } else {
      // 网关与分支标题不冒充可审批任务，也不显示全局序号；AND 的两条入口/出口由真实布局路径表达。
      const gateway = box.kind === 'fork' || box.kind === 'join';
      item.append(vector('rect', { x: box.x, y: box.y, width: box.width, height: box.height,
        rx: gateway ? 3 : 8, class: gateway ? 'approval-gateway-shape' : 'approval-branch-shape' }));
      box.title.forEach((line, index) => item.append(text(box.x + box.width / 2,
        box.y + (box.height - box.title.length * 17) / 2 + 13 + index * 17,
        line, gateway ? 'approval-gateway-title' : 'approval-task-title')));
    }
    content.append(item);
  }
  for (const merge of layout.merges)
    content.append(vector('circle', { cx: merge.x, cy: merge.y, r: 3, class: 'approval-flow-merge' }));
  if (layout.flow.route) {
    content.append(
      text(layout.width / 2, layout.footer, '所需步骤全部通过 → 继续后续业务', 'approval-flow-outcome'),
    );
    content.append(
      text(layout.width / 2, layout.footer + 21, '任一步骤驳回 → 结束本轮审批', 'approval-flow-rejection'),
    );
    content.append(
      text(layout.width / 2, layout.footer + 40, '点击查看审批规则与实现代码', 'approval-flow-hint'),
    );
  } else {
    content.append(text(layout.width / 2, layout.footer, '未抽取到绑定的审批步骤', 'approval-flow-outcome'));
    content.append(
      text(layout.width / 2, layout.footer + 22, '点击查看审批声明或外部流程配置', 'approval-flow-hint'),
    );
  }
  return content;
}
