/**
 * 声明派生测试的可复现随机源与失败报告协议。
 * 固定种子用于命令选择和测试输入，失败区分夹具准备与业务执行，报告递归隐藏敏感和秘密字段。
 * 最短失败前缀是本轮观察所得，不是对任意程序进行全局缩减后的最小反例。
 */
import type { AnyAggregate, Fields } from '@yss123/cage-kernel';
import type { TestEnv } from './env.js';

/**
 * 夹具回调参数：env 是真实测试环境，aggregate 是当前聚合，run 为本轮序号。
 * seed/random/uuid 用于复现候选数据，回调应返回已持久化记录，不能只返回一个未落库对象。
 */
export interface DerivedFixtureContext {
  env: TestEnv;
  aggregate: AnyAggregate;
  run: number;
  seed: number;
  random(): number;
  uuid(): string;
}

/**
 * 派生性质测试选项：seed 控制可复现选择，fixtures 按聚合名提供对象字段或构造函数。
 * 夹具主要用于不变量序列，不能据此假设所有其他派生测试都已获得合法业务输入。
 */
export interface DerivedOptions {
  /** uint32 随机种子；报告会保留实际使用的值，默认固定为 20261103。 */
  seed?: number;
  /** 对象作为 env.insert 的字段；函数通过命令/测试工具构造记录并返回已持久化的快照。 */
  fixtures?: Record<string, Record<string, unknown> | ((context: DerivedFixtureContext) => Record<string, any> | Promise<Record<string, any>>)>;
}

/**
 * 一次命令尝试的证据：step 为序列位置，capability 为目标，input 应已脱敏。
 * result 记录成功或标准/业务错误码，不把原始异常或响应正文存入轨迹。
 */
export interface DerivedCommandTrace {
  step: number;
  capability: string;
  input: unknown;
  result: { ok: boolean; code?: string; domainCode?: string };
}

/**
 * 单轮不变量测试轨迹：initial 为初始快照，preparation 为准备命令，commands 为执行序列。
 * phase 区分非法夹具与执行缺陷；failedInvariants 保存失败规则名，minimalPrefix 保存观察到失败为止的命令。
 */
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

/**
 * 不变量测试汇总，steps 是实际命令尝试数，violations 是发现的问题，seed/traces 供重现排查。
 * 没有 violation 不意味着穷尽全部命令排列，需结合实际执行步数与业务定向用例。
 */
export interface DerivedInvariantResult {
  steps: number;
  violations: string[];
  seed: number;
  traces: DerivedRunTrace[];
}

/**
 * 携带结构化失败轨迹的测试异常，统一标识为 CAGE-TEST-002。
 * 构造前由调用方脱敏 detail，消息序列化同一轨迹，phase/aggregate/seed 提供快速定位字段。
 */
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
/**
 * 返回独立闭包随机序列，同一 uint32 种子按固定算法产生相同 [0,1) 值。
 * 仅用于测试可复现性，不具备密码学安全性，不能生成生产凭据。
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从给定随机源构造符合版本/变体位形状的 UUID，消耗固定数量的随机值。
 * 固定种子下可重复，不保证跨独立重放唯一；用于隔离测试数据而非生产标识分配。
 */
export function seededUuid(random: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 诊断不使用操作者的明文能力；敏感/隐藏字段在任意对象深度及数组内一律遮盖。 */
/**
 * 从聚合声明递归收集敏感/隐藏字段名，并结合固定秘密字段名生成报告脱敏函数。
 * 与操作者的 unmask 权限无关，数组与嵌套对象统一遮盖，避免失败证据泄露明文。
 */
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
