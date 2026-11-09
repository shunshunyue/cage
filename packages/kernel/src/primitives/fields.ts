/**
 * 提供字段原语、不可变修饰器及值类型推导，使验证、存储、关系、敏感呈现和生成契约共享元数据。
 * 字段构造只创建描述，不创建表或上传文件；集合关系和文件生命周期有专门边界，不能当作普通 JSON 明细或任意 SQL 类型绕过。
 */
// 字段原语：每个字段同时携带校验（Zod）、存储（SQL 列类型）和元数据（敏感种类、引用目标）。
import { z } from 'zod';
import { declError } from '../errors.js';

/** 敏感种类是封闭集合，每种在内核里有一个掩码函数（见 db/ddl.ts 的 sys.mask）。 */
export type SensitiveKind = 'phone' | 'idCard' | 'bankCard' | 'email' | 'name' | 'address';
/**
 * 允许使用的敏感种类白名单，与内核安全视图及呈现掩码实现保持一致；新增种类需同时维护实际掩码语义。
 */
export const SENSITIVE_KINDS: readonly SensitiveKind[] = ['phone', 'idCard', 'bankCard', 'email', 'name', 'address'];

/**
 * 框架识别的字段类别，决定存储、关系和生成行为。
 * json 工厂复用 list 类别并以 jsonb 存储，不新增独立 json 标签；集合关系使用空 SQL 类型并由专门关系层处理。
 */
export type FieldKind =
  | 'id' | 'ref' | 'text' | 'int' | 'number' | 'money' | 'date' | 'datetime' | 'bool' | 'enum' | 'list'
  | 'hasMany' | 'manyToMany' | 'file' | 'files';

/** 文件内容由存储服务管理；领域字段只保存不可变文件 ID。 */
/** 上传服务和事务绑定共同使用的政策；accept 是明确 MIME 列表，maxBytes 按单个文件计。 */
export interface FilePolicy {
  /**
   * 单个文件允许的最大字节数，必须为正安全整数；不是整个多附件字段的总大小。
   */
  readonly maxBytes: number;
  /**
   * 明确允许的 MIME 类型列表，不接受通配形式；实际内容和请求类型仍由文件服务复核。
   */
  readonly accept: readonly string[];
  /**
   * 多附件最多数量，files 必填且范围 1 至 100；单附件工厂不使用此项。
   */
  readonly maxCount?: number;
}

/** 元数据必须与 base 校验一起传播；DDL、图谱、掩码、契约生成都从同一份声明读取。 */
export interface FieldMeta {
  /**
   * 字段类别，供生成器、关系和写入流程分派，不是数据库类型字符串。
   */
  readonly kind: FieldKind;
  /**
   * 物理列 SQL 类型；集合关系为空字符串表示没有主表列，普通业务不自行拼接此值。
   */
  readonly sql: string;
  /**
   * 是否显式 optional：schema 同时允许缺省与 null，数据库列允许空值；集合关系以空数组表达无关联。
   */
  readonly isOptional: boolean;
  /**
   * 可选敏感掩码类别；是否能见明文取决于调用主体的解掩码权限。
   */
  readonly sensitiveKind?: SensitiveKind;
  /** 引用的聚合名，抽取器据此画引用边，生成外键 */
  readonly ref?: string;
  /** hasMany 的反向外键。关系字段不占主表列，sql 为空字符串。 */
  readonly mappedBy?: string;
  /**
   * 是否要求租户内唯一，缺省不添加字段唯一约束；与引用目标必填或全局唯一不同。
   */
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
  /**
   * file/files 的上传与绑定限制，其他类别省略；完成上传仍需命令事务绑定。
   */
  readonly filePolicy?: FilePolicy;
}

/**
 * 字段定义。方法都返回新对象（不可变），可以链式调用：
 *   text(50).sensitive('phone').optional()
 */
export class Field<T extends z.ZodType = z.ZodType, Opt extends boolean = boolean, K extends FieldKind = FieldKind> implements FieldMeta {
  /**
   * 具体字段类别，构造后冻结；类型参数 K 保留关系/文件等特殊语义。
   */
  readonly kind: K;
  /**
   * 供 DDL 使用的列类型，集合关系无主表列时为空字符串。
   */
  readonly sql: string;
  /**
   * 显式可空/可缺省标志，缺省 false，修饰器返回新实例。
   */
  readonly isOptional: boolean;
  /**
   * 敏感呈现类别，省略表示未声明掩码。
   */
  readonly sensitiveKind?: SensitiveKind;
  /**
   * 引用或集合目标聚合名；这里只保存标识，注册阶段继续校验目标存在与关系一致性。
   */
  readonly ref?: string;
  /**
   * hasMany 目标聚合上实际外键字段名，其他类别省略。
   */
  readonly mappedBy?: string;
  /**
   * 租户内唯一要求，普通字段通过 unique() 声明；文件和集合拒绝此修饰。
   */
  readonly isUnique?: boolean;
  /**
   * 是否从公开安全读、审计差异、事件呈现和契约中排除；不代表业务内部永不读取。
   */
  readonly isHidden?: boolean;
  /**
   * 字段口径说明，供本体/影响分析使用，不执行额外验证。
   */
  readonly description?: string;
  /**
   * enum 的允许字符串值集合；其他字段通常省略。
   */
  readonly values?: readonly string[];
  /**
   * list 对象元素字段结构，标量数组保存为 { item }，供契约和图谱理解 JSON 内容。
   */
  readonly shape?: Readonly<Record<string, AnyField>>;
  /**
   * 文本最长字符数元数据，对应其 Zod 长度约束。
   */
  readonly max?: number;
  /**
   * 附件的单文件大小、MIME 和数量政策，实际上传及绑定阶段复核。
   */
  readonly filePolicy?: FilePolicy;
  /** 基础校验（不含可空） */
  readonly base: T;
  /** 仅用于类型推导 */
  declare readonly __opt?: Opt;

  /**
   * 复制基础 schema 与元数据并冻结当前字段实例；isOptional 缺省为 false。
   * 专门工厂负责各类别声明校验，构造本身不执行数据库 DDL、不深度冻结任意传入对象，也不解析用户值。
   */
  constructor(base: T, meta: Omit<FieldMeta, 'kind' | 'isOptional'> & { /** 保留当前字段类别类型，构造/复制时不把关系或文件降级为普通列。 */ kind: K; /** 构造元数据可省略，实际字段默认 false；显式 optional 修饰返回新实例。 */ isOptional?: boolean }) {
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

  /** 导出不含 Zod 实例的元数据快照，供不可变链式修饰复制；不修改当前字段。 */
  meta(): FieldMeta & { /** 保留当前字段类别类型，构造/复制时不把关系或文件降级为普通列。 */ kind: K } {
    return {
      kind: this.kind, sql: this.sql, isOptional: this.isOptional, sensitiveKind: this.sensitiveKind, ref: this.ref,
      isUnique: this.isUnique, isHidden: this.isHidden, description: this.description, values: this.values,
      shape: this.shape, max: this.max,
      mappedBy: this.mappedBy,
      filePolicy: this.filePolicy,
    };
  }

  /** 复用基础校验但复制元数据，避免一个字段模板被多个聚合引用时互相污染。 */
  private with<O extends boolean = Opt>(patch: Partial<Omit<FieldMeta, 'kind'>>): Field<T, O, K> {
    return new Field<T, O, K>(this.base, { ...this.meta(), ...patch });
  }

  /** 校验规则（前后端共用）；可选字段允许 null 与缺省 */
  get zod(): z.ZodType {
    return this.isOptional ? this.base.nullable().optional() : this.base;
  }

  /** 返回可空且可缺省的新字段，原字段不变；集合关系用空数组表达无关联，因此拒绝 optional。 */
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
  /** 返回要求租户内唯一的新字段；实际约束由 DDL/迁移落实，不是仅一次应用查询。文件和集合已有专用归属/配对语义，拒绝该修饰。 */
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
  /** 返回附业务口径说明的新字段，供图谱、契约和影响分析使用；文字不自动成为 Zod 或数据库校验。 */
  describe(text: string): Field<T, Opt, K> {
    return this.with({ description: text });
  }
}

/**
 * 擦除具体 Zod 输出与可选标志的字段容器类型，供异构字段集合使用；具体工厂返回值保留精确类型推导。
 */
export type AnyField = Field<z.ZodType, boolean>;
/**
 * 业务字段名到 Field 描述的映射；键名和系统保留字段由聚合构造器进一步检查。
 */
export type Fields = Record<string, AnyField>;

/** 字段的 TypeScript 值类型 */
export type ValueOf<F> = F extends Field<infer T, infer O, any> ? ([O] extends [true] ? z.output<T> | null : z.output<T>) : never;

// hasMany 是反向查询，不能出现在可写草稿里；manyToMany 在命令草稿中是目标 ID 集合。
/**
 * 把字段定义映射为业务值类型并移除 readonly；hasMany 是反向查询，排除在可写草稿外。
 * manyToMany 保留为目标 UUID 数组，optional 字段值允许 null，最终输入缺省规则由对应 Zod schema 决定。
 */
export type FieldValues<F extends Fields> = { -readonly [K in keyof F as F[K]['kind'] extends 'hasMany' ? never : K]: ValueOf<F[K]> };

// ---------- 字段构造函数 ----------

/** 字段工厂统一创建必填实例，只有显式 optional() 才放宽缺省/null。 */
function mk<T extends z.ZodType, const K extends FieldKind>(base: T, meta: Omit<FieldMeta, 'kind' | 'isOptional'> & { /** 明确字段类别，使工厂返回类型保留专用关系/文件语义。 */ kind: K }): Field<T, false, K> {
  return new Field<T, false, K>(base, meta);
}

/** 创建必填字符串字段，默认最多 500 字符并存为 text；不自动 trim 或要求非空，业务输入需另用 Zod 表达。 */
export const text = (max = 500) => mk(z.string().max(max), { kind: 'text', sql: 'text', max });
/** 创建必填整数值字段，Zod 检查整数，数据库使用 integer；数量单位、正负和业务上限由命令输入及不变量明确。 */
export const int = () => mk(z.number().int(), { kind: 'int', sql: 'integer' });
/** 创建必填普通数值字段，以 double precision 存储；不保证十进制精确计算，金额应使用 money 及明确业务计算规则。 */
export const number = () => mk(z.number(), { kind: 'number', sql: 'double precision' });
/** 创建十进制字符串金额字段，允许负号及最多两位小数，存储为 numeric(18,2)；币种/正负业务限制另声明，schema 正则不替代数据库精度上限。 */
export const money = () =>
  mk(z.string().regex(/^-?\d+(\.\d{1,2})?$/, '金额格式应为最多两位小数的数字字符串'), { kind: 'money', sql: 'numeric(18,2)' });
/** 创建 UUID 值字段并存为 uuid；不自动声明引用目标或外键，业务关联应使用 ref，聚合自己的主键仍由内核维护。 */
export const id = () => mk(z.string().uuid(), { kind: 'id', sql: 'uuid' });
/** 创建 YYYY-MM-DD 字符串日期字段并存为 date；此处正则检查格式，不独立证明闰年或日历日期真实有效。 */
export const date = () => mk(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'), { kind: 'date', sql: 'date' });
/** 创建带时区偏移的 ISO 时间字符串字段，使用 Zod datetime 校验并存为 timestamptz；业务显示时区由应用明确。 */
export const datetime = () => mk(z.string().datetime({ offset: true }), { kind: 'datetime', sql: 'timestamptz' });
/** 创建必填 boolean 字段并存为 boolean；不把字符串 true/false 或空值隐式转换为布尔值。 */
export const bool = () => mk(z.boolean(), { kind: 'bool', sql: 'boolean' });

/** 用至少一个明确字符串声明枚举值，Zod 校验后以 text 存储；这是普通属性取值，具有生命周期迁移语义时应使用 states。 */
export function enumOf<const V extends readonly [string, ...string[]]>(...values: V) {
  return mk(z.enum(values as unknown as [V[number], ...V[number][]]), { kind: 'enum', sql: 'text', values });
}

/** 引用另一个聚合：本质是 uuid，额外记下引用目标。可传聚合对象或聚合名（解决循环导入）。 */
export function ref(to: { /** 目标聚合声明的稳定名称，字符串形式可用于打破循环导入。 */ name: string } | string) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-FIELD-002', 'ref() 的目标为空，可能是循环导入；可改为 ref("聚合名")');
  return mk(z.string().uuid(), { kind: 'ref', sql: 'uuid', ref: target });
}

/** 一对多反查：实际外键在目标聚合上，不创建另一份关系或可写数组。 */
export function hasMany(to: { /** 目标聚合声明名称，实际反向外键另由 mappedBy 指定。 */ name: string } | string, options: { /** 目标聚合上指回当前聚合的 ref 字段；关联读取使用该列，不在本聚合创建数组列。 */ mappedBy: string; /** 可选反向关系业务口径说明，供本体和契约展示。 */ description?: string }) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-REL-001', 'hasMany() 需要目标聚合；循环引用请使用聚合名字符串');
  return mk(z.array(z.string().uuid()), { kind: 'hasMany', sql: '', ref: target, ...options });
}

/** 多对多：字段与普通属性一处声明，中间表由框架生成；业务命令返回目标 ID 数组。 */
export function manyToMany(to: { /** 目标聚合声明名称，框架据此生成关联中间表和目标授权校验。 */ name: string } | string, options: { /** 可选集合关系业务说明，不改变中间表或授权语义。 */ description?: string } = {}) {
  const target = typeof to === 'string' ? to : to?.name;
  if (!target) throw declError('CAGE-REL-001', 'manyToMany() 需要目标聚合；循环引用请使用聚合名字符串');
  return mk(z.array(z.string().uuid()), { kind: 'manyToMany', sql: '', ref: target, ...options });
}

/**
 * 识别 hasMany/manyToMany 集合关系；ref 仍是主表 UUID 列，不在此分类中。
 */
export const isRelation = (field: FieldMeta): boolean => field.kind === 'hasMany' || field.kind === 'manyToMany';
/**
 * 识别单附件 file 与多附件 files，用于交给上传政策、绑定与生命周期校验，不检查某个文件当前是否可访问。
 */
export const isFile = (field: FieldMeta): boolean => field.kind === 'file' || field.kind === 'files';

/**
 * 在声明期拒绝无界上传政策，并去重冻结 MIME 列表；多附件数量限制为 1–100。
 * 这里只校验政策形式，实际字节数、内容类型及所属对象权限由文件服务和事务绑定复核。
 */
function filePolicy(options: FilePolicy, multiple: boolean): FilePolicy {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !options.accept?.length ||
      options.accept.some(type => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) ||
      (multiple && (!Number.isSafeInteger(options.maxCount) || options.maxCount! < 1 || options.maxCount! > 100)))
    throw declError('CAGE-FILE-001', '文件必须声明正整数 maxBytes、明确 MIME accept；多文件还需声明 1–100 的 maxCount');
  return Object.freeze({ maxBytes: options.maxBytes, accept: Object.freeze([...new Set(options.accept)]), ...(multiple ? { maxCount: options.maxCount } : {}) });
}

/** 单附件字段在主表保存 UUID；上传完成并不等于绑定成功，命令提交时才确定归属。 */
export function file(options: Omit<FilePolicy, 'maxCount'>) {
  return mk(z.string().uuid(), { kind: 'file', sql: 'uuid', filePolicy: filePolicy(options, false) });
}

/** 多附件以 ID 数组保存，独占归属仍由文件关联表保障；空数组表示当前没有附件。 */
export function files(options: FilePolicy & { /** 多附件必填数量上限，范围 1 至 100；空数组仍表示当前没有附件。 */ maxCount: number }) {
  return mk(z.array(z.string().uuid()).max(options.maxCount), { kind: 'files', sql: 'jsonb', filePolicy: filePolicy(options, true) });
}

/**
 * 把 JSON 对象明细的字段映射到 Zod shape；显式 optional 字段包装 nullable/optional，保持嵌套输入校验与值推导一致。
 */
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

/** 同时支持当前类实例和跨包副本的字段结构；不能据此证明用户自造对象的所有元数据合法。 */
export function isField(v: unknown): v is AnyField {
  return v instanceof Field || (!!v && typeof v === 'object' && 'kind' in (v as any) && 'base' in (v as any) && 'sql' in (v as any));
}

/** 把字段的实际 zod 规则合成为对象 schema，排除只读 hasMany 反向集合；manyToMany 仍作为可写 ID 数组参与验证，不额外添加系统列。 */
export function objectSchema(fields: Fields): z.ZodObject<any> {
  return z.object(Object.fromEntries(Object.entries(fields).filter(([, f]) => f.kind !== 'hasMany').map(([k, f]) => [k, f.zod])));
}

/** 结构不固定的 JSON 对象（例如能力点参数），存为 jsonb。业务字段请优先用 list 或具体类型。 */
export const json = () => mk(z.record(z.string(), z.unknown()), { kind: 'list', sql: 'jsonb' });
