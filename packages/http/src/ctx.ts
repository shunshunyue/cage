// LISTEN/NOTIFY 只加速失效；连接异常期间每次实时解析授权，不继续使用旧缓存。
import type { Ctx, Kernel } from '@yss123/cage-kernel';
import { LRUCache } from 'lru-cache';
import pg from 'pg';

/** 跨请求复用用户授权上下文，减少正常流量下反复查询组织表的开销。
 * PostgreSQL 通知用于主动失效；监听不健康时缓存失效并逐请求读库，避免撤权后继续使用旧授权。
 * generation 让通知前发起、通知后完成的查询无法把旧结果重新写回缓存。
 */
export class CtxCache {
  private readonly cache = new LRUCache<string, Ctx>({ max: 5000, ttl: 5 * 60_000 });
  private listener: pg.Client | null = null;
  private stopped = false;
  private connected = false;
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;

  /** 复用服务的内核和授权解析，不创建额外业务连接池；监听另用专用连接。 */
  constructor(private readonly kernel: Kernel) {}

  /** 仅代表撤权通知链路可用且尚未停止；数据库读写就绪由服务探针分别检查。 */
  get healthy(): boolean { return this.connected && !this.stopped; }

  /** 按租户和用户查当前授权；不存在返回 null，禁用用户无有效能力，监听失效时不读取/填充缓存。 */
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

  /** 通知载荷为用户 ID 或 *；用户 ID 会清除所有匹配租户缓存，且推进查询代次。 */
  invalidate(payload: string): void {
    this.generation++;
    if (payload === '*') this.cache.clear();
    else for (const k of [...this.cache.keys()]) if (k.endsWith(`:${payload}`)) this.cache.delete(k);
  }

  /** 建立单个专用 LISTEN 连接，并合并并发连接请求；失败后每五秒重试。
   * 断线立即切到逐请求授权读取，重连成功才恢复缓存，不能把重试中的状态视为健康。
   * 重连成功后也清空缓存，覆盖断线期间未收到通知的授权变化。
   */
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

  /** 先禁止重连和缓存命中，再等待连接尝试并关闭监听；适合服务停止阶段调用。 */
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
