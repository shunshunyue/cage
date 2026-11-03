// API 和 worker 可展示同一份声明指纹；运行心跳保存在系统表，跨进程诊断无需猜测加载版本。
import type { Kernel } from '../kernel.js';
import { readFileSync } from 'node:fs';
import { registryFingerprint } from '../registry.js';
import type { EventConsumer } from './outbox.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export interface WorkerManifest {
  version: string;
  protocolVersion: number;
  registryFingerprint: string;
  loadedAt: string;
  consumers: { name: string; event: string; ready: boolean }[];
  events: { name: string; consumers: string[]; recordOnly: boolean }[];
  jobs: string[];
}

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
export function registerWorkerSnapshot(k: Kernel, snapshot: () => WorkerSnapshot): void { snapshots.set(k, snapshot); }
export function workerSnapshot(k: Kernel): WorkerSnapshot | null { return snapshots.get(k)?.() ?? null; }
