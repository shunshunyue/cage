// API 和 worker 可展示同一份声明指纹；运行心跳保存在系统表，跨进程诊断无需猜测加载版本。
import type { Kernel } from '../kernel.js';
import { readFileSync } from 'node:fs';
import { registryFingerprint } from '../registry.js';
import type { EventConsumer } from './outbox.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

/** 进程实际装载的版本/协议/注册指纹及消费者清单，不能用磁盘源码代替这份运行证据。 */
export interface WorkerManifest {
  version: string;
  protocolVersion: number;
  registryFingerprint: string;
  loadedAt: string;
  consumers: { name: string; event: string; ready: boolean }[];
  events: { name: string; consumers: string[]; recordOnly: boolean }[];
  jobs: string[];
}

/** 可观测运行状态；heartbeatAt 为 ISO 时间，null 表示尚无成功心跳，inFlight 是正在执行的任务标识。 */
export interface WorkerSnapshot {
  id: string;
  pid: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  listenerHealthy: boolean;
  schedulerHealthy: boolean;
  heartbeatAt: string | null;
  inFlight: string[];
  lastError: string | null;
  manifest: WorkerManifest;
}

/** 清单按名称稳定排序；recordOnly 事件允许没有消费者，未知事件则由投递校验拒绝静默完成。 */
export function describeConsumers(k: Kernel, consumers: EventConsumer[]): WorkerManifest {
  const entries = consumers.map((c) => ({ name: c.name, event: c.event, ready: true })).sort((a, b) => a.name.localeCompare(b.name));
  const events = [...new Set([...k.registry.events.map((event) => event.name), ...entries.map((c) => c.event)])].sort();
  return {
    version, protocolVersion: 2, registryFingerprint: registryFingerprint(k.registry), loadedAt: new Date().toISOString(),
    consumers: entries,
    events: events.map((name) => { const names = entries.filter((c) => c.event === name).map((c) => c.name); return { name, consumers: names, recordOnly: names.length === 0 }; }),
    jobs: k.registry.jobs.map((j) => j.name).sort(),
  };
}

const snapshots = new WeakMap<Kernel, () => WorkerSnapshot>();
/** 保存实时快照提供器而非冻结结果，HTTP 同进程诊断可观察到最新状态；WeakMap 不延长 kernel 生命周期。 */
export function registerWorkerSnapshot(k: Kernel, snapshot: () => WorkerSnapshot): void { snapshots.set(k, snapshot); }
/** 未在此进程装配 worker 时返回 null；跨进程状态应查询数据库心跳记录。 */
export function workerSnapshot(k: Kernel): WorkerSnapshot | null { return snapshots.get(k)?.() ?? null; }
