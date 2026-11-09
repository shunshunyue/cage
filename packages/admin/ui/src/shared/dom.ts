/**
 * 原生 DOM 组件工具，统一管理页面的元素创建、表格、状态、搜索和对话框。
 * 动态文本创建 Text 节点，避免把业务字段或错误内容解释为 HTML；图标来自本地路径表。
 * 函数返回真实 DOM 节点，除 modal/toast 类调用方外不会主动挂载到全局页面；事件与节点生命周期由所属页面管理。
 */
/**
 * 可递归展开的 DOM 子项；null、undefined 和 false 被忽略，其他原始值转为文本。
 */
type Child = Node | string | number | boolean | null | undefined | Child[];
/**
 * 元素属性与事件回调的输入集合；on 开头的键通过 addEventListener 注册，非 HTML 字符串模板。
 */
type Attributes = Record<string, string | number | boolean | null | undefined | ((event: Event) => unknown)>;

/** 统一用 DOM/textContent 构建界面；业务名称、错误、审计差异不会被当作 HTML 执行。 */
/**
 * 创建指定标签并递归追加 children，最后赋属性以保证 select 能匹配已插入的 option。
 * value/checked 使用 DOM 属性，aria 属性保留字符串语义；事件键去除 on 前缀后注册监听。
 * 返回对应标签类型的未挂载节点，不做输入业务校验或权限判断。
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const append = (child: Child) => {
    if (Array.isArray(child)) child.forEach(append);
    else if (child !== null && child !== undefined && child !== false)
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);
  // select 的 value 必须在 option 加入后赋值，否则浏览器会丢失当前选择。
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'class') element.className = String(value);
    else if (key === 'value') (element as HTMLInputElement).value = String(value);
    else if (key === 'checked') (element as HTMLInputElement).checked = Boolean(value);
    else if (key.startsWith('aria-')) element.setAttribute(key, String(value));
    else if (value !== false) element.setAttribute(key, value === true ? '' : String(value));
  }
  return element;
}

const paths: Record<string, string[]> = {
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  shield: ['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z', 'm8 12 3 3 5-6'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
    'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  ],
  inbox: ['M4 4h16l2 12v4H2v-4z', 'M2 16h6l2 3h4l2-3h6'],
  search: ['M21 21l-5-5', 'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M12 6v6l4 2'],
  link: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'],
  file: ['M14 2H4v20h16V8z', 'M14 2v6h6M8 13h8M8 17h5'],
  arrow: ['M7 17 17 7M7 7h10v10'],
  plus: ['M12 5v14M5 12h14'],
  check: ['m5 12 4 4L19 6'],
  chevron: ['m9 5 7 7-7 7'],
  logout: ['M9 21H3V3h6M9 12h12m-4-4 4 4-4 4'],
  refresh: ['M20 7a9 9 0 1 0 1 10M20 3v5h-5'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20', 'M12 11v6M12 7h.01'],
  lock: ['M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v3'],
};

/** 线条图标是本地 SVG，无字体、CDN 或图片下载依赖。 */
/**
 * 从本地 paths 表生成装饰性 SVG，继承 currentColor 并设置 aria-hidden。
 * name 必须来自已定义图标键；此函数不访问网络或加载外部 SVG。
 */
export function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: 'icon',
  }))
    svg.setAttribute(key, value);
  for (const d of paths[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * 把表单标签、控件和可选提示组合为一个 label，控件状态仍由调用页面维护。
 */
export const field = (label: string, control: HTMLElement, hint?: string) =>
  h('label', { class: 'field' }, h('span', {}, label), control, hint && h('small', {}, hint));
/**
 * 将存在的时间字符串按浏览器本地时区显示为中文日期时间，null 显示占位符。
 */
export const formatTime = (time: string | null) =>
  time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
/**
 * 生成状态徽标，tone 选择既有 CSS 色调；text 作为文本插入，徽标不判断业务终态。
 */
export const badge = (text: string, tone = 'neutral') => h('span', { class: `badge ${tone}` }, text);
/**
 * 以列标题与单元格渲染函数构造表格；空行集显示跨列提示。
 * rows 是调用方已取得的数据，不在这里分页、过滤或请求服务器；单元格仍通过安全 DOM 子项追加。
 */
export function table<T>(columns: [string, (row: T) => Child][], rows: T[], empty = '暂无记录') {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map(([name]) => h('th', { scope: 'col' }, name)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.length
          ? rows.map((row) =>
              h(
                'tr',
                {},
                columns.map(([, cell]) => h('td', {}, cell(row))),
              ),
            )
          : h('tr', {}, h('td', { colspan: columns.length, class: 'table-empty' }, empty)),
      ),
    ),
  );
}
/**
 * 构造含图标、标题和说明的空态块；由调用方区分无记录、无权限和未配置等原因。
 */
export function emptyState(title: string, message: string, glyph = 'inbox') {
  return h(
    'div',
    { class: 'empty-state' },
    h('span', { class: 'empty-icon' }, icon(glyph)),
    h('h3', {}, title),
    h('p', {}, message),
  );
}
/**
 * 组合带标题、可选说明和内容的 section，返回未挂载面板供页面自由布局。
 */
export function panel(title: string, description?: string, ...children: Child[]) {
  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-heading' },
      h('div', {}, h('h2', {}, title), description && h('p', {}, description)),
    ),
    children,
  );
}
/**
 * 创建搜索输入并将每次 input 的当前值交给 onInput。
 * 默认不防抖、不请求服务器，调用者决定本地过滤或发起查询。
 */
export function searchInput(placeholder: string, onInput: (value: string) => void, value = '') {
  const input: HTMLInputElement = h('input', {
    type: 'search',
    placeholder,
    'aria-label': placeholder,
    value,
    oninput: () => onInput(input.value),
  });
  return h('div', { class: 'search-field' }, icon('search'), input);
}
/**
 * 把原生 dialog 挂到 document.body 并以模态方式打开，返回实例便于提交后关闭。
 * close 事件只监听一次并移除节点，避免已关闭表单长期留在 DOM；不会替表单提交或保存草稿。
 */
export function modal(title: string, content: HTMLElement) {
  const dialog: HTMLDialogElement = h(
    'dialog',
    { class: 'modal' },
    h(
      'div',
      { class: 'modal-heading' },
      h('h2', {}, title),
      h(
        'button',
        { type: 'button', class: 'icon-button', 'aria-label': '关闭窗口', onclick: () => dialog.close() },
        '×',
      ),
    ),
    content,
  );
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
