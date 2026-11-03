// 有界集合只负责展开和排序；写入、授权、审计和回滚继续使用同一命令流水线。
import type { z } from 'zod';
import { CageError, cageError, declError, toCageError } from '../errors.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent, PayloadOf } from './event.js';
import { reaction, type AnyReaction, type Reaction, type TxMode } from './flow.js';

export interface ReactionEntry<Input = unknown> {
  readonly input: Input;
  /** 实际执行命令输入的 0 基索引；返回 null 的项不占位。 */
  readonly itemIndex: number;
  readonly sortedIndex?: number;
  readonly originalIndex?: number;
  readonly itemKey?: string | number;
}

// 保留公开 map 的输入数组协议，同时给运行时留下 null 跳过之前的定位信息。
const collections = new WeakMap<object, (payload: any) => ReactionEntry[]>();

export function reactionEach<E extends AnyEvent, C extends AnyCommand, Item>(
  event: E,
  def: {
    command: C;
    items: (event: PayloadOf<E>) => readonly Item[];
    maxItems: number;
    orderBy: keyof Item & string;
    map: (item: Item, event: PayloadOf<E>, index: number) => z.input<C['input']> | null;
    order?: number;
    tx?: TxMode;
    acquires?: string;
    releases?: string;
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
