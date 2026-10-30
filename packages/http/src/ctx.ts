// 上下文解析与缓存：每个请求都需要用户的角色、能力和范围。结果缓存在进程内；
// 授权一旦变化，用 PostgreSQL 的 LISTEN/NOTIFY 通知所有实例清掉缓存。NOTIFY 是事务性的：提交成功才会发出。
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import { LRUCache } from 'lru-cache';
import pg from 'pg';

export class CtxCache {
  private readonly cache = new LRUCache<string, Ctx>({ max: 5000, ttl: 5 * 60_000 });
  private listener: pg.Client | null = null;
  private stopped = false;

  constructor(private readonly kernel: Kernel) {}

  async resolve(userId: string, tenantId: string): Promise<Ctx | null> {
    const key = `${tenantId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const ctx = await this.kernel.contextFor(userId, tenantId);
    if (ctx) this.cache.set(key, ctx);
    return ctx;
  }

  invalidate(payload: string): void {
    if (payload === '*') this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.endsWith(`:${payload}`)) this.cache.delete(k);
  }

  /** 进程启动时调用一次；连接断开后自动重连 */
  async listen(appUrl: string): Promise<void> {
    const connect = async () => {
      if (this.stopped) return;
      try {
        const c = new pg.Client({ connectionString: appUrl, application_name: 'cage-grants-listen' });
        await c.connect();
        await c.query('LISTEN cage_grants');
        c.on('notification', (n) => this.invalidate(n.payload ?? '*'));
        c.on('error', () => {
          this.cache.clear();
          setTimeout(() => void connect(), 5000);
        });
        this.listener = c;
      } catch (e) {
        this.kernel.log.warn({ err: String(e) }, '授权变更监听连接失败，5 秒后重试');
        setTimeout(() => void connect(), 5000);
      }
    };
    await connect();
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.listener?.end().catch(() => {});
  }
}
