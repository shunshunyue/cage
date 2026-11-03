/** 登录回跳只接受本应用页面；固定基址只用于解析，不会发起网络请求。 */
export function loginReturnTo(search: string, fallback: string): string {
  const requested = new URLSearchParams(search).get('returnTo');
  const origin = 'https://cage.local';
  if (!requested?.startsWith('/') || !URL.canParse(requested, origin)) return fallback;
  const url = new URL(requested, origin);
  // 保留查询条件和锚点；阻止外站跳转、登录循环及把服务端入口当成 React 页面。
  if (url.origin !== origin || /^\/(login|admin|api|auth|hooks|assets)(\/|$)/.test(url.pathname))
    return fallback;
  return url.pathname + url.search + url.hash;
}
