// /admin 系统管理前端：独立子应用，不依赖业务前端用 React 还是 Vue。
// 这些页面自己也走内核：改组织和授权就是调用生成的命令路由，同样被鉴权、写审计。
// 所有内容都用 textContent 写入，不拼接 HTML。

const state = { me: null, catalog: null, csrf: null };

// ---------------- 小工具 ----------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, bad = false) {
  const t = h('div', { class: `toast ${bad ? 'bad' : 'ok'}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

async function csrf(refresh = false) {
  if (state.csrf && !refresh) return state.csrf;
  const r = await fetch('/auth/csrf', { credentials: 'include' });
  state.csrf = (await r.json()).token;
  return state.csrf;
}

async function api(method, url, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = await csrf();
    headers['idempotency-key'] = uuid();
  }
  const res = await fetch(url, { method, credentials: 'include', headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && url !== '/auth/login') { state.me = null; render(); }
    const msg = errorText(data);
    const err = new Error(msg);
    err.data = data;
    throw err;
  }
  return data;
}

const ERR = {
  UNAUTHENTICATED: '未登录或会话已过期', FORBIDDEN: '没有权限', NOT_FOUND: '不存在或不在你的数据范围内',
  INVALID_INPUT: '输入不正确', INVALID_TRANSITION: '当前状态不允许这个操作', CONSTRAINT_VIOLATED: '不满足规则',
  INVARIANT_VIOLATED: '数据不满足不变量', CONFLICT: '数据已被修改，请刷新', DOMAIN_ERROR: '业务错误', RATE_LIMITED: '操作太频繁',
};
function errorText(d) {
  if (!d || typeof d !== 'object') return String(d ?? '请求失败');
  const base = ERR[d.code] ?? d.code;
  const extra = d.domainCode ?? d.detail?.message ?? (typeof d.detail === 'string' ? d.detail : '');
  return extra ? `${base}：${extra}` : base;
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

const can = (cap) => !!state.me?.capabilities?.includes(cap);
const fmt = (t) => (t ? new Date(t).toLocaleString() : '');
const table = (cols, rows) =>
  h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c[0])))),
    h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, cols.map((c) => h('td', {}, c[1](r))))) : h('tr', {}, h('td', { colspan: cols.length, class: 'muted' }, '暂无数据'))));

// ---------------- 页面 ----------------

const pages = {
  tasks: { title: '我的待办', render: renderTasks },
  org: { title: '用户与部门', render: renderOrg, need: ['User.read', 'Dept.read'] },
  roles: { title: '角色与授权', render: renderRoles, need: ['Role.read'] },
  audit: { title: '审计查询', render: renderAudit, need: ['Sys.audit.read'] },
  ops: { title: '异步任务', render: renderOps, need: ['Sys.ops.read'] },
  sync: { title: '第三方同步', render: renderSync, need: ['Sys.ops.read'] },
};

async function renderTasks(main) {
  const sec = h('section', {}, h('h2', {}, '我的待办'));
  main.append(sec);
  let tasks = [];
  try { tasks = await api('GET', '/api/approval/tasks'); } catch (e) { sec.append(h('p', { class: 'muted' }, '没有启用代码内审批路由，或暂无待办。')); return; }
  sec.append(table([
    ['流程', (t) => t.process], ['步骤', (t) => t.title], ['单据', (t) => h('code', {}, `${t.aggregate} ${t.businessKey.slice(0, 8)}`)],
    ['流程变量', (t) => h('pre', {}, JSON.stringify(t.vars))], ['时间', (t) => fmt(t.createdAt)],
    ['操作', (t) => {
      const comment = h('input', { placeholder: '意见（可选）' });
      return h('div', { class: 'row' }, comment,
        h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', `/api/approval/tasks/${t.id}/approve`, { comment: comment.value }), '已同意')) go('tasks'); } }, '同意'),
        h('button', { class: 'danger', onclick: async () => { if (await run(() => api('POST', `/api/approval/tasks/${t.id}/reject`, { comment: comment.value }), '已驳回')) go('tasks'); } }, '驳回'));
    }],
  ], tasks));
}

async function renderOrg(main) {
  const [depts, users, roles] = await Promise.all([
    api('GET', '/api/dept?pageSize=200&sort=createdAt'),
    api('GET', '/api/user?pageSize=200&status=active,disabled'),
    can('Role.read') ? api('GET', '/api/role?pageSize=200') : Promise.resolve({ items: [] }),
  ]);
  const deptName = new Map(depts.items.map((d) => [d.id, d.name]));
  const userName = new Map(users.items.map((u) => [u.id, `${u.name}（${u.username}）`]));
  const depth = (d) => Math.max(0, String(d.ancestors).split('/').filter(Boolean).length - 1);
  const deptSel = (val) => h('select', {}, depts.items.map((d) => h('option', { value: d.id, selected: d.id === val }, `${'　'.repeat(depth(d))}${d.name}`)));

  // 部门
  const ds = h('section', {}, h('h2', {}, '部门'));
  if (can('Dept.create')) {
    const name = h('input', { placeholder: '部门名称', required: true });
    const parent = deptSel();
    ds.append(h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); if (await run(() => api('POST', '/api/dept/create', { name: name.value, parentId: parent.value }), '已新建')) go('org'); } },
      name, h('span', { class: 'muted' }, '上级'), parent, h('button', { class: 'primary' }, '新建部门')));
  }
  ds.append(table([
    ['名称', (d) => `${'　'.repeat(depth(d))}${d.name}`], ['编码', (d) => d.code ?? ''],
    ['负责人', (d) => {
      if (!can('Dept.update')) return userName.get(d.leaderId) ?? '';
      const sel = h('select', { onchange: () => run(() => api('POST', `/api/dept/${d.id}/update`, { leaderId: sel.value || null }), '已保存') },
        h('option', { value: '' }, '（无）'), users.items.map((u) => h('option', { value: u.id, selected: u.id === d.leaderId }, userName.get(u.id))));
      return sel;
    }],
    ['状态', (d) => d.status],
  ], depts.items));
  main.append(ds);

  // 用户
  const us = h('section', {}, h('h2', {}, '用户'));
  if (can('User.create')) {
    const username = h('input', { placeholder: '用户名', required: true });
    const name = h('input', { placeholder: '姓名', required: true });
    const dept = deptSel();
    us.append(h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); if (await run(() => api('POST', '/api/user/create', { username: username.value, name: name.value, deptId: dept.value }), '已新建，默认没有任何角色')) go('org'); } },
      username, name, dept, h('button', { class: 'primary' }, '新建用户')));
  }
  const roleName = new Map(roles.items.map((r) => [r.id, r.name]));
  us.append(table([
    ['用户名', (u) => u.username], ['姓名', (u) => u.name], ['部门', (u) => deptName.get(u.deptId) ?? u.deptId],
    ['角色', (u) => {
      if (!can('User.assignRoles') || u.status !== 'active') return u.roleIds.map((r) => h('span', { class: 'tag' }, roleName.get(r) ?? r.slice(0, 8)));
      const sel = h('select', { multiple: true, size: Math.min(4, Math.max(2, roles.items.length)) },
        roles.items.filter((r) => r.status === 'active').map((r) => h('option', { value: r.id, selected: u.roleIds.includes(r.id) }, r.name)));
      return h('div', { class: 'row' }, sel, h('button', { onclick: () => run(() => api('POST', `/api/user/${u.id}/assign-roles`, { roleIds: [...sel.selectedOptions].map((o) => o.value) }), '角色已更新') }, '保存'));
    }],
    ['状态', (u) => h('span', { class: u.status === 'active' ? 'ok' : 'bad' }, u.status)],
    ['操作', (u) => h('div', { class: 'row' },
      can('User.setPassword') && u.status === 'active' ? h('button', { onclick: () => { const p = prompt(`为 ${u.username} 设置新密码（至少 8 位）`); if (p) run(() => api('POST', `/api/user/${u.id}/set-password`, { password: p }), '密码已重置'); } }, '重置密码') : null,
      u.status === 'active' && can('User.disable') ? h('button', { class: 'danger', onclick: async () => { if (await run(() => api('POST', `/api/user/${u.id}/disable`), '已停用')) go('org'); } }, '停用') : null,
      u.status === 'disabled' && can('User.enable') ? h('button', { onclick: async () => { if (await run(() => api('POST', `/api/user/${u.id}/enable`), '已启用')) go('org'); } }, '启用') : null)],
  ], users.items));
  main.append(us);
}

let selectedRole = null;
async function renderRoles(main) {
  state.catalog ??= await api('GET', '/api/sys/catalog');
  const roles = (await api('GET', '/api/role?pageSize=200')).items;
  const wrap = h('div', { class: 'split' });
  const left = h('section', {}, h('h2', {}, '角色'));
  if (can('Role.create')) {
    const code = h('input', { placeholder: '编码，例如 purchaser', required: true, pattern: '[a-z][a-z0-9_]*' });
    const name = h('input', { placeholder: '名称', required: true });
    left.append(h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const r = await run(() => api('POST', '/api/role/create', { code: code.value, name: name.value }), '已新建，默认没有任何能力'); if (r) { selectedRole = r.id; go('roles'); } } }, code, name, h('button', { class: 'primary' }, '新建')));
  }
  for (const r of roles) {
    left.append(h('div', { class: `list-item ${r.id === selectedRole ? 'on' : ''}`, onclick: () => { selectedRole = r.id; go('roles'); } }, r.name, ' ', h('span', { class: 'muted' }, r.code), r.status !== 'active' ? h('span', { class: 'tag' }, r.status) : null));
  }
  wrap.append(left);
  const role = roles.find((r) => r.id === selectedRole);
  const right = h('section', {});
  wrap.append(right);
  main.append(wrap);
  if (!role) { right.append(h('p', { class: 'muted' }, '选择一个角色，勾选能力点、设置数据范围。能力目录由代码派生，这里只能在目录里勾选。')); return; }
  right.append(h('h2', {}, `${role.name}（${role.code}）`));
  const editable = role.status === 'active' && can('Role.grantCapability');
  const has = new Map(role.capabilities.map((c) => [c.capability, c.params]));

  // 数据范围
  right.append(h('h3', {}, '数据范围（未配置的聚合按「仅本人」）'));
  const scopeOf = new Map(role.scopes.map((s) => [s.aggregate, s]));
  const combName = { self: '仅本人', dept: '本部门', deptSubtree: '本部门及下级', deptSet: '指定部门', all: '全部' };
  right.append(table([
    ['聚合', (a) => a.name === '*' ? '所有聚合（*）' : `${a.description ?? a.name}（${a.name}）`],
    ['范围', (a) => {
      const cur = scopeOf.get(a.name);
      if (!can('Role.setScope') || role.status !== 'active') return cur ? combName[cur.combinator] : h('span', { class: 'muted' }, '未配置');
      const usable = state.catalog.combinators.filter((c) => c === 'all' || (c === 'self' ? a.scope?.ownerField : a.scope?.deptField) || a.name === '*');
      return h('select', { onchange: (e) => run(() => api('POST', `/api/role/${role.id}/set-scope`, { aggregate: a.name, combinator: e.target.value || null }), '范围已更新') },
        h('option', { value: '' }, '（未配置）'), usable.filter((c) => c !== 'deptSet').map((c) => h('option', { value: c, selected: cur?.combinator === c }, combName[c])));
    }],
  ], [{ name: '*', scope: {} }, ...state.catalog.aggregates]));

  // 能力点
  right.append(h('h3', {}, '能力点（不能授出自己没有的能力点）'));
  const groups = new Map();
  for (const c of state.catalog.capabilities) {
    const g = c.aggregate ?? '系统';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  for (const [g, caps] of groups) {
    right.append(h('h3', {}, g));
    const box = h('div', { class: 'caps' });
    for (const c of caps) {
      const checked = has.has(c.capability);
      const mine = can(c.capability);
      const param = c.capability.endsWith('.approve')
        ? h('input', { type: 'number', placeholder: '额度', style: 'width:110px', value: has.get(c.capability)?.ceiling ?? '', disabled: !editable || !checked,
            onchange: (e) => run(() => api('POST', `/api/role/${role.id}/grant-capability`, { capability: c.capability, params: { ceiling: Number(e.target.value) } }), '额度已更新') })
        : null;
      box.append(h('label', { title: c.description ?? '' },
        h('input', { type: 'checkbox', checked, disabled: !editable || (!checked && !mine),
          onchange: async (e) => {
            const url = e.target.checked ? `/api/role/${role.id}/grant-capability` : `/api/role/${role.id}/revoke-capability`;
            if (!(await run(() => api('POST', url, { capability: c.capability }), e.target.checked ? '已授予' : '已收回'))) e.target.checked = !e.target.checked;
            else go('roles');
          } }),
        ' ', c.capability, c.invokedBy && !c.invokedBy.includes('user') ? h('span', { class: 'tag' }, c.invokedBy.join('/')) : null, ' ', param));
    }
    right.append(box);
  }
}

async function renderAudit(main) {
  const f = { actor: h('input', { placeholder: '操作人 id' }), aggregate: h('input', { placeholder: '聚合，例如 PurchaseOrder' }), aggregateId: h('input', { placeholder: '对象 id' }), command: h('input', { placeholder: '命令，例如 PurchaseOrder.approve' }),
    kind: h('select', {}, ['', 'write', 'read', 'denied', 'ops'].map((k) => h('option', { value: k }, k || '全部类型'))) };
  const out = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, el]) => el.value).map(([k, el]) => [k, el.value]));
    const r = await run(() => api('GET', `/api/sys/audit?${qs}`));
    out.replaceChildren(table([
      ['时间', (a) => fmt(a.at)], ['类型', (a) => a.kind], ['操作人', (a) => h('code', {}, `${a.actor_kind}:${String(a.actor).slice(0, 18)}`)],
      ['代表', (a) => a.on_behalf_of ? h('code', {}, a.on_behalf_of.slice(0, 8)) : ''], ['来源', (a) => a.source], ['命令', (a) => a.command ?? a.capability ?? ''],
      ['对象', (a) => a.aggregate_id ? h('code', {}, `${a.aggregate} ${a.aggregate_id.slice(0, 8)}`) : a.aggregate ?? ''],
      ['结果', (a) => h('span', { class: a.result === 'ok' ? 'ok' : 'bad' }, a.result)], ['差异', (a) => a.diff ? h('pre', {}, JSON.stringify(a.diff, null, 1)) : ''],
    ], r?.items ?? []));
  };
  main.append(h('section', {}, h('h2', {}, '审计查询'), h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } }, Object.values(f), h('button', { class: 'primary' }, '查询')), out));
  load();
}

async function renderOps(main) {
  const [sum, dead, jobs] = await Promise.all([api('GET', '/api/sys/ops/summary'), api('GET', '/api/sys/ops/dead-letters'), api('GET', '/api/sys/ops/jobs')]);
  main.append(h('section', {}, h('h2', {}, 'outbox 积压'),
    table([['状态', (r) => r.status], ['数量', (r) => r.n], ['最早', (r) => fmt(r.oldest)]], sum.outbox),
    h('p', { class: sum.deadLetters ? 'bad' : 'muted' }, `未处理死信 ${sum.deadLetters} 条。死信会挡住同一单据的后续事件（为了保证顺序），直到有人处理。`)));
  const manage = can('Sys.ops.manage');
  main.append(h('section', {}, h('h2', {}, '死信'), table([
    ['事件', (d) => d.event], ['对象', (d) => h('code', {}, d.aggregate_id.slice(0, 8))], ['次数', (d) => d.attempts], ['错误', (d) => h('pre', {}, d.error ?? '')], ['时间', (d) => fmt(d.created_at)],
    ['操作', (d) => manage ? h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { if (await run(() => api('POST', `/api/sys/ops/dead-letters/${d.id}/replay`), '已重放，仍走内核流水线')) go('ops'); } }, '重放'),
      h('button', { class: 'danger', onclick: async () => { if (confirm('丢弃后这个事件不会再处理，确定？') && (await run(() => api('POST', `/api/sys/ops/dead-letters/${d.id}/discard`), '已丢弃'))) go('ops'); } }, '丢弃')) : ''],
  ], dead)));
  main.append(h('section', {}, h('h2', {}, '定时任务'), table([
    ['任务', (j) => j.name], ['调度', (j) => h('code', {}, j.cron)], ['调用命令', (j) => j.calls.map((c) => h('span', { class: 'tag' }, c))],
    ['上次', (j) => j.lastRunAt ? `${fmt(j.lastRunAt)} ${j.lastStatus ?? ''}` : ''], ['下次', (j) => fmt(j.nextRunAt)],
    ['状态', (j) => manage ? h('button', { onclick: async () => { if (await run(() => api('POST', `/api/sys/ops/jobs/${j.name}/${j.enabled ? 'disable' : 'enable'}`), '已更新')) go('ops'); } }, j.enabled ? '停用' : '启用') : (j.enabled ? '启用' : '停用')],
  ], jobs)));
}

async function renderSync(main) {
  const rows = await api('GET', '/api/sys/ops/sync-records');
  main.append(h('section', {}, h('h2', {}, '第三方同步记录'), table([
    ['连接器', (r) => `${r.connector}.${r.operation}`], ['单号', (r) => h('code', {}, r.ref_id ?? '')], ['状态', (r) => h('span', { class: r.status === 'ok' ? 'ok' : 'bad' }, r.status)],
    ['HTTP', (r) => r.http_status ?? ''], ['次数', (r) => r.attempts], ['错误', (r) => h('pre', {}, r.error ?? '')], ['更新', (r) => fmt(r.updated_at)],
  ], rows)));
}

// ---------------- 外壳 ----------------

function renderLogin() {
  const u = h('input', { placeholder: '用户名', autocomplete: 'username', required: true });
  const p = h('input', { placeholder: '密码', type: 'password', autocomplete: 'current-password', required: true });
  return h('section', { class: 'login' }, h('h2', {}, '登录系统管理'),
    h('form', { onsubmit: async (e) => { e.preventDefault(); if (await run(() => api('POST', '/auth/login', { username: u.value, password: p.value }))) { state.csrf = null; await boot(); } } },
      u, p, h('button', { class: 'primary', style: 'width:100%' }, '登录')),
    h('p', { class: 'muted' }, h('a', { href: '/auth/sso' }, '使用公司 SSO 登录')));
}

function current() {
  const k = location.hash.replace(/^#\/?/, '') || 'tasks';
  return pages[k] ? k : 'tasks';
}

function go(k) {
  if (location.hash !== `#/${k}`) location.hash = `#/${k}`;
  else render();
}

async function render() {
  const app = document.getElementById('app');
  app.replaceChildren();
  if (!state.me) { app.append(renderLogin()); return; }
  const k = current();
  const visible = Object.entries(pages).filter(([, p]) => !p.need || p.need.some(can));
  app.append(h('header', {}, h('strong', {}, '系统管理'),
    h('nav', {}, visible.map(([key, p]) => h('a', { href: `#/${key}`, class: key === k ? 'on' : '' }, p.title))),
    h('span', { class: 'me' }, state.me.user?.name ?? '', h('button', { onclick: async () => { await run(() => api('POST', '/auth/logout')); state.me = null; state.csrf = null; render(); } }, '退出'))));
  const main = h('main');
  app.append(main);
  const page = pages[k];
  if (page.need && !page.need.some(can)) { main.append(h('section', {}, h('p', { class: 'muted' }, '没有权限访问这个页面。'))); return; }
  try {
    await page.render(main);
  } catch (e) {
    main.append(h('section', {}, h('p', { class: 'bad' }, e.message)));
  }
}

async function boot() {
  try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  render();
}

window.addEventListener('hashchange', render);
boot();
