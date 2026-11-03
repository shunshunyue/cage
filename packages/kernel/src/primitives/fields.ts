// 字段原语：每个字段同时携带校验（Zod）、存储（SQL 列类型）和元数据（敏感种类、引用目标）。
import { z } from 'zod';
import { declError } from '../errors.js';

/** 敏感种类是封闭集合，每种在内核里有一个掩码函数（见 db/ddl.ts 的 sys.mask）。 */
export type SensitiveKind = 'phone' | 'idCard' | 'bankCard' | 'email' | 'name' | 'address';
export const SENSITIVE_KINDS: readonly SensitiveKind[] = ['phone', 'idCard', 'bankCard', 'email', 'name', 'address'];

export type FieldKind =
  | 'id' | 'ref' | 'text' | 'int' | 'number' | 'money' | 'date' | 'datetime' | 'bool' | 'enum' | 'list'
  | 'hasMany' | 'manyToMany' | 'file' | 'files';

/** 文件内容由存储服务管理；领域字段只保存不可变文件 ID。 */
export interface FilePolicy {
  readonly maxBytes: number;
  readonly accept: readonly string[];
  readonly maxCount?: number;
}

export interface FieldMeta {
  readonly kind: FieldKind;
  readonly sql: string;
  readonly isOptional: boolean;
  readonly sensitiveKind?: SensitiveKind;
  /** 引用的聚合名，抽取器据此画引用边，生成外键 */
  readonly ref?: string;
  /** hasMany 的反向外键。关系字段不占主表列，sql 为空字符串。 */
  readonly mappedBy?: string;
  readonly isUnique?: boolean;
  /** 隐藏字段：不进入安全视图、审计、事件、前端契约（例如密码哈希） */
  readonly isHidden?: boolean;
  /** 口径说明：变化会出现在影响分析里 */
  readonly description?: string;
  /** enum 的取值 */
  readonly values?: readonly string[];
  /** list 的元素结构；标量数组时为 { item } */
  readonly shape?: Readonly<Record<string, AnyField>>;
  /** 文本最大长度 */
  readonly max?: number;
  readonly filePolicy?: FilePolicy;
}

/**
 * 字段定义。方法都返回新对象（不可变），可以链式调用：
 *   text(50).sensitive('phone').optional()
 */
export class Field<T extends z.ZodType = z.ZodType, Opt extends boolean = boolean, K extends FieldKind = FieldKind> implements FieldMeta {
  readonly kind: K;
  readonly sql: string;
  readonly isOptional: boolean;
  readonly sensitiveKind?: SensitiveKind;
  readonly ref?: string;
  readonly mappedBy?: string;
  readonly isUnique?: boolean;
  readonly isHidden?: boolean;
  readonly description?: string;
  readonly values?: readonly string[];
  readonly shape?: Readonly<Record<string, AnyField>>;
  readonly max?: number;
  readonly filePolicy?: FilePolicy;
  /** 基础校验（不含可空） */
  readonly base: T;
  /** 仅用于类型推导 */
  declare readonly __opt?: Opt;

  constructor(base: T, meta: Omit<FieldMeta, 'kind' | 'isOptional'> & { kind: K; isOptional?: boolean }) {
    this.base = base;
    this.kind = meta.kind;
    this.sql = meta.sql;
    this.isOptional = meta.isOptional ?? false;
    this.sensitiveKind = meta.sensitiveKind;
    this.ref = meta.ref;
    this.mappedBy = meta.mappedBy;
    this.isUnique = meta.isUnique;
    this.isHidden = meta.isHidden;
    this.description = meta.description;
    this.values = meta.values;
    this.shape = meta.shape;
    this.max = meta.max;
    this.filePolicy = meta.filePolicy;
    Object.freeze(this);
  }

  meta(): FieldMeta & { kind: K } {
    return {
      kind: this.kind, sql: this.sql, isOptional: this.isOptional, sensitiveKind: this.sensitiveKind, ref: this.ref,
      isUnique: this.isUnique, isHidden: this.isHidden, description: this.description, values: this.values,
      shape: this.shape, max: this.max,
      mappedBy: this.mappedBy,
      filePolicy: this.filePolicy,
    };
  }

  private with<O extends boolean = Opt>(patch: Partial<Omit<FieldMeta, 'kind'>>): Field<T, O, K> {
    return new Field<T, O, K>(this.base, { ...this.meta(), ...patch });
  }

  /** 校验规则（前后端共用）；可选字段允许 null 与缺省 */
  get zod(): z.ZodType {
    return this.isOptional ? this.base.nullable().optional() : this.base;
  }

  /** 可选字段：列可空，输入可以不填 */
  optional(): Field<T, true, K> {
    if (isRelation(this)) throw declError('CAGE-REL-001', '集合关系使用空集合表示没有关联，不支持 optional');
    return this.with<true>({ isOptional: true });
  }
  /** 敏感字段：读侧按种类掩码，持有 聚合.unmask.种类 能力才能看明文 */
  sensitive(kind: SensitiveKind): Field<T, Opt, K> {
    if (isFile(this)) throw declError('CAGE-FILE-001', '文件字段通过所属对象授权，不支持字符串掩码');
    if (isRelation(this)) throw declError('CAGE-REL-001', '关系字段不支持 sensitive；目标字段按目标聚合权限掩码');
    if (!SENSITIVE_KINDS.includes(kind)) throw declError('CAGE-FIELD-001', `未知的敏感种类 ${kind}`);
    return this.with({ sensitiveKind: kind });
  }
  /** 唯一约束（租户内） */
  unique(): Field<T, Opt, K> {
    if (isFile(this)) throw declError('CAGE-FILE-001', '文件已按所属对象独占绑定，不支持 unique');
    if (isRelation(this)) throw declError('CAGE-REL-001', '集合关系自动保证关联对唯一，不支持单字段 unique');
    return this.with({ isUnique: true });
  }
  /** 隐藏字段：不出现在读侧、审计、事件和前端契约 */
  hidden(): Field<T, Opt, K> {
    if (isFile(this)) throw declError('CAGE-FILE-001', '文件字段必须公开声明，不能 hidden');
    if (isRelation(this)) throw declError('CAGE-REL-001', '关系使用所属对象和目标对象权限，不支持 hidden 修饰');
    return this.with({ isHidden: true });
  }
  /** 口径说明 */
  describe(text: string): Field<T, Opt, K> {
    return this.with({ description: text });
  }
}

export type AnyField = Field<z.ZodType, boolean>;
export type Fields = Record<string, AnyField>;

/** 字段的 TypeScript 值类型 */
export type ValueOf<F> = F extends Field<infer T, infer O, any> ? ([O] extends [true] ? z.output<T> | null : z.output<T>) : never;

// hasMany 是反向查询，不能出现在可写草稿里；manyToMany 在命令草稿中是目标 ID 集合。
export type FieldValues<F extends Fields> = { -readonly [K in keyof F as F[K]['kind'] extends 'hasMany' ? never : K]: ValueOf<F[K]> };

// ---------- 字段构造函数 ----------

function mk<T extends z.ZodType, const K extends FieldKind>(base: T, meta: Omit<FieldMeta, 'kind' | 'isOptional'> & { kind: K }): Field<T, false, K> {
  return new Field<T, false, K>(base, meta);
}

/** 文本，默认最长 500 字 */
export const text = (max = 500) => mk(z.string().max(max), { kind: 'text', sql: 'text', max });
/** 整数 */
export const int = () => mk(z.number().int(), { kind: 'int', sql: 'integer' });
/** 数值（双精度）。金额请用 money() */
export const number = () => mk(z.number(), { kind: 'number', sql: 'double precision' });
/** 金额：用字符串传输，避免浮点误差 */
export const money = () =>
  mk(z.string().regex(/^-?\d+(\.\d{1,2})?$/, '金额格式应为最多两位小数的数字字符串'), { kind: 'money', sql: 'numeric(18,2)' });
/** 主键或外键 */
export const id = () => mk(z.string().uuid(), { kind: 'id', sql: 'uuid' });
/** 日期 YYYY-MM-DD */
export const date = () => mk(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'), { kind: 'date', sql: 'date' });
/** 时间戳（ISO 8601） */
export const datetime = () => mk(z.string().datetime({ offset: true }), { kind: 'datetime', sql: 'timestamptz' });
/** 布尔 */
export const bool = () => mk(z.boolean(), { kind: 'bool', sql: 'boolean' });

/** 枚举：enumOf('A', 'B') */
export function enumOf<const V extends readonly [string, ...string[]]>(...values: V) {
  return mk(z.enum(values as unknown as [V[number], ...V[number][]]), { kind: 'enum', sql: 'text', values });
}

/** 引用另一个聚合：本质是 uuid，额外记下引用目标。可传聚合对象或聚合名（解决循环导入）。 */
export function ref(to: { name: string } | string) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-FIELD-002', 'ref() 的目标为空，可能是循环导入；可改为 ref("聚合名")');
  return mk(z.string().uuid(), { kind: 'ref', sql: 'uuid', ref: target });
}

/** 一对多反查：实际外键在目标聚合上，不创建另一份关系或可写数组。 */
export function hasMany(to: { name: string } | string, options: { mappedBy: string; description?: string }) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-REL-001', 'hasMany() 需要目标聚合；循环引用请使用聚合名字符串');
  return mk(z.array(z.string().uuid()), { kind: 'hasMany', sql: '', ref: target, ...options });
}

/** 多对多：字段与普通属性一处声明，中间表由框架生成；业务命令返回目标 ID 数组。 */
export function manyToMany(to: { name: string } | string, options: { description?: string } = {}) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-REL-001', 'manyToMany() 需要目标聚合；循环引用请使用聚合名字符串');
  return mk(z.array(z.string().uuid()), { kind: 'manyToMany', sql: '', ref: target, ...options });
}

export const isRelation = (field: FieldMeta): boolean => field.kind === 'hasMany' || field.kind === 'manyToMany';
export const isFile = (field: FieldMeta): boolean => field.kind === 'file' || field.kind === 'files';

function filePolicy(options: FilePolicy, multiple: boolean): FilePolicy {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !options.accept?.length ||
      options.accept.some(type => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) ||
      (multiple && (!Number.isSafeInteger(options.maxCount) || options.maxCount! < 1 || options.maxCount! > 100)))
    throw declError('CAGE-FILE-001', '文件必须声明正整数 maxBytes、明确 MIME accept；多文件还需声明 1–100 的 maxCount');
  return Object.freeze({ maxBytes: options.maxBytes, accept: Object.freeze([...new Set(options.accept)]), ...(multiple ? { maxCount: options.maxCount } : {}) });
}

export function file(options: Omit<FilePolicy, 'maxCount'>) {
  return mk(z.string().uuid(), { kind: 'file', sql: 'uuid', filePolicy: filePolicy(options, false) });
}

export function files(options: FilePolicy & { maxCount: number }) {
  return mk(z.array(z.string().uuid()).max(options.maxCount), { kind: 'files', sql: 'jsonb', filePolicy: filePolicy(options, true) });
}

type ShapeZod<S extends Fields> = {
  [K in keyof S]: S[K] extends Field<infer T, infer O> ? ([O] extends [true] ? z.ZodOptional<z.ZodNullable<T>> : T) : never;
};

/**
 * 明细行，存为 jsonb：
 *   list({ sku: text(), qty: int() })   对象数组
 *   list(id())                          标量数组
 */
export function list<T extends z.ZodType>(item: Field<T, false>): Field<z.ZodArray<T>, false>;
export function list<S extends Fields>(shape: S): Field<z.ZodArray<z.ZodObject<ShapeZod<S>>>, false>;
export function list(arg: Fields | AnyField): Field<z.ZodType, false> {
  const members = isField(arg) ? [arg] : Object.values(arg);
  if (members.some(isRelation)) throw declError('CAGE-REL-001', '关系字段只能直接声明在聚合 fields 中，不能嵌入 JSON 明细');
  if (members.some(isFile)) throw declError('CAGE-FILE-001', '文件字段只能直接声明在聚合 fields 中，不能嵌入 JSON 明细');
  if (isField(arg)) {
    return mk(z.array(arg.zod), { kind: 'list', sql: 'jsonb', shape: { item: arg } }) as any;
  }
  const item = z.object(Object.fromEntries(Object.entries(arg).map(([k, f]) => [k, f.zod])));
  return mk(z.array(item), { kind: 'list', sql: 'jsonb', shape: arg }) as any;
}

export function isField(v: unknown): v is AnyField {
  return v instanceof Field || (!!v && typeof v === 'object' && 'kind' in (v as any) && 'base' in (v as any) && 'sql' in (v as any));
}

/** 把一组字段拼成对象 schema */
export function objectSchema(fields: Fields): z.ZodObject<any> {
  return z.object(Object.fromEntries(Object.entries(fields).filter(([, f]) => f.kind !== 'hasMany').map(([k, f]) => [k, f.zod])));
}

/** 结构不固定的 JSON 对象（例如能力点参数），存为 jsonb。业务字段请优先用 list 或具体类型。 */
export const json = () => mk(z.record(z.string(), z.unknown()), { kind: 'list', sql: 'jsonb' });
