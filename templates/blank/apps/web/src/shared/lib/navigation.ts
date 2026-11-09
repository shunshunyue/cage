/**
 * 登录回跳的应用边界：只接受本应用的业务路径，阻止外站及认证/API/静态资源路径回跳。
 * 由路由组合层调用，纯解析 URL 字符串，不发起导航或网络请求。
 */
/** 登录回跳只接受本应用页面；固定基址只用于解析，不会发起网络请求。 */
/**
 * 提取 search 中的 returnTo，使用固定解析基准检查同源路径并排除保留前缀。
 * @param search 登录页查询字符串，可含 URL 编码的 returnTo。
 * @param fallback 缺失、格式不合法或越界时返回的可信业务首页。
 * @returns 可回跳路径，保留其查询参数与 hash；不返回外站 URL。
 */
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
