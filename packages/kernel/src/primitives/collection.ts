/**
 * 把事件中的有界集合展开成按稳定键串行执行的命令输入，并保留失败定位信息。
 * 由 same/outbox 反应消费者复用，集合本身不写数据库；排序用于稳定锁顺序和重试定位，事务、权限及审计仍由每项目标命令保证。
 */
// 有界集合只负责展开和排序；写入、授权、审计和回滚继续使用同一命令流水线。
import type { z } from 'zod';
import { CageError, cageError, declError, toCageError } from '../errors.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent, PayloadOf } from './event.js';
import { reaction, type AnyReaction, type Reaction, type TxMode } from './flow.js';

/** 一次实际命令调用及其来源坐标；过滤项后仍保留排序前的位置，便于定位集合失败。 */
export interface ReactionEntry<Input = unknown> {
  /**
   * 该项实际传给目标命令的输入，已由纯映射产生，仍需命令 input schema 校验。
   */
  readonly input: Input;
  /** 实际执行命令输入的 0 基索引；返回 null 的项不占位。 */
  readonly itemIndex: number;
  /**
   * 集合按 orderBy 升序后的位置，零基；被 map 跳过的项仍占该排序位置，普通反应省略。
   */
  readonly sortedIndex?: number;
  /**
   * 选择器原数组中的零基位置，用于对照事件载荷；普通反应省略。
   */
  readonly originalIndex?: number;
  /**
   * 该集合项已验证的唯一排序键，非空字符串或有限数值；用于稳定诊断，不携带整项载荷。
   */
  readonly itemKey?: string | number;
}

// 保留公开 map 的输入数组协议，同时给运行时留下 null 跳过之前的定位信息。
const collections = new WeakMap<object, (payload: any) => ReactionEntry[]>();

/**
 * 把有界集合声明转换为普通反应协议，执行时先检查数量和唯一排序键，再稳定串行展开。
 * map 收到排序后的索引，返回 null 的项被跳过；键必须同类型且唯一，避免重试时顺序漂移。
 * collection 保存选择器/映射源码供静态诊断，真正写入仍逐项调用目标命令并遵守 tx 模式。
 */
export function reactionEach<E extends AnyEvent, C extends AnyCommand, Item>(
  event: E,
  def: {
    /** 每个未跳过集合项最终调用的命令，写入、权限、状态和审计均复用其流水线。 */
    command: C;
    /** 从事件载荷同步选择只读集合的纯函数，必须返回数组；不得外呼或修改业务状态。 */
    items: (event: PayloadOf<E>) => readonly Item[];
    /** 单次事件允许的集合总项数上限，正安全整数；在跳过 null 前检查，超限直接拒绝而非截断。 */
    maxItems: number;
    /** 每项中用于升序排序的字段名；值须同类型、唯一，且为非空字符串或有限数值。 */
    orderBy: keyof Item & string;
    /** 按排序后的项、完整事件和零基 sortedIndex 生成命令输入；返回 null 跳过，该项不占实际 itemIndex。 */
    map: (item: Item, event: PayloadOf<E>, index: number) => z.input<C['input']> | null;
    /** 可选同一事件/事务模式的步骤序号，非负安全整数；使用后整个分组须完整且唯一声明。 */
    order?: number;
    /** 默认 outbox 异步消费者事务；same 与触发命令共同提交，任一集合项失败均按该事务边界回滚。 */
    tx?: TxMode;
    /** 可选取得资源标签，仅用于静态资源配对，真实占用必须由目标命令完成。 */
    acquires?: string;
    /** 可选释放资源标签，仅用于静态资源配对，不自动释放锁或库存。 */
    releases?: string;
    /** 可选反应标识，用于图谱和集合错误定位；省略时诊断可使用事件名作为路径说明。 */
    name?: string;
  },
): Reaction<E, C> {
  if (!Number.isSafeInteger(def.maxItems) || def.maxItems < 1 || !def.orderBy) {
    throw declError('CAGE-REACT-003', '集合反应必须声明正整数 maxItems 和非空 orderBy 字段');
  }
  const base = reaction(event, { ...def, map: () => null });
  const expand = (payload: PayloadOf<E>): ReactionEntry<z.input<C['input']>>[] => {
    const items = def.items(payload);
    const invalid = (reason: string, index?: number): never => {
      throw cageError('INVALID_INPUT', [{ path: `reaction.${def.name ?? event.name}`, message: reason, index, maxItems: def.maxItems }]);
    };
    if (!Array.isArray(items)) return invalid('集合选择器必须返回数组');
    if (items.length > def.maxItems) return invalid(`集合数量超过上限 ${def.maxItems}`);
    const keyed = items.map((item, index) => {
      const key = item?.[def.orderBy];
      if (!(typeof key === 'string' && key.length > 0) && !(typeof key === 'number' && Number.isFinite(key))) {
        return invalid(`排序字段 ${def.orderBy} 必须为非空字符串或有限数值`, index);
      }
      return { item, key: key as string | number, index };
    });
    if (keyed.some((entry) => typeof entry.key !== typeof keyed[0].key)) return invalid('集合排序字段类型必须一致');
    const keys = new Set(keyed.map((entry) => entry.key));
    if (keys.size !== keyed.length) return invalid(`集合排序字段 ${def.orderBy} 不允许重复`);
    keyed.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const entries: ReactionEntry<z.input<C['input']>>[] = [];
    for (const [sortedIndex, { item, key, index }] of keyed.entries()) {
      const input = def.map(item, payload, sortedIndex);
      if (input !== null) entries.push({ input, itemIndex: entries.length, sortedIndex, originalIndex: index, itemKey: key });
    }
    return entries;
  };
  const result = Object.freeze({
    ...base,
    collection: Object.freeze({ maxItems: def.maxItems, orderBy: def.orderBy, itemsSource: def.items.toString(), mapSource: def.map.toString() }),
    map: (payload: PayloadOf<E>) => expand(payload).map(({ input }) => input),
  });
  collections.set(result, expand);
  return result;
}

/** 消费者按返回顺序串行调用；禁止把同事务集合改为 Promise.all。 */
export function reactionInputs(reaction: AnyReaction, payload: unknown): unknown[] {
  return reactionEntries(reaction, payload).map(({ input }) => input);
}

/**
 * 集合声明走保存于 WeakMap 的展开器；普通 map 的单个输入或数组被归一化为调用序列。
 * null/undefined 表示本事件无需处理；这里只计算输入，不授权、不执行命令或吞并异常。
 */
export function reactionEntries(reaction: AnyReaction, payload: unknown): ReactionEntry[] {
  const expand = collections.get(reaction);
  if (expand) return expand(payload);
  const input = reaction.map(payload as any);
  const inputs = input === null || input === undefined ? [] : Array.isArray(input) ? [...input] : [input];
  return inputs.map((input, itemIndex) => ({ input, itemIndex }));
}

/** 同事务与 outbox 使用相同定位信息；保留原错误码和业务码，不记录整项业务载荷。 */
export function reactionEntryError(error: unknown, reaction: AnyReaction, name: string, entry: ReactionEntry): unknown {
  if (!reaction.collection) return error;
  const cause = toCageError(error);
  return new CageError(cause.code, {
    cause: cause.detail, reaction: name, itemIndex: entry.itemIndex, sortedIndex: entry.sortedIndex,
    originalIndex: entry.originalIndex, itemKey: entry.itemKey, order: reaction.order, orderBy: reaction.collection.orderBy,
  }, cause.domainCode);
}
