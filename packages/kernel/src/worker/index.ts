// worker 进程：投递 outbox、执行反应、启动审批、跑定时任务、调用第三方。与 api 同一份代码和镜像，只是启动命令不同。
import { sql } from 'kysely';
import type pg from 'pg';
import { dedicatedClient, urlsFromEnv, type DatabaseUrls } from '../db/connect.js';
import { createKernel, type Kernel } from '../kernel.js';
import { consoleLogger, type Logger } from '../telemetry.js';
import {
  type ApprovalEngine, approvalConsumers, extensionConsumers, reactionConsumers, routeEngines,
} from './consumers.js';
import { claimBatch, deliver, type EventConsumer, MAX_ATTEMPTS, sweepStale } from './outbox.js';
import { nextRun, tick } from './scheduler.js';

export * from './outbox.js';
export * from './consumers.js';
export * from './scheduler.js';

export interface WorkerOptions {
  domain?: object | object[];
  kernel?: Kernel;
  urls?: DatabaseUrls;
  /** 同时处理的事件数 */
  concurrency?: number;
  /** 没收到 NOTIFY 时的轮询间隔 */
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** 外部审批引擎（按流程名）；不传时使用代码内封闭路由 */
  approvalEngines?: Record<string, ApprovalEngine>;
  /** 额外的事件消费者 */
  consumers?: EventConsumer[];
  /** 是否运行定时任务，默认 true */
  jobs?: boolean;
  logger?: Logger;
}

export interface WorkerHandle {
  kernel: Kernel;
  consumers: EventConsumer[];
  /** 处理到 outbox 为空为止（测试和 cage dev 用） */
  drain(maxRounds?: number): Promise<number>;
  stop(): Promise<void>;
}

export function buildConsumers(k: Kernel, opts: Pick<WorkerOptions, 'approvalEngines' | 'consumers'> = {}): EventConsumer[] {
  const engines = { ...routeEngines(k), ...(opts.approvalEngines ?? {}) };
  return [...reactionConsumers(k), ...approvalConsumers(k, engines), ...extensionConsumers(k), ...(opts.consumers ?? [])];
}

/** 不启动循环，只创建可手动驱动的 worker（测试用） */
export function createWorker(k: Kernel, opts: WorkerOptions = {}): Omit<WorkerHandle, 'stop'> {
  const consumers = buildConsumers(k, opts);
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  return {
    kernel: k,
    consumers,
    async drain(maxRounds = 50) {
      let n = 0;
      for (let i = 0; i < maxRounds; i++) {
        const rows = await claimBatch(k, opts.concurrency ?? 8);
        if (rows.length === 0) break;
        await Promise.all(rows.map((r) => deliver(k, r, consumers, max)));
        n += rows.length;
      }
      return n;
    },
  };
}

export async function startWorker(opts: WorkerOptions = {}): Promise<WorkerHandle> {
  const log = opts.logger ?? consoleLogger;
  const urls = opts.urls ?? (opts.kernel ? undefined : urlsFromEnv());
  const k = opts.kernel ?? createKernel({ domain: opts.domain ?? {}, urls, logger: log });
  const w = createWorker(k, opts);
  const concurrency = opts.concurrency ?? 8;
  const poll = opts.pollIntervalMs ?? 500;
  let stopped = false;
  let wake: (() => void) | null = null;
  const timers: NodeJS.Timeout[] = [];

  // LISTEN：有新事件时立刻醒来，不用等轮询
  const appUrl = urls?.app ?? urlsFromEnv().app;
  const listener: pg.Client = await dedicatedClient(appUrl, 'cage-worker-listen');
  await listener.query('LISTEN cage_outbox');
  listener.on('notification', () => wake?.());
  listener.on('error', (e) => log.error({ err: String(e) }, 'outbox 监听连接出错'));

  const loop = (async () => {
    while (!stopped) {
      try {
        const rows = await claimBatch(k, concurrency);
        if (rows.length > 0) {
          await Promise.all(rows.map((r) => deliver(k, r, w.consumers, opts.maxAttempts ?? MAX_ATTEMPTS)));
          continue;
        }
      } catch (e) {
        log.error({ err: String(e) }, 'outbox 领取失败');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, poll);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  })();

  // 清扫与日常维护
  timers.push(setInterval(() => void sweepStale(k).catch(() => {}), 60_000));
  const housekeeping = async () => {
    try {
      await sql`select sys.ensure_audit_partitions(3)`.execute(k.app);
      await k.app.deleteFrom('sys.idempotency').where('expires_at', '<', new Date()).execute();
      await k.app.deleteFrom('sys.session').where('expires_at', '<', new Date()).execute();
    } catch (e) {
      log.warn({ err: String(e) }, '日常维护失败');
    }
  };
  void housekeeping();
  timers.push(setInterval(() => void housekeeping(), 3600_000));

  // 定时任务
  let lockConn: pg.Client | null = null;
  if (opts.jobs !== false && k.registry.jobs.length > 0) {
    lockConn = await dedicatedClient(appUrl, 'cage-scheduler');
    const due = new Map(k.registry.jobs.map((j) => [j.name, nextRun(j.cron, new Date())]));
    timers.push(
      setInterval(() => {
        const now = new Date();
        for (const j of k.registry.jobs) {
          const at = due.get(j.name)!;
          if (now < at) continue;
          due.set(j.name, nextRun(j.cron, now));
          void tick(k, j, lockConn!, at).catch((e) => log.error({ job: j.name, err: String(e) }, '调度失败'));
        }
      }, 5_000),
    );
  }

  log.info({ consumers: w.consumers.map((c) => c.name), jobs: k.registry.jobs.map((j) => j.name) }, 'worker 已启动');

  return {
    ...w,
    async stop() {
      stopped = true;
      wake?.();
      for (const t of timers) clearInterval(t);
      await loop;
      await listener.end().catch(() => {});
      await lockConn?.end().catch(() => {});
      if (!opts.kernel) await k.close();
    },
  };
}
