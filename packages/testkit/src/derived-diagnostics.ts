import type { AnyAggregate, Fields } from '@yss123/cage-kernel';
import type { TestEnv } from './env.js';

export interface DerivedFixtureContext {
  env: TestEnv;
  aggregate: AnyAggregate;
  run: number;
  seed: number;
  random(): number;
  uuid(): string;
}

export interface DerivedOptions {
  /** uint32 随机种子；报告会保留实际使用的值，默认固定为 20261103。 */
  seed?: number;
  /** 对象作为 env.insert 的字段；函数通过命令/测试工具构造记录并返回已持久化的快照。 */
  fixtures?: Record<string, Record<string, unknown> | ((context: DerivedFixtureContext) => Record<string, any> | Promise<Record<string, any>>)>;
}

export interface DerivedCommandTrace {
  step: number;
  capability: string;
  input: unknown;
  result: { ok: boolean; code?: string; domainCode?: string };
}

export interface DerivedRunTrace {
  aggregate: string;
  seed: number;
  run: number;
  phase: 'fixture' | 'execution';
  initial: unknown;
  preparation: DerivedCommandTrace[];
  commands: DerivedCommandTrace[];
  failedInvariants: string[];
  /** 在本轮观察到第一个失败时立即停止，保存截至该步的最短已观察失败前缀。 */
  minimalPrefix: DerivedCommandTrace[];
}

export interface DerivedInvariantResult {
  steps: number;
  violations: string[];
  seed: number;
  traces: DerivedRunTrace[];
}

export class DerivedTestError extends Error {
  readonly code = 'CAGE-TEST-002';
  readonly phase: 'fixture' | 'execution';
  readonly aggregate: string;
  readonly seed: number;
  constructor(readonly detail: DerivedRunTrace) {
    super(`[CAGE-TEST-002] 派生测试${detail.phase === 'fixture' ? '初始夹具非法' : '执行失败'}：${JSON.stringify(detail)}`);
    this.name = 'DerivedTestError';
    this.phase = detail.phase; this.aggregate = detail.aggregate; this.seed = detail.seed;
  }
}

/** 固定算法，避免 Math.random 的隐式全局状态使命令序列无法重放。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededUuid(random: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 诊断不使用操作者的明文能力；敏感/隐藏字段在任意对象深度及数组内一律遮盖。 */
export function derivedRedactor(aggregates: readonly AnyAggregate[]): (value: unknown) => unknown {
  const sensitive = new Set<string>(['password', 'passwordhash', 'token', 'secret', 'authorization', 'cookie']);
  const visitFields = (fields: Fields) => {
    for (const [name, field] of Object.entries(fields)) {
      if (field.sensitiveKind || field.isHidden) sensitive.add(name.toLowerCase());
      if (field.shape) visitFields(field.shape as Fields);
    }
  };
  for (const aggregate of aggregates) visitFields(aggregate.fields);
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, sensitive.has(name.toLowerCase()) ? '[REDACTED]' : redact(entry)]));
  };
  return redact;
}
