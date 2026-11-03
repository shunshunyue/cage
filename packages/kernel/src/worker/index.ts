// worker 进程：投递 outbox、执行反应、启动审批、跑定时任务、调用第三方。与 api 同一份代码和镜像，只是启动命令不同。
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { dedicatedClient, urlsFromEnv, type DatabaseUrls } from '../db/connect.js';
import { createKernel, type Kernel } from '../kernel.js';
import { consoleLogger, type Logger } from '../telemetry.js';
import {
  type ApprovalEngine, approvalConsumers, extensionConsumers, reactionConsumers, routeEngines,
} from './consumers.js';
import { claimBatch, deliver, type EventConsumer, MAX_ATTEMPTS, registerConsumerManifest, sweepStale } from './outbox.js';
import { nextRun, tick } from './scheduler.js';
import { expireTransfers, transferConsumer } from '../transfer/index.js';
import { describeConsumers, registerWorkerSnapshot, type WorkerManifest, type WorkerSnapshot } from './health.js';

export * from './outbox.js';
export * from './consumers.js';
export * from './scheduler.js';
export * from './health.js';

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
  /** 停止后等待所有在途任务的时限；超时不会提前释放仍在执行的任务锁。 */
  shutdownTimeoutMs?: number;
  /** 调度扫描间隔，默认 5 秒；错过周期跳过，不积压补跑。 */
  schedulerIntervalMs?: number;
  logger?: Logger;
}

export interface WorkerHandle {
  kernel: Kernel;
  consumers: EventConsumer[];
  manifest: WorkerManifest;
  snapshot(): WorkerSnapshot;
  /** 处理到 outbox 为空为止（测试和 cage dev 用） */
  drain(maxRounds?: number): Promise<number>;
  stop(): Promise<void>;
}

export function buildConsumers(k: Kernel, opts: Pick<WorkerOptions, 'approvalEngines' | 'consumers'> = {}): EventConsumer[] {
  const engines = { ...routeEngines(k), ...(opts.approvalEngines ?? {}) };
  const consumers = [transferConsumer(k), ...reactionConsumers(k), ...approvalConsumers(k, engines), ...extensionConsumers(k), ...(opts.consumers ?? [])];
  registerConsumerManifest(k, consumers);
  return consumers;
}

export function workerManifest(k: Kernel, opts: Pick<WorkerOptions, 'approvalEngines' | 'consumers'> = {}): WorkerManifest {
  return describeConsumers(k, buildConsumers(k, opts));
}

/** 不启动循环，只创建可手动驱动的 worker（测试用） */
export function createWorker(k: Kernel, opts: WorkerOptions = {}): Omit<WorkerHandle, 'stop'> {
  const consumers = buildConsumers(k, opts);
  const manifest = describeConsumers(k, consumers);
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  return {
    kernel: k,
    consumers,
    manifest,
    snapshot: () => ({ id: 'manual', pid: process.pid, status: 'stopped', listenerHealthy: false, schedulerHealthy: false, heartbeatAt: null, inFlight: [], lastError: null, manifest }),
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
  let w: Omit<WorkerHandle, 'stop'>;
  try { w = createWorker(k, opts); } catch (e) { if (!opts.kernel) await k.close(); throw e; }
  const concurrency = opts.concurrency ?? 8;
  const poll = opts.pollIntervalMs ?? 500;
  let stopped = false;
  let wake: (() => void) | null = null;
  const timers: NodeJS.Timeout[] = [];
  const controller = new AbortController();
  const active = new Map<string, Promise<void>>();
  const deliveries = new Set<number>();
  const state: WorkerSnapshot = {
    id: randomUUID(), pid: process.pid, status: 'starting', listenerHealthy: false, schedulerHealthy: opts.jobs !== false,
    heartbeatAt: null, inFlight: [], lastError: null, manifest: w.manifest,
  };
  const snapshot = (): WorkerSnapshot => ({ ...state, inFlight: [...active.keys(), ...[...deliveries].map((id) => `outbox:${id}`)] });
  registerWorkerSnapshot(k, snapshot);
  const failed = (name: string, e: unknown) => {
    state.lastError = `${name}: ${(e as Error)?.message ?? String(e)}`;
    log.error({ task: name, err: state.lastError }, 'worker 后台任务失败');
  };
  // 所有定时器回调都进入同一跟踪器，停机才能真正等待已启动的任务。
  const launch = (name: string, run: () => Promise<unknown>) => {
    if (stopped) return;
    if (active.has(name)) {
      log.info({ task: name, reason: 'already-running' }, '跳过重叠的后台任务周期');
      return;
    }
    const task = Promise.resolve().then(run).then(() => {}, (e) => failed(name, e)).finally(() => active.delete(name));
    active.set(name, task);
  };
  const heartbeat = async () => {
    const now = new Date();
    await k.app.insertInto('sys.worker_runtime').values({ id: state.id, pid: process.pid, registry_fingerprint: w.manifest.registryFingerprint,
      manifest: JSON.stringify(w.manifest), status: state.status, details: JSON.stringify(snapshot()), heartbeat_at: now })
      .onConflict((oc) => oc.column('id').doUpdateSet({ status: state.status, details: JSON.stringify(snapshot()), heartbeat_at: now })).execute();
    state.heartbeatAt = now.toISOString();
  };
  const appUrl = urls?.app ?? urlsFromEnv().app;
  let listener: pg.Client | null = null;
  let lockConn: pg.Client | null = null;
  try {
    listener = await dedicatedClient(appUrl, 'cage-worker-listen');
    await listener.query('LISTEN cage_outbox');
    state.listenerHealthy = true;
    if (opts.jobs !== false && k.registry.jobs.length > 0) {
      lockConn = await dedicatedClient(appUrl, 'cage-scheduler');
      lockConn.on('error', (e) => { state.schedulerHealthy = false; failed('scheduler-connection', e); });
      lockConn.on('end', () => { state.schedulerHealthy = false; });
    }
    state.status = 'running';
    await heartbeat();
  } catch (e) {
    state.status = 'error';
    await listener?.end().catch(() => {});
    await lockConn?.end().catch(() => {});
    if (!opts.kernel) await k.close();
    throw e;
  }
  listener.on('notification', () => wake?.());
  listener.on('error', (e) => { state.listenerHealthy = false; failed('outbox-listener', e); });
  listener.on('end', () => { state.listenerHealthy = false; });
  const loop = (async () => {
    while (!stopped) {
      try {
        const rows = await claimBatch(k, concurrency);
        if (rows.length > 0) {
          const results = await Promise.allSettled(rows.map(async (row) => {
            deliveries.add(row.id);
            try { await deliver(k, row, w.consumers, opts.maxAttempts ?? MAX_ATTEMPTS, { signal: controller.signal }); }
            finally { deliveries.delete(row.id); }
          }));
          for (const result of results) if (result.status === 'rejected') failed('outbox-delivery', result.reason);
          continue;
        }
      } catch (e) { failed('outbox-claim', e); }
      if (stopped) break;
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

  timers.push(setInterval(() => launch('sweep', () => sweepStale(k)), 60_000));
  const housekeeping = async () => {
    await sql`select sys.ensure_audit_partitions(3)`.execute(k.app);
    await k.app.deleteFrom('sys.idempotency').where('expires_at', '<', new Date()).execute();
    await k.app.deleteFrom('sys.session').where('expires_at', '<', new Date()).execute();
    await expireTransfers(k);
  };
  launch('housekeeping', housekeeping);
  timers.push(setInterval(() => launch('housekeeping', housekeeping), 3600_000));
  timers.push(setInterval(() => launch('heartbeat', async () => {
    // 活跃投递续期，清扫器只恢复真正失去执行者的消息。
    if (deliveries.size) await k.app.updateTable('sys.outbox').set({ locked_at: sql`now()` }).where('id', 'in', [...deliveries]).where('status', '=', 'processing').execute();
    await heartbeat();
  }), 15_000));
  if (lockConn) {
    const due = new Map(k.registry.jobs.map((j) => [j.name, nextRun(j.cron, new Date())]));
    timers.push(
      setInterval(() => {
        if (!state.schedulerHealthy || stopped) return;
        const now = new Date();
        for (const j of k.registry.jobs) {
          const at = due.get(j.name)!;
          if (now < at) continue;
          due.set(j.name, nextRun(j.cron, now));
          launch(`job:${j.name}`, () => tick(k, j, lockConn!, at));
        }
      }, opts.schedulerIntervalMs ?? 5_000),
    );
  }
  log.info({ ...w.manifest, workerId: state.id }, 'worker 已启动');
  let stopping: Promise<void> | null = null;
  return {
    ...w,
    snapshot,
    stop() {
      if (state.status === 'stopped') return Promise.resolve();
      if (stopping) return stopping;
      stopped = true; state.status = 'stopping';
      for (const timer of timers) clearInterval(timer);
      wake?.();
      controller.abort(new Error('worker 正在停止'));
      const cleanup = (async () => {
        await loop;
        await Promise.allSettled([...active.values()]);
        // 仍在执行的 scheduler Promise 完成后才允许关闭 session，释放跨实例锁。
        await listener!.end();
        await lockConn?.end();
        state.status = 'stopped'; state.listenerHealthy = false; state.schedulerHealthy = false;
        try { await heartbeat(); }
        finally { if (!opts.kernel) await k.close(); }
      })();
      stopping = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.lastError = `[CAGE-WORKER-003] 停机等待超时，在途任务：${snapshot().inFlight.join(', ')}`;
          log.error({ err: state.lastError }, 'worker 停机超时；任务结束前保留锁和连接');
          reject(new Error(state.lastError));
        }, opts.shutdownTimeoutMs ?? 30_000);
        cleanup.then(resolve, reject).finally(() => clearTimeout(timeout)).catch(() => {});
      });
      return stopping;
    },
  };
}
