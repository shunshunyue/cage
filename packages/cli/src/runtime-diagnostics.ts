/**
 * CLI 获取运行态诊断的受控 HTTP 客户端，供 doctor、timeline、explain 调用。
 * 校验同源 HTTP 地址，从单行 Cookie 文件读会话；POST 先取 CSRF 并合并服务端 Cookie，再提交解释请求。
 * 不把凭据放进返回报告，不跟随重定向；单请求超时为 5 秒，网络/JSON 错误传播，HTTP 拒绝保留状态。
 */
// Credentials stay in controlled files. Diagnostic POST explains authorization without executing the command.
import { readFileSync } from 'node:fs';
import { abs, type CageConfig } from './config.js';

/**
 * 运行证据请求配置；地址不带凭据，Cookie 来自文件，fetch 可注入测试实现。
 */
export interface RuntimeOptions { /** 用户显式指定的运行实例 HTTP(S) 根地址，不能夹带凭据。 */ runtimeUrl?: string; /** 可选纯 Cookie 头文件路径，仅请求时读取，不回显到诊断报告。 */ cookieFile?: string; /** 可注入网络实现供测试使用；缺省使用平台 fetch。 */ fetch?: typeof fetch }
/**
 * 请求实际服务的诊断，POST 先取得 CSRF 并合并 Cookie。
 * @param cfg 解析 Cookie 文件的应用根。
 * @param options HTTP(S) 地址、Cookie 文件与可注入 fetch。
 * @param path 必须位于指定服务同一 origin。
 * @param request query 省略 undefined 值，body 存在时使用 POST。
 * @returns 时间、HTTP 状态与数据，HTTP 拒绝为 ok=false；网络、超时、JSON 错误抛出。
 */
export async function runtimeDiagnostic(cfg: CageConfig, options: RuntimeOptions, path: string, request: { query?: Record<string, string | undefined>; body?: unknown } = {}) {
  if (!options.runtimeUrl) throw new Error('[CAGE-DIAG-001] 指定 --runtime-url；会话凭据通过 --cookie-file 传入，不放在命令行或 URL');
  let base: URL;
  try { base = new URL(options.runtimeUrl); }
  catch { throw new Error('[CAGE-DIAG-001] 无法解析运行证据地址；请提供 HTTP(S) 服务地址'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('[CAGE-DIAG-001] 运行证据地址须为无内嵌凭证、查询参数或片段的 HTTP(S) 地址');
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('[CAGE-DIAG-001] 诊断路径必须位于指定运行服务的同一来源');
  for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) target.searchParams.set(key, value);
  let cookie = options.cookieFile ? readFileSync(abs(cfg, options.cookieFile), 'utf8').trim() : '';
  if (/[\r\n]/.test(cookie)) throw new Error('[CAGE-DIAG-001] Cookie 文件必须只包含一行 Cookie 请求头值');
  const fetcher = options.fetch ?? fetch;
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (request.body !== undefined) {
    const csrf = await fetcher(new URL('/auth/csrf', target), { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!csrf.ok) return { schemaVersion: 1, observedAt: new Date().toISOString(), ok: false, status: csrf.status, data: { code: 'CSRF_UNAVAILABLE' } };
    const cookies = new Map(cookie.split(';').filter(Boolean).map(part => { const value = part.trim(); const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
    for (const setCookie of csrf.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0];
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const body = await csrf.json() as { token: string };
    headers['x-csrf-token'] = body.token;
    headers['content-type'] = 'application/json';
  }
  const response = await fetcher(target, { method: request.body === undefined ? 'GET' : 'POST', headers, body: request.body === undefined ? undefined : JSON.stringify(request.body), signal: AbortSignal.timeout(5000), redirect: 'error' });
  const data = await response.json();
  return { schemaVersion: 1, observedAt: new Date().toISOString(), ok: response.ok, status: response.status, data };
}
