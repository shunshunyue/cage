// 事件让模块只发出导航意图，不反向导入应用壳。
export function navigate(page: string) {
  if (location.hash !== `#/${page}`) location.hash = `#/${page}`;
  else window.dispatchEvent(new Event('cage:refresh'));
}
