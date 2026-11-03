// Credentials stay in controlled files. Diagnostic POST explains authorization without executing the command.
import { readFileSync } from 'node:fs';
import { abs, type CageConfig } from './config.js';

export interface RuntimeOptions { runtimeUrl?: string; cookieFile?: string; fetch?: typeof fetch }
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
