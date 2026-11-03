// 真实 PostgreSQL 故障回归：小池不能互等，回执恢复不能重复外呼/核销，锁在在途任务结束前不能释放。
import { randomUUID } from 'node:crypto';
import { aggregate, approval, command, createKernel, emit, event, id, int, job, scope, text } from '@yss123/cage-kernel';
import { dedicatedClient } from '@yss123/cage-kernel/db';
import { createWorker, deliver, startWorker, tick, type OutboxRow } from '@yss123/cage-kernel/worker';
import { connector, fakeConnector, op, outbound } from '@yss123/cage-connectors';
import * as org from '@yss123/cage-admin/domain';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestEnv, type TestEnv } from '../src/index.js';

const Probe = aggregate('WorkerProbe', { fields: { name: text(80), applied: int(), remoteValue: text(80).optional() }, scope: scope.none() });
const Queued = event('WorkerProbeQueued', { probeId: id(), name: text(80) });
const create = command(Probe, { name: 'create', from: 'new', to: 'active', input: z.object({ name: z.string() }),
  emits: [emit(Queued, (row) => ({ probeId: row.id, name: row.name }))], handler: (_draft, input) => ({ name: input.name, applied: 0 }) });
let rejectWriteback = false;
const applyReceipt = command(Probe, { name: 'applyReceipt', from: 'active', to: 'active', invokedBy: 'external',
  input: z.object({ id: z.uuid(), value: z.string() }), handler: (draft, input) => {
    if (rejectWriteback) throw new Error('injected-local-writeback-failure');
    return { applied: draft.applied + 1, remoteValue: input.value };
  } });
const remote = connector('worker-probe', { hosts: {}, timeoutMs: 500, operations: {
  push: op({ effect: 'retryableWrite', method: 'POST', path: '/probe', request: z.object({ name: z.string() }), response: z.object({ value: z.string() }) }),
} });
const send = outbound(Queued, remote.operations.push, { idempotencyKey: (entry) => entry.probeId, map: (entry) => ({ name: entry.name }),
  onSuccess: { command: applyReceipt, map: (res, entry) => ({ id: entry.probeId, value: res.value }) } });
let runJob: () => Promise<void> = async () => {};
const scheduled = job('workerProbeJob', { cron: '* * * * * *', run: () => runJob() });
const domain = { ...org, Probe, Queued, create, applyReceipt, remote, send, scheduled };
let env: TestEnv;
beforeAll(async () => { env = await createTestEnv({ domain }); });
afterEach(() => { rejectWriteback = false; runJob = async () => {}; fakeConnector(remote, { push: (req) => ({ value: req.name }) }); });
afterAll(async () => { await env?.close(); });

const newProbe = (name = randomUUID()) => env.kernel.execute('WorkerProbe.create', { name }, env.system());
async function rowFor(id: string): Promise<OutboxRow> {
  const [row] = await env.query('update sys.outbox set status=$1,locked_at=now() where aggregate_id=$2 and event=$3 returning *', ['processing', id, Queued.name]);
  return { ...row, id: Number(row.id) };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

it('poolSize=1 的 fake 外呼可读取同池，随后短事务回写；不存在连接池相互等待', async () => {
  const k = createKernel({ domain, urls: env.urls, poolSize: 1 });
  try {
    fakeConnector(remote, { push: async (req) => { await k.app.selectFrom('sys.tenant').select('id').execute(); return { value: req.name }; } });
    const probe = await newProbe();
    expect(await createWorker(k).drain()).toBeGreaterThan(0);
    expect((await env.query('select applied,remote_value from core.worker_probe where id=$1', [probe.id]))[0]).toEqual({ applied: 1, remote_value: probe.name });
    expect((await env.query('select status,attempts from sys.connector_execution where idempotency_key=$1', [probe.id]))[0]).toEqual({ status: 'succeeded', attempts: 1 });
  } finally { await k.close(); }
});

it('远端成功而本地回写失败后，重试读取持久回执；不重复外呼、核销或成功审计', async () => {
  let calls = 0;
  fakeConnector(remote, { push: (req) => { calls++; return { value: req.name }; } });
  const probe = await newProbe(), worker = createWorker(env.kernel);
  rejectWriteback = true;
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers)).toBe('retry');
  expect((await env.query('select applied from core.worker_probe where id=$1', [probe.id]))[0].applied).toBe(0);
  expect((await env.query('select status from sys.connector_execution where idempotency_key=$1', [probe.id]))[0].status).toBe('succeeded');
  rejectWriteback = false;
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers)).toBe('done');
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers)).toBe('done');
  expect(calls).toBe(1);
  expect((await env.query('select applied from core.worker_probe where id=$1', [probe.id]))[0].applied).toBe(1);
  expect(await env.audit({ aggregateId: probe.id, command: 'WorkerProbe.applyReceipt' })).toHaveLength(1);
});

it('同一幂等键不同内容拒绝覆盖成功回执', async () => {
  const probe = await newProbe(), worker = createWorker(env.kernel);
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers)).toBe('done');
  const row = await rowFor(probe.id);
  await env.query('delete from sys.processed_event where event_id=$1', [row.id]);
  expect(await deliver(env.kernel, { ...row, payload: { ...row.payload, name: 'changed-content' } }, worker.consumers)).toBe('dead');
  expect((await env.query('select last_error from sys.outbox where id=$1', [row.id]))[0].last_error).toContain('CAGE-CONN-013');
});

it('缺必要审批引擎启动失败；缺失一个关键消费者和未知事件不能静默完成，纯记录事件可以', async () => {
  const processCommand = command(Probe, { name: 'processConfirm', from: 'active', to: 'active', invokedBy: 'process', handler: (draft) => draft });
  const binding = approval(Probe, { process: 'missing-engine', start: Queued, routable: ['name'], onApproved: processCommand, onRejected: processCommand });
  const missing = createKernel({ domain: { ...domain, processCommand, binding }, db: { app: env.kernel.app, read: env.kernel.readDb } });
  expect(() => createWorker(missing)).toThrow('CAGE-WORKER-001');
  const probe = await newProbe(), worker = createWorker(env.kernel);
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers.filter((c) => c.event !== Queued.name))).toBe('dead');
  const unknown = await newProbe(), row = await rowFor(unknown.id);
  expect(await deliver(env.kernel, { ...row, event: 'FutureCriticalEvent' }, worker.consumers)).toBe('dead');
  const Recorded = event('ProbeRecorded', { probeId: id() });
  const records = createKernel({ domain: { ...domain, Recorded }, db: { app: env.kernel.app, read: env.kernel.readDb } });
  const recordWorker = createWorker(records);
  expect(await deliver(records, { ...row, event: Recorded.name }, recordWorker.consumers)).toBe('done');
});

it('同实例跨周期不会重入同一会话锁；另一实例也无法同时执行', async () => {
  const entered = deferred(), finish = deferred();
  let current = 0, maximum = 0;
  runJob = async () => { maximum = Math.max(maximum, ++current); entered.resolve(); await finish.promise; current--; };
  const a = await dedicatedClient(env.urls.app), b = await dedicatedClient(env.urls.app);
  const other = createKernel({ domain, urls: env.urls });
  try {
    const first = tick(env.kernel, scheduled, a, new Date(), true);
    await entered.promise;
    expect(await tick(env.kernel, scheduled, a, new Date(Date.now() + 1000), true)).toBe(false);
    expect(await tick(other, scheduled, b, new Date(Date.now() + 1000), true)).toBe(false);
    finish.resolve();
    expect(await first).toBe(true);
    expect(maximum).toBe(1);
  } finally { finish.resolve(); await a.end(); await b.end(); await other.close(); }
});

it('停机等待运行中的任务，任务完成之前不释放跨实例锁；持久心跳记录版本与最终状态', async () => {
  const entered = deferred(), finish = deferred();
  runJob = async () => { entered.resolve(); await finish.promise; };
  const worker = await startWorker({ kernel: env.kernel, urls: env.urls, schedulerIntervalMs: 20, pollIntervalMs: 20, shutdownTimeoutMs: 5000 });
  const b = await dedicatedClient(env.urls.app), other = createKernel({ domain, urls: env.urls });
  try {
    await entered.promise;
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    expect(worker.snapshot().inFlight).toContain('job:workerProbeJob');
    expect(await tick(other, scheduled, b, new Date(), true)).toBe(false);
    finish.resolve(); await stop;
    const [health] = await env.query('select status,manifest from sys.worker_runtime where id=$1', [worker.snapshot().id]);
    expect(health.status).toBe('stopped');
    expect(health.manifest.registryFingerprint).toBe(worker.manifest.registryFingerprint);
    expect(health.manifest.consumers).toContainEqual(expect.objectContaining({ event: Queued.name, ready: true }));
  } finally { finish.resolve(); await worker.stop(); await b.end(); await other.close(); }
});

it('fake 外部 IO 也有有界超时，失败意图和 outbox 错误可诊断', async () => {
  fakeConnector(remote, { push: async (_req, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const probe = await newProbe(), worker = createWorker(env.kernel);
  expect(await deliver(env.kernel, await rowFor(probe.id), worker.consumers)).toBe('retry');
  const [execution] = await env.query('select status,error from sys.connector_execution where idempotency_key=$1', [probe.id]);
  expect(execution.status).toBe('failed');
  expect(execution.error).toContain('CAGE-CONN-008');
});

it('不可重试写结果未知或调用租约中断时停止重发，保留人工核对证据', async () => {
  const writeRemote = connector('probe-no-retry', { hosts: {}, timeoutMs: 50, operations: {
    push: op({ effect: 'write', method: 'POST', path: '/probe', request: z.object({ name: z.string() }), response: z.object({ value: z.string() }) }),
  } });
  let calls = 0;
  fakeConnector(writeRemote, { push: () => { calls++; throw new Error('connection-lost-after-remote-commit'); } });
  const writeSend = outbound(Queued, writeRemote.operations.push, { idempotencyKey: (entry) => entry.probeId, map: (entry) => ({ name: entry.name }) });
  const k = createKernel({ domain: { ...domain, remote: writeRemote, send: writeSend }, urls: env.urls, poolSize: 1 });
  try {
    const probe = await newProbe(), worker = createWorker(k);
    expect(await deliver(k, await rowFor(probe.id), worker.consumers)).toBe('dead');
    expect((await env.query('select status from sys.connector_execution where idempotency_key=$1', [probe.id]))[0].status).toBe('unknown');
    await env.query("update sys.connector_execution set status='calling', lease_until=now()-interval '1 second' where idempotency_key=$1", [probe.id]);
    expect(await deliver(k, await rowFor(probe.id), worker.consumers)).toBe('dead');
    expect(calls).toBe(1);
    expect((await env.query('select status,error from sys.connector_execution where idempotency_key=$1', [probe.id]))[0]).toMatchObject({ status: 'unknown', error: expect.stringContaining('人工核对') });
  } finally { await k.close(); }
});

it('停机超时明确失败，在途任务结束后才清理持有的锁与连接', async () => {
  const entered = deferred(), finish = deferred();
  runJob = async () => { entered.resolve(); await finish.promise; };
  const worker = await startWorker({ kernel: env.kernel, urls: env.urls, schedulerIntervalMs: 10, pollIntervalMs: 20, shutdownTimeoutMs: 30 });
  const connection = await dedicatedClient(env.urls.app), other = createKernel({ domain, urls: env.urls });
  try {
    await entered.promise;
    await expect(worker.stop()).rejects.toThrow('CAGE-WORKER-003');
    expect(await tick(other, scheduled, connection, new Date(), true)).toBe(false);
    finish.resolve();
    await expect.poll(() => worker.snapshot().status).toBe('stopped');
    await worker.stop();
  } finally { finish.resolve(); await connection.end(); await other.close(); }
});
