/**
 * 构造系统管理登录页面，复用统一 JSON/CSRF 请求和操作反馈。
 * 账号密码只用于本次登录表单；成功清掉旧 CSRF 后由上层重新加载真实身份和目录，SSO 使用独立服务端入口。
 */
import { api, run, state } from '../../shared/api.js';
import { field, h, icon } from '../../shared/dom.js';

/**
 * 返回未挂载的登录页面 DOM。提交期间禁用按钮，失败由 run 显示原因并保留可重试表单。
 * onLogin 仅在登录请求成功后等待执行，负责恢复会话并切换页面；本组件不自行伪造身份或能力列表。
 */
export function loginPage(onLogin: () => Promise<void>) {
  const username = h('input', {
    name: 'username',
    placeholder: '请输入登录账号',
    autocomplete: 'username',
    required: true,
  });
  const password = h('input', {
    name: 'password',
    type: 'password',
    placeholder: '请输入密码',
    autocomplete: 'current-password',
    required: true,
  });
  const submit = h('button', { class: 'primary', type: 'submit' }, '登录系统管理', icon('arrow'));
  const form = h(
    'form',
    {
      class: 'stack-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const result = await run(
          () => api('POST', '/auth/login', { username: username.value, password: password.value }),
          undefined,
          submit,
        );
        if (result) {
          state.csrf = null;
          await onLogin();
        }
      },
    },
    field('登录账号', username),
    field('密码', password),
    submit,
  );
  return h(
    'main',
    { class: 'login-layout' },
    h(
      'section',
      { class: 'login-story' },
      h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark' }, icon('grid')), 'Cage'),
      h(
        'div',
        {},
        h('span', { class: 'eyebrow' }, '系统管理工作台'),
        h('h1', {}, '让协作有序，', h('br'), '让权限清晰。'),
        h('p', {}, '从团队与角色，到流程与运行记录。', h('br'), '在一个工作空间里，管理业务的基础。'),
      ),
      h('small', {}, '团队协作 · 权限管理 · 运行追踪'),
    ),
    h(
      'section',
      { class: 'login-panel' },
      h('span', { class: 'eyebrow' }, '欢迎回来'),
      h('h2', {}, '登录你的工作空间'),
      h('p', { class: 'muted' }, '使用管理员为你配置的账号继续。'),
      form,
      h('a', { class: 'sso-link', href: '/auth/sso' }, '使用企业单点登录', icon('arrow')),
      h('p', { class: 'login-footnote' }, icon('lock'), '使用安全会话连接，操作受权限与数据范围约束。'),
    ),
  );
}
