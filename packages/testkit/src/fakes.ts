// handler 单测工具：handler 不碰数据库，把读依赖换成内存假对象，直接调用函数。毫秒级。
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { AnyAggregate, AnyCommand, AnyField, Draft, Fields, ReadRepo } from '@yss123/cage-kernel';

/** 字段的示例值：满足字段校验，便于构造草稿和种子数据 */
export function sampleValue(f: AnyField, name = '', force = false): unknown {
  if (f.isOptional && !force) return null;
  switch (f.kind) {
    case 'text':
      if (f.sensitiveKind === 'phone') return '13800001234';
      if (f.sensitiveKind === 'email') return 'someone@example.com';
      if (f.sensitiveKind === 'idCard') return '110101199001011234';
      if (f.sensitiveKind === 'bankCard') return '6222020200001234567';
      if (f.sensitiveKind === 'name') return '张三';
      return `${name || 'text'}-${randomUUID().slice(0, 8)}`.slice(0, f.max ?? 500);
    case 'int':
      return 1;
    case 'number':
      return 1;
    case 'money':
      return '100.00';
    case 'id':
    case 'ref':
    case 'file':
      return randomUUID();
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return new Date('2026-01-01T00:00:00Z').toISOString();
    case 'bool':
      return false;
    case 'enum':
      return f.values?.[0];
    case 'list':
      if (!f.shape) return {};
      if ('item' in f.shape && Object.keys(f.shape).length === 1) return [sampleValue(f.shape.item, 'item')];
      return [Object.fromEntries(Object.entries(f.shape).map(([k, sf]) => [k, sampleValue(sf, k)]))];
    case 'manyToMany':
    case 'files':
      return [];
    default:
      return null;
  }
}

/** 字段的 fast-check 生成器：用于不变量的性质测试 */
export function arbitraryOf(f: AnyField): fc.Arbitrary<unknown> {
  let a: fc.Arbitrary<unknown>;
  switch (f.kind) {
    case 'text':
      a = fc.string({ maxLength: Math.min(f.max ?? 500, 40) });
      break;
    case 'int':
      a = fc.integer({ min: -1000, max: 100000 });
      break;
    case 'number':
      a = fc.double({ min: -1e6, max: 1e6, noNaN: true });
      break;
    case 'money':
      a = fc.integer({ min: -100000, max: 10_000_000 }).map((n) => (n / 100).toFixed(2));
      break;
    case 'id':
    case 'ref':
    case 'file':
      a = fc.uuid();
      break;
    case 'manyToMany':
      a = fc.uniqueArray(fc.uuid(), { maxLength: 5 }).map((ids) => ids.sort());
      break;
    case 'files':
      a = fc.constant([]);
      break;
    case 'bool':
      a = fc.boolean();
      break;
    case 'enum':
      a = fc.constantFrom(...(f.values ?? ['']));
      break;
    case 'list': {
      const shape = f.shape ?? {};
      if ('item' in shape && Object.keys(shape).length === 1) a = fc.array(arbitraryOf(shape.item), { maxLength: 5 });
      else a = fc.array(fc.record(Object.fromEntries(Object.entries(shape).map(([k, sf]) => [k, arbitraryOf(sf)]))), { maxLength: 5 });
      break;
    }
    default:
      a = fc.constant(sampleValue(f));
  }
  return f.isOptional ? fc.option(a, { nil: null }) : a;
}

export function arbitrarySnapshot(agg: AnyAggregate): fc.Arbitrary<Record<string, unknown>> {
  return fc.record(Object.fromEntries(Object.entries(agg.fields as Fields).filter(([, f]) => f.kind !== 'hasMany').map(([k, f]) => [k, arbitraryOf(f)])));
}

/** 一条合法的示例记录（所有字段都有值） */
export function sampleRecord(agg: AnyAggregate, overrides: Record<string, unknown> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, f] of Object.entries(agg.fields as Fields)) if (f.kind !== 'hasMany') out[k] = sampleValue(f, k);
  return { ...out, ...overrides };
}

/**
 * 构造命令 handler 的草稿：状态取命令的第一个起始状态（新建命令取目标状态）
 *   const order = draftOf(approve, { items: [{ sku: 'A-01', qty: 10 }] })
 */
export function draftOf<C extends AnyCommand>(cmd: C, overrides: Partial<Draft<C['agg']>> = {}): Draft<C['agg']> {
  const now = new Date().toISOString();
  const status = cmd.from === 'new' ? cmd.to : (cmd.from as readonly string[])[0];
  return {
    id: randomUUID(),
    status,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...sampleRecord(cmd.agg),
    ...overrides,
  } as Draft<C['agg']>;
}

/** 内存只读仓储：等值条件查询，与内核的 ReadRepo 接口一致 */
export function fakeRepo<A extends AnyAggregate = AnyAggregate>(rows: Record<string, any>[]): ReadRepo<A> {
  const match = (r: Record<string, any>, where?: Record<string, unknown>) =>
    Object.entries(where ?? {}).every(([k, v]) => v === undefined || JSON.stringify(r[k] ?? null) === JSON.stringify(v));
  const clone = (r: any) => structuredClone(r);
  return {
    get: async (id) => clone(rows.find((r) => r.id === id) ?? null),
    find: async (where, opts) => rows.filter((r) => match(r, where as any)).slice(0, opts?.limit ?? Infinity).map(clone),
    findOne: async (where) => clone(rows.find((r) => match(r, where as any)) ?? null),
    count: async (where) => rows.filter((r) => match(r, where as any)).length,
  } as ReadRepo<A>;
}

/** 直接调用 handler 时的第四个参数 */
export function handlerCtx(actorUserId: string | null = randomUUID()) {
  return Object.freeze({ now: new Date(), actorUserId });
}
