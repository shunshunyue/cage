/**
 * 管理模块共享的导航意图出口，避免页面反向依赖应用壳。
 * 改变 hash 触发壳的 hashchange；当前页面再次导航则派发刷新事件重新读取数据。
 */
// 事件让模块只发出导航意图，不反向导入应用壳。
/**
 * 进入指定管理页面或刷新同一页面。page 是应用壳识别的页面键，不是任意外部 URL。
 */
export function navigate(page: string) {
  if (location.hash !== `#/${page}`) location.hash = `#/${page}`;
  else window.dispatchEvent(new Event('cage:refresh'));
}
