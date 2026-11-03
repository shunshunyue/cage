// LISTEN/NOTIFY 只加速失效；连接异常期间每次实时解析授权，不继续使用旧缓存。
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import { LRUCache } from 'lru-cache';
import pg from 'pg';

export class CtxCache {
  private readonly cache = new LRUCache<string, Ctx>({ max: 5000, ttl: 5 * 60_000 });
  private listener: pg.Client | null = null;
  private stopped = false;
  private connected = false;
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly kernel: Kernel) {}

  get healthy(): boolean { return this.connected && !this.stopped; }

  async resolve(userId: string, tenantId: string): Promise<Ctx | null> {
    const key = `${tenantId}:${userId}`;
    const generation = this.generation;
    const hit = this.healthy ? this.cache.get(key) : undefined;
    if (hit) return hit;
    const ctx = await this.kernel.contextFor(userId, tenantId);
    // 解析期间收到撤权通知或发生断线，不能把旧的查询结果重新放回缓存。
    if (ctx && this.healthy && generation === this.generation) this.cache.set(key, ctx);
    return ctx;
  }

  invalidate(payload: string): void {
    this.generation++;
    if (payload === '*') this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.endsWith(`:${payload}`)) this.cache.delete(k);
  }

  /** 重连成功后也清空，覆盖断线期间未收到通知的授权变化。 */
  async listen(appUrl: string): Promise<void> {
    if (this.stopped || this.healthy) return;
    if (this.connecting) return this.connecting;
    const connect = async () => {
      const client = new pg.Client({ connectionString: appUrl, application_name: 'cage-grants-listen', connectionTimeoutMillis: 5000 });
      let failed = false;
      const disconnected = () => {
        if (failed) return;
        failed = true;
        if (this.listener === client) this.listener = null;
        this.connected = false;
        this.invalidate('*');
        void client.end().catch(() => {});
        if (!this.stopped && !this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null;
            void this.listen(appUrl);
          }, 5000);
          this.retry.unref();
        }
      };
      client.on('error', disconnected);
      client.on('end', disconnected);
      client.on('notification', (notification) => this.invalidate(notification.payload ?? '*'));
      try {
        await client.connect();
        await client.query('LISTEN cage_grants');
        if (this.stopped || failed) { await client.end(); return; }
        this.invalidate('*');
        this.listener = client;
        this.connected = true;
      } catch (error) {
        this.kernel.log.warn({ err: error }, '授权变更监听连接失败，实时复核授权并在 5 秒后重试');
        disconnected();
      }
    };
    this.connecting = connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.invalidate('*');
    if (this.retry) clearTimeout(this.retry);
    await this.connecting;
    await this.listener?.end();
    this.listener = null;
  }
}
