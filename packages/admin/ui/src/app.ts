/**
 * 系统管理浏览器入口：恢复登录身份、加载展示目录，再交给 shell 组合页面。
 * 监听 hash 导航、刷新及会话过期事件；未登录进入登录页，网络或服务异常显示可重试连接状态。
 * 本入口不保存授权或执行领域逻辑，真实身份与目录通过同源 HTTP 请求获取。
 */
import { api, ApiError, state } from './shared/api.js';
import { h, icon } from './shared/dom.js';
import type { Catalog, Me } from './shared/types.js';
import { render } from './app/shell.js';

/** 浏览器入口恢复真实会话与展示目录，不包含具体页面、表单或授权逻辑。 */
/**
 * 按顺序读取 /api/me 与管理目录，成功后渲染当前 hash 页面。
 * 仅 UNAUTHENTICATED 走未登录界面；其他故障保留明确重连入口，避免把网络异常伪装为退出。
 * 此函数也作为登录成功回调和重新连接动作，恢复失败通过页面反馈。
 */
async function boot() {
  try {
    state.me = await api<Me>('GET', '/api/me');
    state.catalog = await api<Catalog>('GET', '/api/sys/catalog');
    await render(boot);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
      await render(boot);
      return;
    }
    document
      .getElementById('app')!
      .replaceChildren(
        h(
          'main',
          { class: 'connection-state' },
          h('span', { class: 'brand-mark' }, icon('grid')),
          h('h1', {}, '暂时无法连接工作空间'),
          h('p', {}, '请检查网络与 API 服务，然后重新尝试。'),
          h('button', { class: 'primary', onclick: boot }, '重新连接'),
        ),
      );
  }
}
window.addEventListener('hashchange', () => void render(boot));
window.addEventListener('cage:refresh', () => void render(boot));
window.addEventListener('cage:session-expired', () => void render(boot));
void boot();
