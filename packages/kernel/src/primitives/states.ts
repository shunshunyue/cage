/**
 * 定义聚合有限生命周期及展示标签，供命令状态约束、草稿初始值和图规则共同使用。
 * states 只返回冻结描述，不创建迁移或命令；terminal 是声明元数据，实际是否允许离开仍取决于命令 from/to。
 */
// states 原语：有限状态集，可标记终态。第一个状态是新建命令的默认初始状态。
import { STATES } from '../brands.js';
import { declError } from '../errors.js';

/** 状态标识用于持久化与命令约束，labels 只用于显示，不改变实际状态字符串。 */
export interface StatesDef<S extends string = string> {
  /**
   * 状态集品牌标记，用于识别 fields.status 与普通业务字段。
   */
  readonly [STATES]: true;
  /**
   * 按声明顺序保存的完整状态标识集合，不能为空或重复，标识使用小写下划线。
   */
  readonly values: readonly S[];
  /**
   * 显式声明的终态集合，默认空；供检查和展示，不自动禁止终态命令。
   */
  readonly terminal: readonly S[];
  /**
   * 新建草稿的初始状态，显式 initial 优先，否则取 values 第一项；最终提交状态由新建命令 to 决定。
   */
  readonly initial: S;
  /**
   * 状态到显示名的部分映射，缺省为空，未配置标签仍使用状态标识。
   */
  readonly labels: Readonly<Partial<Record<S, string>>>;
}

/**
 * 状态声明的可选配置，所有引用必须属于前面的状态字符串集合。
 * terminal 缺省为空，initial 缺省第一项，labels 只覆盖显示名且不能空白，不改变数据库持久标识。
 */
type StatesOpts<S extends string> = { /** 声明终态，默认空列表；每项必须已在状态参数中出现，实际退出能力仍由命令定义。 */ terminal?: NoInfer<S>[]; /** 新建草稿的初始状态，省略时取第一个状态；必须属于已声明集合。 */ initial?: NoInfer<S>; /** 可选状态显示名映射，键必须已声明、值不能为空白；持久化仍使用原状态标识。 */ labels?: Partial<Record<NoInfer<S>, string>> };

/**
 * states('draft', 'pending_approval', 'approved', { terminal: ['approved'] })
 */
/**
 * 最后一个对象参数为选项，字符串参数构成完整状态集；显式 initial 优先，否则取首项。
 * 终态、初始态和中文标签都必须引用已声明状态，错误在加载 domain 时即可暴露。
 * terminal 是图检查及界面元数据，是否允许后续动作仍由具体命令的 from/to 决定。
 */
export function states<const S extends string>(...args: [...S[]] | [...S[], StatesOpts<S>]): StatesDef<S> {
  const all = args as unknown[];
  const last = all[all.length - 1];
  const opts = (typeof last === 'object' && last !== null ? last : {}) as StatesOpts<S>;
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
  for (const [state, label] of Object.entries(opts.labels ?? {})) {
    if (!values.includes(state as S) || typeof label !== 'string' || !label.trim()) throw declError('CAGE-STATE-005', `状态名称 ${state} 必须对应已声明的状态且不能为空`);
  }
  return Object.freeze({
    [STATES]: true as const,
    values: Object.freeze([...values]),
    terminal: Object.freeze([...terminal]),
    initial: (opts.initial ?? values[0]) as S,
    labels: Object.freeze({ ...opts.labels }),
  });
}

/** 聚合解析 fields.status 时使用，只检查标记，不重新运行状态校验。 */
export function isStates(v: unknown): v is StatesDef {
  return !!v && typeof v === 'object' && (v as any)[STATES] === true;
}

/** 没有声明状态的聚合使用默认生命周期：active → deleted（业务数据不物理删除） */
export const DEFAULT_STATES = states('active', 'deleted', { terminal: ['deleted'] });
