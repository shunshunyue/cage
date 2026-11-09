/**
 * 组织管理页面：按读取能力分别加载部门、用户与角色，再提供受能力控制的组织命令入口。
 * 部门负责人用于审批选人，角色用于授权，两种配置独立维护；页面显示只反映当前取回的分页数据。
 */
import { api, can, run } from '../../shared/api.js';
import { badge, field, h, icon, modal, panel, searchInput, table } from '../../shared/dom.js';
import { navigate } from '../../shared/navigation.js';
import type { Dept, List, Role, User } from '../../shared/types.js';

/** 组织编辑继续走生成命令；负责人和角色是两份配置，在界面上明确区分。 */
/**
 * 并行读取最多一页组织数据，缺读取能力的集合按空列表处理，后端继续约束实际范围。
 * 部门用 ancestors 深度显示层级；用户列表支持本地搜索，写入通过生成的领域路由，成功后刷新管理页面。
 */
export async function renderOrg(main: HTMLElement) {
  const [departments, people, roleResult] = await Promise.all([
    can('Dept.read')
      ? api<List<Dept>>('GET', '/api/dept?pageSize=200&sort=createdAt')
      : Promise.resolve({ items: [] as Dept[], total: 0 }),
    can('User.read')
      ? api<List<User>>('GET', '/api/user?pageSize=200&status=active,disabled')
      : Promise.resolve({ items: [] as User[], total: 0 }),
    can('Role.read')
      ? api<List<Role>>('GET', '/api/role?pageSize=200')
      : Promise.resolve({ items: [] as Role[] }),
  ]);
  const depts = departments.items,
    users = people.items,
    roles = roleResult.items;
  const departmentName = new Map(depts.map((dept) => [dept.id, dept.name]));
  const userName = new Map(users.map((user) => [user.id, `${user.name}（${user.username}）`]));
  const roleName = new Map(roles.map((role) => [role.id, role.name]));
  const depth = (dept: Dept) => Math.max(0, dept.ancestors.split('/').filter(Boolean).length - 1);
  const selectDepartment = (value?: string) =>
    h(
      'select',
      { ...(value ? { value } : {}) },
      depts.map((dept) => h('option', { value: dept.id }, `${'　'.repeat(depth(dept))}${dept.name}`)),
    );

  main.append(
    h(
      'div',
      { class: 'stats-row' },
      stat('部门', departments.total, 'grid'),
      stat('用户', people.total, 'users'),
      stat('当前列表已启用', users.filter((user) => user.status === 'active').length, 'check'),
    ),
  );
  const deptPanel = panel(
    '部门与负责人',
    '部门负责人用于审批选人；给用户分配经理角色后，仍需在这里指定负责人。',
  );
  const departmentActions = h('div', { class: 'section-actions' });
  if (can('Dept.create') && depts.length)
    departmentActions.append(
      h('button', { class: 'small', onclick: createDepartment }, icon('plus'), '新建部门'),
    );
  deptPanel.querySelector('.panel-heading')!.append(departmentActions);
  deptPanel.append(
    table<Dept>(
      [
        [
          '部门名称',
          (dept) =>
            h(
              'div',
              { class: 'entity-cell', style: `padding-left:${depth(dept) * 20}px` },
              h('span', { class: 'entity-icon' }, icon('grid')),
              h('strong', {}, dept.name),
            ),
        ],
        ['部门编码', (dept) => h('code', { class: 'muted' }, dept.code || '—')],
        [
          '部门负责人',
          (dept) => {
            if (!can('Dept.update') || !can('User.read'))
              return userName.get(dept.leaderId ?? '') || '未设置';
            const select = h(
              'select',
              {
                value: dept.leaderId ?? '',
                'aria-label': `${dept.name}负责人`,
                onchange: async () => {
                  select.disabled = true;
                  const updated = await run(
                    () =>
                      api<Dept>('POST', `/api/dept/${dept.id}/update`, { leaderId: select.value || null }),
                    '部门负责人已保存',
                  );
                  if (updated) dept.leaderId = updated.leaderId;
                  else select.value = dept.leaderId ?? '';
                  select.disabled = false;
                },
              },
              h('option', { value: '' }, '请选择负责人'),
              users
                .filter((user) => user.status === 'active')
                .map((user) => h('option', { value: user.id }, userName.get(user.id))),
            );
            return select;
          },
        ],
        [
          '状态',
          (dept) =>
            badge(
              dept.status === 'active' ? '已启用' : '已停用',
              dept.status === 'active' ? 'green' : 'neutral',
            ),
        ],
      ],
      depts,
    ),
  );
  if (can('Dept.read')) main.append(deptPanel);

  if (can('User.read')) {
    const out = h('div');
    let query = '';
    const toolbar = h(
      'div',
      { class: 'table-toolbar' },
      searchInput('搜索姓名、账号或部门', (value) => {
        query = value.toLowerCase();
        renderUsers();
      }),
    );
    if (can('User.create'))
      toolbar.append(
        h(
          'button',
          { class: 'primary', disabled: !depts.length, onclick: createUser },
          icon('plus'),
          '新建用户',
        ),
      );
    const userPanel = panel(
      '用户与角色',
      '通过角色分配操作权限；账号停用后将无法继续访问系统。',
      toolbar,
      out,
    );
    main.append(userPanel);
    /**
     * 按当前本地搜索条件重画已加载用户，并根据命令能力展示角色、密码、启停操作。
     * 过滤范围限于当前返回的数据，不执行服务器全量搜索。
     */
    function renderUsers() {
      const visible = users.filter((user) =>
        `${user.name} ${user.username} ${departmentName.get(user.deptId) ?? ''}`
          .toLowerCase()
          .includes(query),
      );
      out.replaceChildren(
        table<User>(
          [
            [
              '用户',
              (user) =>
                h(
                  'div',
                  { class: 'person-cell' },
                  h('span', { class: 'person-avatar' }, user.name.slice(0, 1)),
                  h('div', {}, h('strong', {}, user.name), h('small', {}, user.username)),
                ),
            ],
            ['所属部门', (user) => departmentName.get(user.deptId) || '未获取部门名称'],
            [
              '拥有角色',
              (user) =>
                h(
                  'div',
                  { class: 'tag-list' },
                  user.roleIds.length
                    ? user.roleIds.map((id) => badge(roleName.get(id) || '未获取角色名称'))
                    : h('span', { class: 'muted' }, '尚未分配'),
                  can('User.assignRoles') && can('Role.read') && user.status === 'active'
                    ? h('button', { class: 'text-button', onclick: () => assignRoles(user) }, '配置')
                    : null,
                ),
            ],
            [
              '状态',
              (user) =>
                badge(
                  user.status === 'active' ? '已启用' : '已停用',
                  user.status === 'active' ? 'green' : 'neutral',
                ),
            ],
            [
              '账号操作',
              (user) =>
                h(
                  'div',
                  { class: 'row-actions' },
                  can('User.setPassword') && user.status === 'active'
                    ? h('button', { class: 'text-button', onclick: () => resetPassword(user) }, '重置密码')
                    : null,
                  user.status === 'active' && can('User.disable')
                    ? h(
                        'button',
                        {
                          class: 'text-button danger',
                          onclick: async (event) => {
                            if (
                              await run(
                                () => api('POST', `/api/user/${user.id}/disable`),
                                '账号已停用',
                                event.currentTarget as HTMLButtonElement,
                              )
                            )
                              navigate('org');
                          },
                        },
                        '停用',
                      )
                    : null,
                  user.status === 'disabled' && can('User.enable')
                    ? h(
                        'button',
                        {
                          class: 'text-button',
                          onclick: async (event) => {
                            if (
                              await run(
                                () => api('POST', `/api/user/${user.id}/enable`),
                                '账号已启用',
                                event.currentTarget as HTMLButtonElement,
                              )
                            )
                              navigate('org');
                          },
                        },
                        '启用',
                      )
                    : null,
                ),
            ],
          ],
          visible,
        ),
      );
    }
    renderUsers();
  }
  if (people.total > users.length || departments.total > depts.length)
    main.append(
      h('p', { class: 'muted' }, '当前仅展示前 200 条可见组织记录；超出部分请通过业务组织接口查询。'),
    );

  /**
   * 打开新建部门表单，通过 Dept.create 传入父部门与资料；成功关闭弹窗并重载组织页。
   */
  function createDepartment() {
    const name = h('input', { required: true, maxlength: 100, placeholder: '例如：采购部' });
    const parent = selectDepartment();
    const save = h('button', { type: 'submit', class: 'primary' }, '创建部门');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await run(
              () => api('POST', '/api/dept/create', { name: name.value, parentId: parent.value }),
              '部门已创建',
              save,
            )
          ) {
            dialog.close();
            navigate('org');
          }
        },
      },
      field('部门名称', name),
      field('上级部门', parent),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('新建部门', form);
    name.focus();
  }
  /**
   * 收集用户名、姓名及部门并调用用户创建命令；成功后刷新组织页，密码和角色需通过独立操作配置。
   * 页面成功动作基于实际请求结果，不通过直接写表配置账号。
   */
  function createUser() {
    const username = h('input', { required: true, placeholder: '用于登录的账号', autocomplete: 'off' });
    const name = h('input', { required: true, placeholder: '用户真实姓名' });
    const department = selectDepartment();
    const save = h('button', { type: 'submit', class: 'primary' }, '创建用户');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await run(
              () =>
                api('POST', '/api/user/create', {
                  username: username.value,
                  name: name.value,
                  deptId: department.value,
                }),
              '用户已创建，请设置密码并分配角色',
              save,
            )
          ) {
            dialog.close();
            navigate('org');
          }
        },
      },
      field('登录账号', username),
      field('用户姓名', name),
      field('所属部门', department),
      h(
        'p',
        { class: 'inline-info' },
        icon('info'),
        '新用户默认没有角色。创建后请设置登录密码，并按职责配置角色。',
      ),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('新建用户', form);
    username.focus();
  }
  /**
   * 编辑所选用户的完整角色 ID 集合，已有选择作为初值，保存走 User.assignRoles。
   * 界面提示不能代替服务端防提权和角色有效性检查，成功后才关闭并刷新。
   */
  function assignRoles(user: User) {
    const selected = new Set(user.roleIds);
    const save = h('button', { class: 'primary', type: 'submit' }, '保存角色');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await run(
              () => api('POST', `/api/user/${user.id}/assign-roles`, { roleIds: [...selected] }),
              '用户角色已保存',
              save,
            )
          ) {
            dialog.close();
            navigate('org');
          }
        },
      },
      h('p', { class: 'muted' }, `为 ${user.name} 选择角色，多个角色的有效权限会共同生效。`),
      h(
        'div',
        { class: 'choice-list' },
        roles
          .filter((role) => role.status === 'active')
          .map((role) =>
            h(
              'label',
              {},
              h('input', {
                type: 'checkbox',
                checked: selected.has(role.id),
                onchange: (event) => {
                  (event.currentTarget as HTMLInputElement).checked
                    ? selected.add(role.id)
                    : selected.delete(role.id);
                },
              }),
              h('span', {}, h('strong', {}, role.name), h('small', {}, role.code)),
            ),
          ),
      ),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('配置用户角色', form);
  }
  /**
   * 为指定用户打开密码重置表单，提交到独立 set-password 命令。
   * 密码仅保留在表单和请求中；输入校验/授权由服务端再次执行，不影响角色分配。
   */
  function resetPassword(user: User) {
    const password = h('input', {
      type: 'password',
      minlength: 8,
      required: true,
      autocomplete: 'new-password',
      placeholder: '至少 8 位',
    });
    const save = h('button', { type: 'submit', class: 'primary' }, '保存新密码');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          if (
            await run(
              () => api('POST', `/api/user/${user.id}/set-password`, { password: password.value }),
              '密码已重置',
              save,
            )
          )
            dialog.close();
        },
      },
      h('p', { class: 'muted' }, `正在为 ${user.name}（${user.username}）设置新密码。`),
      field('新密码', password),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('重置登录密码', form);
    password.focus();
  }
}
/**
 * 生成组织页的统计展示卡；value 由调用者传入，不能把本页条数误当服务器总数。
 */
function stat(label: string, value: number, glyph: string) {
  return h(
    'div',
    { class: 'stat-card' },
    h('span', { class: 'stat-icon' }, icon(glyph)),
    h('div', {}, h('span', {}, label), h('strong', {}, value)),
  );
}
