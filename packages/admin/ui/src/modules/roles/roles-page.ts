/**
 * 角色与授权管理界面，区分能力授予、能力参数和对象数据范围。
 * 页面只按当前登录能力限制可操作项；实际防提权、状态与范围检查由服务端命令执行。
 * 能力切换即时提交，范围编辑先保留草稿再保存，只有成功响应才更新已保存角色快照。
 */
import { api, can, run, state } from '../../shared/api.js';
import { badge, emptyState, field, h, icon, modal, searchInput } from '../../shared/dom.js';
import { invocation, objectName, scopes } from '../../shared/labels.js';
import type { Aggregate, Capability, Dept, List, Role, ScopeKind } from '../../shared/types.js';

// 只保存页面交互，角色和权限仍以命令响应为准；搜索不会改动授权数据。
let selectedRole: string | null = null;
let tab: 'permissions' | 'scopes' = 'permissions';
let query = '';
let filter: 'all' | 'granted' | 'ungranted' = 'all';

/**
 * 读取角色与可访问部门，构建角色列表和权限/范围详情。
 * 角色、筛选词及当前选项卡为页面内状态；列表数据来自有界查询，目录来自启动阶段。
 */
export async function renderRoles(main: HTMLElement) {
  const [result, departmentResult] = await Promise.all([
    api<List<Role>>('GET', '/api/role?pageSize=200'),
    can('Dept.read')
      ? api<List<Dept>>('GET', '/api/dept?pageSize=200')
      : Promise.resolve({ items: [] as Dept[] }),
  ]);
  let roles = result.items;
  if (!selectedRole || !roles.some((role) => role.id === selectedRole)) selectedRole = roles[0]?.id ?? null;
  const list = h('div', { class: 'role-list', 'aria-label': '角色列表' });
  const details = h('div', { class: 'role-details' });
  let roleQuery = '';
  const count = badge(String(roles.length), 'neutral');
  const sidebar = h(
    'aside',
    { class: 'role-sidebar' },
    h('div', { class: 'role-list-heading' }, h('h2', {}, '团队角色'), count),
    h('p', { class: 'muted sidebar-description' }, '选择角色，配置可以做什么、可以看哪些数据。'),
    searchInput('搜索角色名称或编码', (value) => {
      roleQuery = value.toLowerCase();
      renderList();
    }),
    list,
  );
  if (can('Role.create'))
    sidebar.append(
      h('button', { class: 'button primary create-role', onclick: createRole }, icon('plus'), '新建角色'),
    );
  main.append(h('div', { class: 'role-workspace' }, sidebar, details));

  /**
   * 按角色名称或 code 过滤当前加载集合，选择后同步重画详情，不改角色状态或授权。
   */
  function renderList() {
    const visible = roles.filter((role) => `${role.name} ${role.code}`.toLowerCase().includes(roleQuery));
    list.replaceChildren(
      ...visible.map((role) =>
        h(
          'button',
          {
            class: `role-item ${role.id === selectedRole ? 'selected' : ''}`,
            'aria-pressed': role.id === selectedRole,
            onclick: () => {
              selectedRole = role.id;
              renderList();
              renderDetail();
            },
          },
          h('span', { class: 'role-avatar' }, icon('shield')),
          h('span', { class: 'role-item-copy' }, h('strong', {}, role.name), h('small', {}, role.code)),
          role.status !== 'active'
            ? badge('停用')
            : h('span', { class: 'role-item-count' }, role.capabilities.length),
        ),
      ),
    );
    if (!visible.length) list.append(h('p', { class: 'list-empty' }, '没有匹配的角色'));
  }

  /**
   * 提交新角色名称和 code，成功后把真实返回角色加入列表并选中。
   * 新角色没有默认业务能力，后续需要显式授权。
   */
  function createRole() {
    const name = h('input', { placeholder: '例如：采购经理', required: true, maxlength: 100 });
    const code = h('input', {
      placeholder: '例如：purchase_manager',
      required: true,
      pattern: '[a-z][a-z0-9_]*',
    });
    const save = h('button', { class: 'primary', type: 'submit' }, '创建角色');
    const form = h(
      'form',
      {
        class: 'stack-form',
        onsubmit: async (event) => {
          event.preventDefault();
          const created = await run(
            () => api<Role>('POST', '/api/role/create', { name: name.value, code: code.value }),
            '角色已创建，请继续配置权限',
            save,
          );
          if (created) {
            roles = [...roles, created];
            selectedRole = created.id;
            count.textContent = String(roles.length);
            dialog.close();
            renderList();
            renderDetail();
          }
        },
      },
      field('角色名称', name),
      field('角色编码', code, '用于业务识别，使用小写字母、数字和下划线。'),
      h('p', { class: 'inline-info' }, icon('info'), '新角色默认没有操作权限，不会自动获得已有业务能力。'),
      h('div', { class: 'form-actions' }, save),
    );
    const dialog = modal('新建团队角色', form);
    name.focus();
  }

  /**
   * 为选中角色重建摘要与选项卡；已停用角色只展示配置。
   * 局部 updateRole 仅接受服务端成功快照，避免界面把失败请求的临时选择当成已保存授权。
   */
  function renderDetail() {
    let role = roles.find((item) => item.id === selectedRole);
    if (!role) {
      details.replaceChildren(
        emptyState('从一个角色开始', '选择左侧角色，或创建一个新的团队角色。', 'shield'),
      );
      return;
    }
    const updateRole = (updated: Role) => {
      role = updated;
      roles = roles.map((item) => (item.id === updated.id ? updated : item));
      renderList();
    };
    const countText = h('strong', {}, String(role.capabilities.length));
    const summary = h(
      'div',
      { class: 'role-summary' },
      h(
        'div',
        { class: 'role-title' },
        h('span', { class: 'role-emblem' }, icon('shield')),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'title-line' },
            h('h2', {}, role.name),
            badge(
              role.status === 'active' ? '使用中' : '已停用',
              role.status === 'active' ? 'green' : 'neutral',
            ),
          ),
          h('p', {}, h('code', {}, role.code), h('span', {}, '· 按角色统一管理访问权限')),
        ),
      ),
      h('div', { class: 'permission-total' }, countText, h('span', {}, '项已授权')),
    );
    const body = h('div', { class: 'role-tab-body' });
    const buttons = (['permissions', 'scopes'] as const).map((key) =>
      h(
        'button',
        {
          role: 'tab',
          'aria-selected': tab === key,
          class: tab === key ? 'active' : '',
          onclick: () => {
            tab = key;
            renderDetail();
          },
        },
        icon(key === 'permissions' ? 'shield' : 'grid'),
        key === 'permissions' ? '操作权限' : '数据范围',
      ),
    );
    details.replaceChildren(
      summary,
      h('div', { class: 'role-tabs', role: 'tablist', 'aria-label': '角色配置' }, buttons),
      body,
    );
    if (role.status !== 'active')
      body.append(h('div', { class: 'inline-info' }, icon('lock'), '此角色已停用，当前配置仅供查看。'));

    if (tab === 'permissions') {
      const grid = h('div', { class: 'permission-grid' });
      const filteredCount = h('span', { class: 'muted result-count' });
      const filters = h(
        'div',
        { class: 'segmented', 'aria-label': '筛选操作权限' },
        (['all', 'granted', 'ungranted'] as const).map((key) =>
          h(
            'button',
            {
              class: key === filter ? 'active' : '',
              'aria-pressed': key === filter,
              onclick: (event) => {
                filter = key;
                for (const button of filters.querySelectorAll('button')) {
                  button.classList.remove('active');
                  button.setAttribute('aria-pressed', 'false');
                }
                const button = event.currentTarget as HTMLButtonElement;
                button.classList.add('active');
                button.setAttribute('aria-pressed', 'true');
                renderGroups();
              },
            },
            { all: '全部', granted: '已授权', ungranted: '未授权' }[key],
          ),
        ),
      );
      body.append(
        h(
          'div',
          { class: 'permission-toolbar' },
          searchInput(
            '搜索业务、操作名称或权限标识',
            (value) => {
              query = value;
              renderGroups();
            },
            query,
          ),
          filters,
        ),
        h(
          'div',
          { class: 'permission-help' },
          h('span', {}, icon('info'), '勾选后即时保存。只能授予你已拥有的权限。'),
          filteredCount,
        ),
        grid,
      );

      /**
       * 根据搜索词和已授权筛选生成能力分组，业务对象排在系统对象之前。
       * 授权计数来自 role.capabilities，当前显示计数来自筛选集合，两者分别表达不同含义。
       */
      function renderGroups() {
        const granted = new Map(role!.capabilities.map((item) => [item.capability, item.params]));
        const search = query.trim().toLowerCase();
        const groups = new Map<string, Capability[]>();
        const visible = state.catalog!.capabilities.filter((item) => {
          const has = granted.has(item.capability);
          return (
            (filter === 'all' || (filter === 'granted' ? has : !has)) &&
            `${item.label} ${item.description ?? ''} ${item.capability} ${item.aggregate ? objectName(item.aggregate) : '系统管理'}`
              .toLowerCase()
              .includes(search)
          );
        });
        for (const capability of visible) {
          const key = capability.aggregate ?? 'system';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(capability);
        }
        grid.replaceChildren();
        filteredCount.textContent = `显示 ${visible.length} 项权限`;
        countText.textContent = String(role!.capabilities.length);
        // 客户业务排在前面，框架自带的组织与运维权限放在后面，先回答业务人员最关心的问题。
        const builtIn = new Set(['Dept', 'User', 'Role', 'system']);
        const ordered = [...groups].sort(([a], [b]) => Number(builtIn.has(a)) - Number(builtIn.has(b)));
        for (const [name, capabilities] of ordered) {
          const isSystem = name === 'system';
          const grantedCount = capabilities.filter((item) => granted.has(item.capability)).length;
          const card = h(
            'section',
            { class: 'permission-card' },
            h(
              'div',
              { class: 'permission-card-heading' },
              h(
                'span',
                { class: `group-icon ${isSystem ? 'system' : ''}` },
                icon(isSystem ? 'lock' : 'grid'),
              ),
              h(
                'div',
                { class: 'group-title' },
                h('h3', {}, isSystem ? '系统管理' : objectName(name)),
                h('code', {}, isSystem ? 'SYSTEM' : name),
              ),
              h('span', { class: 'group-progress' }, `${grantedCount} / ${capabilities.length}`),
            ),
          );
          for (const capability of capabilities) card.append(permissionRow(capability, granted));
          grid.append(card);
        }
        if (!visible.length)
          grid.append(emptyState('没有找到匹配的权限', '换一个关键词，或调整上方授权筛选。', 'search'));
      }

      /**
       * 构建能力开关及可选额度编辑器，按钮依据角色状态和当前操作者能力启用。
       * 切换失败恢复旧勾选值，成功更新角色快照；额度保存保留已有参数并替换 ceiling。
       */
      function permissionRow(capability: Capability, granted: Map<string, Record<string, unknown> | null>) {
        const checked = granted.has(capability.capability);
        const authorized =
          role!.status === 'active' &&
          can(checked ? 'Role.revokeCapability' : 'Role.grantCapability') &&
          (checked || can(capability.capability));
        const mode = invocation(capability);
        const toggle = h('input', {
          type: 'checkbox',
          checked,
          disabled: !authorized,
          'aria-label': `${checked ? '收回' : '授予'} ${capability.label}`,
          onchange: async () => {
            toggle.disabled = true;
            const updated = await run(
              () =>
                api<Role>(
                  'POST',
                  `/api/role/${role!.id}/${toggle.checked ? 'grant-capability' : 'revoke-capability'}`,
                  { capability: capability.capability },
                ),
              toggle.checked ? '操作权限已授予' : '操作权限已收回',
            );
            if (updated) {
              updateRole(updated);
              renderGroups();
            } else {
              toggle.checked = checked;
              toggle.disabled = !authorized;
            }
          },
        });
        const title = capability.aggregate
          ? capability.label.replaceAll(capability.aggregate, objectName(capability.aggregate))
          : capability.label;
        const row = h(
          'div',
          { class: `permission-row ${checked ? 'granted' : ''}` },
          h(
            'label',
            {
              class: 'permission-toggle',
              title:
                !authorized && !checked
                  ? '你没有该权限，无法授予其他角色'
                  : capability.kind === 'command'
                    ? capability.description || title
                    : title,
            },
            toggle,
            h('span', { class: 'checkbox-visual' }, icon('check')),
            h(
              'span',
              { class: 'permission-copy' },
              h('span', { class: 'permission-name' }, title),
              h('code', {}, capability.capability),
            ),
          ),
          mode &&
            h(
              'span',
              { class: 'invocation-badge', title: '配置此权限后，仍需通过对应流程或外部接口调用' },
              mode,
            ),
        );
        if (
          checked &&
          (capability.capability.endsWith('.approve') ||
            granted.get(capability.capability)?.ceiling !== undefined)
        ) {
          const ceiling = h('input', {
            type: 'number',
            min: 0,
            step: 'any',
            placeholder: '请设置额度',
            value: String(granted.get(capability.capability)?.ceiling ?? ''),
            required: true,
            disabled:
              !can('Role.grantCapability') || !can(capability.capability) || role!.status !== 'active',
            'aria-label': `${title}额度上限`,
          });
          const save = h(
            'button',
            { type: 'submit', class: 'small', disabled: ceiling.disabled },
            '保存额度',
          );
          row.append(
            h(
              'form',
              {
                class: 'limit-form',
                onsubmit: async (event) => {
                  event.preventDefault();
                  const updated = await run(
                    () =>
                      api<Role>('POST', `/api/role/${role!.id}/grant-capability`, {
                        capability: capability.capability,
                        params: { ...granted.get(capability.capability), ceiling: Number(ceiling.value) },
                      }),
                    '额度已保存',
                    save,
                  );
                  if (updated) {
                    updateRole(updated);
                    renderGroups();
                  }
                },
              },
              h('span', {}, '额度上限'),
              ceiling,
              save,
            ),
          );
        }
        return row;
      }
      renderGroups();
    } else {
      body.append(
        h(
          'div',
          { class: 'inline-info' },
          icon('info'),
          '操作权限决定“可以做什么”，数据范围决定“可以看哪些记录”。未单独配置的对象沿用默认范围。',
        ),
      );
      const scopeGrid = h('div', { class: 'scope-grid' });
      for (const aggregate of [
        { name: '*', label: '默认数据范围', scope: { ownerField: null, deptField: null } },
        ...state.catalog!.aggregates,
      ])
        scopeGrid.append(scopeCard(aggregate));
      body.append(scopeGrid);
    }

    /**
     * 构建某聚合的范围编辑卡，区分显式范围、通配继承与未配置时 self。
     * 可选组合子受聚合 owner/dept 字段约束；deptSet 保留已选 ID，即使当前部门列表无法读取。
     * 提交 null 删除显式配置，成功后重画详情以反映真实服务端结果。
     */
    function scopeCard(aggregate: Aggregate) {
      const current = role!.scopes.find((scope) => scope.aggregate === aggregate.name);
      const inherited = role!.scopes.find((scope) => scope.aggregate === '*');
      const editable = role!.status === 'active' && can('Role.setScope');
      const usable = state.catalog!.combinators.filter(
        (kind) =>
          aggregate.name === '*' ||
          kind === 'all' ||
          (kind === 'self' ? aggregate.scope.ownerField : aggregate.scope.deptField),
      );
      const selected = new Set(current?.deptIds ?? []);
      const departmentBox = h(
        'div',
        { class: 'department-options' },
        departmentResult.items.map((dept) =>
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              checked: selected.has(dept.id),
              disabled: !editable,
              onchange: (event) => {
                (event.currentTarget as HTMLInputElement).checked
                  ? selected.add(dept.id)
                  : selected.delete(dept.id);
                dirty();
              },
            }),
            dept.name,
          ),
        ),
      );
      if (!departmentResult.items.length)
        departmentBox.append(
          h(
            'p',
            { class: 'muted' },
            can('Dept.read') ? '当前没有可选择的部门' : '需要查看部门权限才能调整部门清单，已有选择会保留。',
          ),
        );
      const status = h('span', { class: 'save-state' }, '已保存');
      const save = h('button', { class: 'small', type: 'submit', disabled: true }, '保存范围');
      const description = h('p', { class: 'scope-description' });
      const select = h(
        'select',
        {
          value: current?.combinator ?? '',
          disabled: !editable,
          'aria-label': `${aggregate.label}的数据范围`,
          onchange: () => {
            updateDescription();
            dirty();
          },
        },
        h(
          'option',
          { value: '' },
          aggregate.name === '*'
            ? '未配置（按仅本人处理）'
            : `沿用默认：${scopes[inherited?.combinator ?? 'self'].title}`,
        ),
        usable.map((kind) => h('option', { value: kind }, scopes[kind as ScopeKind].title)),
      );
      /**
       * 只标记当前范围表单有未保存变化并启用保存按钮，不立即修改角色快照。
       */
      function dirty() {
        status.textContent = '尚未保存';
        status.classList.add('pending');
        save.disabled = !editable;
      }
      /**
       * 解释当前选择或继承后的范围效果；缺所需归属字段时明确无法匹配记录。
       * 该提示不自动扩大授权，指定部门选择框仅在 deptSet 下显示。
       */
      function updateDescription() {
        const kind = select.value as ScopeKind;
        description.textContent = kind ? scopes[kind].hint : '由默认数据范围决定；默认未配置时按仅本人处理。';
        const effective = kind || inherited?.combinator || 'self';
        // 继承允许保留统一默认值，但不能把不适用的范围解释成“可查看本部门”。
        // 这里只说明真实效果，不修改授权，也不替用户扩大到全部数据。
        if (aggregate.name !== '*' && effective === 'self' && !aggregate.scope.ownerField)
          description.textContent += ' 此对象未设置本人归属，当前范围无法匹配记录。';
        else if (
          aggregate.name !== '*' &&
          ['dept', 'deptSubtree', 'deptSet'].includes(effective) &&
          !aggregate.scope.deptField
        )
          description.textContent += ' 此对象未设置部门归属，当前范围无法匹配记录。';
        departmentBox.hidden = kind !== 'deptSet';
      }
      updateDescription();
      const form = h(
        'form',
        {
          class: `scope-card ${aggregate.name === '*' ? 'default-scope' : ''}`,
          onsubmit: async (event) => {
            event.preventDefault();
            const updated = await run(
              () =>
                api<Role>('POST', `/api/role/${role!.id}/set-scope`, {
                  aggregate: aggregate.name,
                  combinator: select.value || null,
                  ...(select.value === 'deptSet' ? { deptIds: [...selected] } : {}),
                }),
              '数据范围已保存',
              save,
            );
            if (updated) {
              updateRole(updated);
              renderDetail();
            }
          },
        },
        h(
          'div',
          { class: 'scope-heading' },
          h(
            'div',
            {},
            h('h3', {}, aggregate.name === '*' ? aggregate.label : objectName(aggregate.name)),
            h('code', {}, aggregate.name === '*' ? '适用于未单独配置的业务对象' : aggregate.name),
          ),
          aggregate.name === '*' && badge('默认', 'green'),
        ),
        select,
        description,
        departmentBox,
        h('div', { class: 'scope-footer' }, status, save),
      );
      return form;
    }
  }
  renderList();
  renderDetail();
}
