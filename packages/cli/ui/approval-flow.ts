import type { ApprovalFlow, ApprovalTask } from '../src/graph-approvals.js';

interface ApprovalBox {
  kind: 'task' | 'condition';
  x: number;
  y: number;
  width: number;
  height: number;
  title: string[];
  actor: string[];
  rule: string[];
  task?: ApprovalTask;
}
export interface ApprovalFlowLayout {
  flow: ApprovalFlow;
  width: number;
  height: number;
  title: string[];
  boxes: ApprovalBox[];
  paths: { d: string; label?: string; x?: number; y?: number; skip?: boolean }[];
  merges: { x: number; y: number }[];
  footer: number;
}

function wrap(text: string, limit: number): string[] {
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

/** 审批始终在容器内纵向阅读，外部主流程可以横排。先测量再参与全图布局，
 * 条件与审批步骤都不会越出容器，跳过线在侧边汇合后才进入下一条条件。 */
export function layoutApprovalFlow(flow: ApprovalFlow, name: string): ApprovalFlowLayout {
  const title = wrap(name, 18);
  const boxes: ApprovalBox[] = [];
  const paths: ApprovalFlowLayout['paths'] = [];
  const merges: ApprovalFlowLayout['merges'] = [];
  const axis = 174,
    left = 50,
    width = 248,
    bypass = 352;
  let y = 54 + title.length * 20;
  let previous: number | undefined;
  const connect = (to: number, label?: string) => {
    if (previous !== undefined)
      paths.push({ d: `M${axis},${previous} V${to}`, label, x: axis + 17, y: (previous + to) / 2 + 4 });
  };
  const addTask = (task: ApprovalTask, firstLabel?: string) => {
    const title = wrap(task.title, 14),
      actor = wrap(`审批人：${task.actor}`, 19),
      rule = wrap(task.rule, 18);
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
    const title = wrap(`${group.condition}？`, 13);
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
    } else {
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
