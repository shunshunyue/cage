/**
 * 把后端输入和字段定义转换为契约中的 Zod 源码，并报告无法完整迁移到浏览器的规则。
 * 先借助 JSON Schema 表达结构，再重建可支持的约束；递归、refine、transform 等保留明确边界。
 * 这里只返回代码字符串和诊断，不运行生成代码；客户端校验不能替代服务端，掩码及可空读值按读侧语义处理。
 */
// 生成可表达的输入校验；自定义函数仍由服务端执行，生成报告必须明确列出这些边界。
import { isRelation, type AnyField, type Fields } from '@yss123/cage-kernel';
import { z } from 'zod';

/**
 * 把字段名或字面值编码为安全的 JavaScript 字符串语法，生成器不手写引号转义。
 */
const str = (s: string) => JSON.stringify(s);
const activeJsonSchemas = new Set<object>();

/**
 * 输入规则不能无损进入契约时的字段路径与原因，供生成器报告服务端校验边界。
 */
export interface SchemaDiagnostic { /** 从 $ 起始的 schema 路径，数组元素用 [] 表示。 */ path: string; /** 不能完整序列化或需要服务端校验的具体原因。 */ reason: string }

/** Inspect the original schema: JSON Schema intentionally cannot retain executable refinements. */
/**
 * 递归检查原始 Zod 结构中的可执行转换、校验及循环。
 * @param schema 原始输入 schema。
 * @param path 诊断起始路径，默认 $。
 * @returns 服务端专属规则列表；祖先集合防止递归无限展开，不运行校验函数。
 */
export function schemaDiagnostics(schema: z.ZodType, path = '$'): SchemaDiagnostic[] {
  const findings: SchemaDiagnostic[] = [];
  const visit = (value: any, at: string, ancestors: Set<unknown>) => {
    if (!value?._zod) return;
    if (ancestors.has(value)) {
      findings.push({ path: at, reason: '递归结构的后续层级只在服务端完整校验' });
      return;
    }
    const next = new Set(ancestors).add(value);
    const def = value._zod.def;
    if (def.coerce || ['transform', 'pipe', 'date', 'bigint', 'symbol', 'function', 'map', 'set', 'promise', 'custom', 'lazy', 'catch', 'prefault', 'undefined', 'void', 'file', 'readonly'].includes(def.type))
      findings.push({ path: at, reason: `${def.type} 不能无损生成；对应规则只在服务端执行` });
    for (const check of def.checks ?? []) {
      if (['custom', 'overwrite'].includes(check._zod?.def?.check)) findings.push({ path: at, reason: '自定义 refine/superRefine 或输入转换仅由服务端执行' });
      if (check._zod?.def?.pattern instanceof RegExp && check._zod.def.pattern.flags)
        findings.push({ path: at, reason: '正则 flags 无法由 JSON Schema 无损保留；完整匹配规则只在服务端执行' });
    }
    if (def.type === 'object') for (const [key, child] of Object.entries(def.shape ?? {})) visit(child, `${at}.${key}`, next);
    if (def.element) visit(def.element, `${at}[]`, next);
    if (def.innerType) visit(def.innerType, at, next);
    if (def.in) visit(def.in, at, next);
    if (def.left) visit(def.left, at, next);
    if (def.right) visit(def.right, at, next);
    if (def.catchall) visit(def.catchall, `${at}.*`, next);
    if (def.keyType) visit(def.keyType, `${at}{key}`, next);
    if (def.valueType) visit(def.valueType, `${at}.*`, next);
    for (const [index, child] of (def.options ?? def.items ?? []).entries()) visit(child, `${at}[${index}]`, next);
    if (def.rest) visit(def.rest, `${at}[rest]`, next);
  };
  visit(schema, path, new Set());
  return findings;
}

/**
 * 把 Zod 输入转成可表达的客户端代码，对转换/带 flags 正则避免生成比服务器更严格的规则。
 * @param schema 后端输入 schema。
 * @returns Zod 源码表达式；不可转换的结构抛 CAGE-GEN-003，服务端仍权威。
 */
export function zodCodeOf(schema: z.ZodType): string {
  let js: any;
  try {
    js = z.toJSONSchema(schema, {
      unrepresentable: 'any', io: 'input',
      override: ({ zodSchema, jsonSchema }) => {
        const def = (zodSchema as any)._zod?.def;
        // A transform may make otherwise invalid raw input valid (trim before max, catch fallback).
        // Dropping that node is safer than generating a stricter client-side rule.
        if (def?.type === 'catch' || def?.checks?.some((check: any) => check._zod?.def?.check === 'overwrite'))
          for (const key of Object.keys(jsonSchema)) delete (jsonSchema as any)[key];
        else if (def?.checks?.some((check: any) => check._zod?.def?.pattern instanceof RegExp && check._zod.def.pattern.flags)) {
          delete jsonSchema.pattern;
          delete jsonSchema.allOf;
        }
      },
    });
  } catch (error) {
    throw new Error(`[CAGE-GEN-003] 输入 schema 无法转换：${String(error)}`);
  }
  return jsonToZod(js, js);
}

/**
 * 在基础 Zod 字符串上附可表达长度、区间、倍数及数组大小检查，不解释自定义可执行函数。
 */
function withChecks(base: string, s: any): string {
  let out = base;
  if (s.type === 'string' || base.startsWith('z.string')) {
    if (typeof s.minLength === 'number') out += `.min(${s.minLength})`;
    if (typeof s.maxLength === 'number') out += `.max(${s.maxLength})`;
    if (typeof s.pattern === 'string') out += `.regex(new RegExp(${str(s.pattern)}))`;
  }
  if (s.type === 'number' || s.type === 'integer') {
    if (typeof s.minimum === 'number') out += `.min(${s.minimum})`;
    if (typeof s.maximum === 'number') out += `.max(${s.maximum})`;
    if (typeof s.exclusiveMinimum === 'number') out += `.gt(${s.exclusiveMinimum})`;
    if (typeof s.exclusiveMaximum === 'number') out += `.lt(${s.exclusiveMaximum})`;
    if (typeof s.multipleOf === 'number') out += `.multipleOf(${s.multipleOf})`;
  }
  if (s.type === 'array') {
    if (typeof s.minItems === 'number') out += `.min(${s.minItems})`;
    if (typeof s.maxItems === 'number') out += `.max(${s.maxItems})`;
  }
  return out;
}

/**
 * 带递归保护地转换 JSON Schema，并保留有 default 属性的默认值。
 * @param s 当前 JSON Schema 节点。
 * @param root 本地 $ref 的根。
 * @returns Zod 表达式；递归继续部分放宽为 unknown 并标注，finally 清除当前活动节点。
 */
export function jsonToZod(s: any, root: any): string {
  if (s && activeJsonSchemas.has(s)) return 'z.unknown() /* CAGE-GEN-003: recursive validation remains server-only */';
  if (s && typeof s === 'object') activeJsonSchemas.add(s);
  try {
    const code = jsonToZodInner(s, root);
    return s && Object.prototype.hasOwnProperty.call(s, 'default') ? `${code}.default(${JSON.stringify(s.default)})` : code;
  } finally { if (s && typeof s === 'object') activeJsonSchemas.delete(s); }
}

/**
 * 处理引用、枚举、组合和基础 JSON Schema 类型，未知结构仅按当前分支明确放宽或报错。
 * 对象 required/default 决定 optional，additionalProperties 区分 strict/loose/catchall。
 */
function jsonToZodInner(s: any, root: any): string {
  if (s === false) return 'z.never()';
  if (!s || typeof s !== 'object' || Object.keys(s).length === 0) return 'z.unknown()';
  if (s.$ref) {
    const ref = String(s.$ref);
    const def = ref === '#' ? root : ref.startsWith('#/')
      ? ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((value, key) => value?.[key], root)
      : undefined;
    if (!def) throw new Error(`[CAGE-GEN-003] 无法解析 schema 引用 ${String(s.$ref)}`);
    return jsonToZod(def, root);
  }
  if (s.const !== undefined) return `z.literal(${JSON.stringify(s.const)})`;
  if (Array.isArray(s.enum)) {
    if (!s.enum.length) return 'z.never()';
    if (s.enum.length === 1) return `z.literal(${JSON.stringify(s.enum[0])})`;
    if (s.enum.every((v: unknown) => typeof v === 'string')) return `z.enum([${s.enum.map(str).join(', ')}])`;
    return `z.union([${s.enum.map((v: unknown) => `z.literal(${JSON.stringify(v)})`).join(', ')}])`;
  }
  const variants = s.anyOf ?? s.oneOf;
  if (Array.isArray(s.allOf)) {
    const { allOf, ...base } = s;
    const baseCode = jsonToZod(base, root);
    const codes = [...(baseCode === 'z.unknown()' ? [] : [baseCode]), ...allOf.map((part: any) => jsonToZod(s.type && !part.type ? { type: s.type, ...part } : part, root))];
    return codes.length ? codes.reduce((left: string, right: string) => `z.intersection(${left}, ${right})`) : 'z.unknown()';
  }
  if (Array.isArray(variants)) {
    const nonNull = variants.filter((v: any) => v.type !== 'null');
    const nullable = nonNull.length !== variants.length;
    const inner =
      nonNull.length === 1
        ? jsonToZod(nonNull[0], root)
        : `z.union([${nonNull.map((v: any) => jsonToZod(v, root)).join(', ')}])`;
    return nullable ? `${inner}.nullable()` : inner;
  }
  if (Array.isArray(s.type)) {
    const nonNull = s.type.filter((t: string) => t !== 'null');
    const inner = nonNull.length === 1 ? jsonToZod({ ...s, type: nonNull[0] }, root) : 'z.unknown()';
    return s.type.includes('null') ? `${inner}.nullable()` : inner;
  }
  switch (s.type) {
    case 'string': {
      if (s.format === 'uuid') return withChecks('z.string().uuid()', s);
      if (s.format === 'email') return withChecks('z.string().email()', { ...s, pattern: undefined });
      if (s.format === 'date-time') return withChecks('z.string().datetime({ offset: true })', s);
      if (s.format === 'uri' || s.format === 'url') return withChecks('z.string().url()', s);
      if (s.format === 'date') return withChecks('z.iso.date()', s);
      if (s.format === 'time') return withChecks('z.iso.time()', s);
      if (s.format === 'duration') return withChecks('z.iso.duration()', s);
      return withChecks('z.string()', s);
    }
    case 'integer':
      return withChecks('z.number().int()', s);
    case 'number':
      return withChecks('z.number()', s);
    case 'boolean':
      return 'z.boolean()';
    case 'null':
      return 'z.null()';
    case 'array':
      if (s.prefixItems) {
        const tuple = `z.tuple([${s.prefixItems.map((item: unknown, index: number) => `${jsonToZod(item, root)}${typeof s.minItems === 'number' && index >= s.minItems ? '.optional()' : ''}`).join(', ')}])`;
        return s.items && typeof s.items === 'object' ? `${tuple}.rest(${jsonToZod(s.items, root)})` : tuple;
      }
      return withChecks(`z.array(${jsonToZod(s.items ?? {}, root)})`, s);
    case 'object': {
      const props = Object.entries(s.properties ?? {});
      if (props.length === 0 && s.additionalProperties && typeof s.additionalProperties === 'object') {
        return `z.record(${s.propertyNames ? jsonToZod({ type: 'string', ...s.propertyNames }, root) : 'z.string()'}, ${jsonToZod(s.additionalProperties, root)})`;
      }
      const req = new Set<string>(s.required ?? []);
      const body = props
        .map(
          ([k, v]) =>
            `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)}: ${jsonToZod(v, root)}${req.has(k) || Object.prototype.hasOwnProperty.call(v, 'default') ? '' : '.optional()'}`,
        )
        .join(', ');
      const object = `z.object({ ${body} })`;
      if (s.additionalProperties === false) return `${object}.strict()`;
      if (s.additionalProperties === true) return `${object}.loose()`;
      if (s.additionalProperties && typeof s.additionalProperties === 'object') return `${object}.catchall(${jsonToZod(s.additionalProperties, root)})`;
      return object;
    }
    default:
      if (s.not && Object.keys(s.not).length === 0) return 'z.never()';
      if (!s.type) return 'z.unknown()';
      throw new Error(`[CAGE-GEN-003] 无法生成 JSON Schema 类型 ${String(s.type)}`);
  }
}

/** 读侧快照的字段 schema：敏感字段返回的是掩码值，所以只校验为字符串 */
/**
 * 根据聚合字段生成读侧 schema，敏感字段按掩码字符串处理。
 * @param f 字段定义。
 * @returns Zod 源码；可选字段同时接受 null 和 undefined，不复制服务端业务约束。
 */
export function fieldReadCode(f: AnyField): string {
  let base: string;
  if (f.sensitiveKind) base = 'z.string()';
  else {
    switch (f.kind) {
      case 'int':
        base = 'z.number().int()';
        break;
      case 'number':
        base = 'z.number()';
        break;
      case 'bool':
        base = 'z.boolean()';
        break;
      case 'id':
      case 'ref':
      case 'file':
        base = 'z.string().uuid()';
        break;
      case 'files':
        base = `z.array(z.string().uuid()).max(${f.filePolicy!.maxCount})`;
        break;
      case 'enum':
        base = `z.enum([${(f.values ?? []).map(str).join(', ')}])`;
        break;
      case 'list': {
        const shape = f.shape ?? {};
        if ('item' in shape && Object.keys(shape).length === 1)
          base = `z.array(${fieldReadCode(shape.item)})`;
        else if (Object.keys(shape).length === 0) base = 'z.record(z.string(), z.unknown())';
        else
          base = `z.array(z.object({ ${Object.entries(shape)
            .map(([k, sf]) => `${k}: ${fieldReadCode(sf)}`)
            .join(', ')} }))`;
        break;
      }
      default:
        base = 'z.string()';
    }
  }
  return f.isOptional ? `${base}.nullable().optional()` : base;
}

/**
 * 生成聚合读快照 schema，附 ID、状态、版本与时间系统列。
 * @param fields 聚合字段，隐藏字段和虚拟关系不内嵌。
 * @param states 允许状态列表。
 * @returns 对象 schema 源码；关联通过独立分页接口读取。
 */
export function snapshotCode(fields: Fields, states: readonly string[]): string {
  const lines = [
    'id: z.string().uuid()',
    ...Object.entries(fields)
      .filter(([, f]) => !f.isHidden && !isRelation(f))
      .map(([k, f]) => `${k}: ${fieldReadCode(f)}`),
    `status: z.enum([${states.map(str).join(', ')}])`,
    'version: z.number().int()',
    'createdAt: z.string()',
    'updatedAt: z.string()',
  ];
  return `z.object({\n${lines.map((l) => `  ${l},`).join('\n')}\n})`;
}
