/**
 * 系统管理应用壳，负责 hash 页面映射、导航、账号操作与加载/错误状态。
 * 页面模块经公开入口组合，模块只接收内容容器；权限提示按当前会话能力计算，后端仍做权威授权。
 * 管理界面使用自身 hash 导航，返回业务首页通过普通链接，避免与业务 React Router 混用。
 */
import { api, can, run, state } from '../shared/api.js';
import { emptyState, h, icon, panel } from '../shared/dom.js';
import { navigate } from '../shared/navigation.js';
import { renderTasks, renderApprovalRequests, renderApprovalNotices } from '../modules/tasks/index.js';
import { renderOrg } from '../modules/org/index.js';
import { renderRoles } from '../modules/roles/index.js';
import { renderAudit } from '../modules/audit/index.js';
import { renderOperations, renderSync } from '../modules/operations/index.js';
import { loginPage } from '../modules/auth/index.js';
import { renderModels } from '../modules/models/index.js';
import { renderPersonalities } from '../modules/personalities/index.js';

/**
 * 页面目录及所需能力清单。need 为空表示有登录会话即可尝试进入，非空采用 some 允许满足任一能力。
 * 这些条目同时决定导航显示和页面级提示，不能替代模块请求或服务端鉴权。
 */
const pages = {
  requests: {
    title: '我的申请', description: '跟进本人发起的审批，查看办理时限并向当前办理人催办。',
    glyph: 'file', category: '团队与权限', render: renderApprovalRequests, need: [],
  },
  notices: {
    title: '流程提醒', description: '集中查看临期、超时与催办提醒，及时推进审批协作。',
    glyph: 'clock', category: '团队与权限', render: renderApprovalNotices, need: [],
  },
  personalities: {
    title: '助理性格', description: '设置助理的语气、表达习惯和默认性格，随时试聊。',
    glyph: 'users', category: '运行与记录', render: renderPersonalities, need: ['Sys.ai.personalities.manage'],
  },
  models: {
    title: 'AI 模型',
    description: '为智能审批与业务助理配置模型连接，保存后后续调用自动生效。',
    glyph: 'grid', category: '运行与记录', render: renderModels, need: ['Sys.ai.models.manage'],
  },
  tasks: {
    title: '我的待办',
    description: '集中处理分配给你的审批任务，让每一步协作及时推进。',
    glyph: 'inbox',
    category: '团队与权限',
    render: renderTasks,
    need: [],
  },
  org: {
    title: '用户与部门',
    description: '管理团队成员、组织关系与部门负责人。',
    glyph: 'users',
    category: '团队与权限',
    render: renderOrg,
    need: ['User.read', 'Dept.read'],
  },
  roles: {
    title: '角色与授权',
    description: '用清晰的职责边界，配置每个角色可以做什么、可以看什么。',
    glyph: 'shield',
    category: '团队与权限',
    render: renderRoles,
    need: ['Role.read'],
  },
  audit: {
    title: '操作审计',
    description: '业务操作有据可查，重要变更全程留痕。',
    glyph: 'file',
    category: '运行与记录',
    render: renderAudit,
    need: ['Sys.audit.read'],
  },
  ops: {
    title: '异步任务',
    description: '查看事件投递、处理失败事件，管理业务定时任务。',
    glyph: 'clock',
    category: '运行与记录',
    render: renderOperations,
    need: ['Sys.ops.read'],
  },
  sync: {
    title: '第三方同步',
    description: '追踪业务与外部系统之间的每一次同步。',
    glyph: 'link',
    category: '运行与记录',
    render: renderSync,
    need: ['Sys.ops.read'],
  },
};
/**
 * 限定应用壳可识别的 hash 页面键；未知 hash 按当前实现回到待办页面。
 */
type PageKey = keyof typeof pages;

/** 应用组合层只负责导航、会话和页面加载；各管理模块维护自己的表单和请求。 */
/**
 * 根据当前会话与 hash 重建侧栏、页头和内容容器，并等待目标模块完成数据加载。
 * 没有会话时返回登录页，登录成功调用 boot 重新取身份和目录；退出成功后清空本地会话资料。
 * 加载异常写入错误面板，finally 移除加载提示；本函数不把隐藏按钮视为服务端授权。
 */
export async function render(boot: () => Promise<void>) {
  const root = document.getElementById('app')!;
  if (!state.me) {
    root.replaceChildren(loginPage(boot));
    return;
  }
  // 页面键和筛选参数分开解析；提醒页的筛选随 hash 保留，刷新与前进后退仍指向同一视图。
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0] || 'tasks';
  const key = (hash in pages ? hash : 'tasks') as PageKey;
  const page = pages[key];
  const visible = Object.entries(pages).filter(([name, item]) =>
    (!['requests', 'notices'].includes(name) || state.catalog?.approvalOperations) && (!item.need.length || item.need.some(can)));
  const sidebar = h(
    'aside',
    { class: 'app-sidebar' },
    h(
      'a',
      { class: 'brand', href: '#/tasks', 'aria-label': 'Cage 系统管理首页' },
      h('span', { class: 'brand-mark' }, icon('grid')),
      h('span', {}, 'Cage', h('small', {}, '系统管理')),
    ),
    ...['团队与权限', '运行与记录'].map((category) =>
      h(
        'div',
        { class: 'nav-group' },
        h('p', { class: 'nav-caption' }, category),
        h(
          'nav',
          { 'aria-label': category },
          visible
            .filter(([, item]) => item.category === category)
            .map(([name, item]) =>
              h(
                'a',
                {
                  href: `#/${name}`,
                  class: `nav-item ${key === name ? 'active' : ''}`,
                  'aria-current': key === name ? 'page' : undefined,
                },
                icon(item.glyph),
                h('span', {}, item.title),
                key === name && h('i', { class: 'nav-active-dot' }),
              ),
            ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'sidebar-bottom' },
      h('div', { class: 'workspace-label' }, h('span', { class: 'connection-dot' }), '团队管理工作空间'),
      h('a', { href: '/', class: 'back-to-business' }, icon('arrow'), '返回业务首页'),
    ),
  );
  const logout = h(
    'button',
    {
      class: 'icon-button',
      'aria-label': '退出登录',
      title: '退出登录',
      onclick: async () => {
        if (await run(() => api('POST', '/auth/logout'), undefined, logout)) {
          state.me = null;
          state.catalog = null;
          state.csrf = null;
          void render(boot);
        }
      },
    },
    icon('logout'),
  );
  const content = h('div', { class: 'page-content' });
  const loading = h(
    'div',
    { class: 'loading-panel', role: 'status' },
    h('span', { class: 'spinner' }),
    '正在读取管理数据…',
  );
  content.append(loading);
  const main = h(
    'main',
    { class: 'app-main' },
    h(
      'header',
      { class: 'app-topbar' },
      h(
        'div',
        { class: 'breadcrumb' },
        h('span', {}, '工作空间'),
        icon('chevron'),
        h('span', {}, '系统管理'),
        icon('chevron'),
        h('strong', {}, page.title),
      ),
      h(
        'div',
        { class: 'account' },
        h('span', { class: 'avatar' }, state.me.user.name.slice(0, 1)),
        h('span', { class: 'account-copy' }, h('strong', {}, state.me.user.name), h('small', {}, '当前登录')),
        logout,
      ),
    ),
    h(
      'div',
      { class: 'page-container' },
      h(
        'div',
        { class: 'page-heading' },
        h(
          'div',
          {},
          h('span', { class: 'eyebrow' }, '管理工作台'),
          h('h1', {}, page.title),
          h('p', {}, page.description),
        ),
        h('button', { class: 'refresh-button', onclick: () => navigate(location.hash.replace(/^#\/?/, '') || key) }, icon('refresh'), '刷新数据'),
      ),
      content,
      h(
        'footer',
        { class: 'page-footer' },
        h('span', {}, 'Cage · 让业务有序发生'),
        h('span', {}, icon('shield'), '操作受角色权限与数据范围约束'),
      ),
    ),
  );
  root.replaceChildren(h('div', { class: 'admin-shell' }, sidebar, main));
  if (page.need.length && !page.need.some(can)) {
    loading.remove();
    content.append(
      panel(
        '访问受限',
        undefined,
        emptyState('你没有查看此页面的权限', '请联系管理员，按职责配置所需角色。', 'lock'),
      ),
    );
    return;
  }
  try {
    await page.render(content);
  } catch (error) {
    content.append(
      h(
        'div',
        { class: 'error-panel', role: 'alert' },
        icon('info'),
        h(
          'div',
          {},
          h('strong', {}, '暂时无法读取数据'),
          h(
            'p',
            {},
            error instanceof TypeError ? '请检查网络与 API 服务后重新尝试。' : (error as Error).message,
          ),
        ),
        h('button', { onclick: () => navigate(location.hash.replace(/^#\/?/, '') || key) }, '重新加载'),
      ),
    );
  } finally {
    loading.remove();
  }
}
