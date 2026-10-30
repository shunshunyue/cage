// states 原语：有限状态集，可标记终态。第一个状态是新建命令的默认初始状态。
import { STATES } from '../brands.js';
import { declError } from '../errors.js';

export interface StatesDef<S extends string = string> {
  readonly [STATES]: true;
  readonly values: readonly S[];
  readonly terminal: readonly S[];
  readonly initial: S;
}

type StatesOpts<S extends string> = { terminal?: NoInfer<S>[]; initial?: NoInfer<S> };

/**
 * states('draft', 'pending_approval', 'approved', { terminal: ['approved'] })
 */
export function states<const S extends string>(...args: [...S[]] | [...S[], StatesOpts<S>]): StatesDef<S> {
  const all = args as unknown[];
  const last = all[all.length - 1];
  const opts = (typeof last === 'object' && last !== null ? last : {}) as { terminal?: S[]; initial?: S };
  const values = all.filter((a): a is S => typeof a === 'string');
  if (values.length === 0) throw declError('CAGE-STATE-002', 'states() 至少需要一个状态');
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) throw declError('CAGE-STATE-003', `状态名 ${v} 必须是小写下划线`);
  }
  if (new Set(values).size !== values.length) throw declError('CAGE-STATE-004', '状态名重复');
  const terminal = opts.terminal ?? [];
  for (const t of [...terminal, ...(opts.initial ? [opts.initial] : [])]) {
    if (!values.includes(t)) throw declError('CAGE-STATE-001', `状态 ${t} 未在 states 中声明`);
  }
  return Object.freeze({
    [STATES]: true as const,
    values: Object.freeze([...values]),
    terminal: Object.freeze([...terminal]),
    initial: (opts.initial ?? values[0]) as S,
  });
}

export function isStates(v: unknown): v is StatesDef {
  return !!v && typeof v === 'object' && (v as any)[STATES] === true;
}

/** 没有声明状态的聚合使用默认生命周期：active → deleted（业务数据不物理删除） */
export const DEFAULT_STATES = states('active', 'deleted', { terminal: ['deleted'] });
