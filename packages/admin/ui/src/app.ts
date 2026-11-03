import { api, ApiError, state } from './shared/api.js';
import { h, icon } from './shared/dom.js';
import type { Catalog, Me } from './shared/types.js';
import { render } from './app/shell.js';

/** 浏览器入口恢复真实会话与展示目录，不包含具体页面、表单或授权逻辑。 */
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
