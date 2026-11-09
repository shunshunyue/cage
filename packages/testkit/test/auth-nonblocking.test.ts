// 受控派生延迟只证明等待期间的可调度性与队列边界，不作为机器吞吐量基准。
import { setImmediate as immediate } from 'node:timers/promises';
import * as org from '@yss123/cage-admin/domain';
import { expect, it, vi } from 'vitest';
import { PasswordVerifier } from '../../http/src/auth.js';
import { createServer } from '../../http/src/server.js';
import { createTestEnv } from '../src/index.js';

/** 在模块加载前截获 scrypt 回调，由测试显式释放；避免依赖机器 CPU 速度决定认证排队时序。 */
const held = vi.hoisted(() => ({ callbacks: [] as ((error: Error | null, key: Buffer) => void)[] }));
vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(),
  scrypt: (_password: string, _salt: string, _length: number, callback: (error: Error | null, key: Buffer) => void) => { held.callbacks.push(callback); },
}));

/**
 * 第一请求占派生槽、第二排队、第三被拒绝，普通路由此时仍应响应；随后分别释放成功与失败回调。
 * finally 会先解开全部受控等待并收集请求，再恢复 mock、关闭服务和测试库，避免断言失败导致悬挂。
 */
it('密码派生等待期间普通 HTTP 能先响应，认证队列有界且派生失败后释放名额', async () => {
  const env = await createTestEnv({ domain: org });
  const server = createServer({ domain: {}, urls: env.urls, logger: false, admin: false, csrf: false, auth: { passwordConcurrency: 1, passwordQueueLimit: 1 } });
  server.app.get('/ordinary', async () => { await immediate(); return { responsive: true }; });
  await server.ready();
  vi.spyOn(server.kernel.log, 'error').mockImplementation(() => {});
  const verification = vi.spyOn(PasswordVerifier.prototype, 'verify');
  const requests: Promise<unknown>[] = [];
  let completed = 0;
  const login = () => {
    const pending = server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'nonexistent', password: 'synthetic-password' } })
      .then((response) => { completed++; return response; });
    requests.push(pending);
    return pending;
  };
  try {
    const first = login();
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    const second = login();
    // 两个查库请求完成后，队列中的请求仍不能进入派生，第三个必须明确拒绝。
    await vi.waitFor(() => expect(verification).toHaveBeenCalledTimes(2));
    expect((await login()).statusCode).toBe(429);
    const ordinary = await server.app.inject({ url: '/ordinary' });
    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json()).toEqual({ responsive: true });
    expect(completed).toBe(1); // 只有队列满的请求完成，两个派生请求仍在等待。
    expect(held.callbacks).toHaveLength(1);

    held.callbacks.shift()!(null, Buffer.alloc(32));
    expect((await first).statusCode).toBe(401);
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    held.callbacks.shift()!(new Error('synthetic-derivation-failure'), Buffer.alloc(0));
    expect((await second).statusCode).toBe(500);
    const afterFailure = login();
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    held.callbacks.shift()!(null, Buffer.alloc(32));
    expect((await afterFailure).statusCode).toBe(401);
  } finally {
    // 断言失败时也释放受控回调，避免测试服务器等待未完成请求而悬挂。
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const callback of held.callbacks.splice(0)) callback(new Error('synthetic-test-cleanup'), Buffer.alloc(0));
      await immediate();
    }
    await Promise.allSettled(requests);
    vi.restoreAllMocks();
    await server.close();
    await env.close();
  }
});
