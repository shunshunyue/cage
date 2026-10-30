// 把 Zod schema（经 JSON Schema 中转）或字段声明翻译成 Zod 源码，写进前端契约。前后端校验规则因此永远一致。
import type { AnyField, Fields } from '@yss123/cage-kernel';
import { z } from 'zod';

const str = (s: string) => JSON.stringify(s);

export function zodCodeOf(schema: z.ZodType): string {
  let js: any;
  try {
    js = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return 'z.unknown()';
  }
  return jsonToZod(js, js);
}

function withChecks(base: string, s: any): string {
  let out = base;
  if (s.type === 'string' || base.startsWith('z.string')) {
    if (typeof s.minLength === 'number') out += `.min(${s.minLength})`;
    if (typeof s.maxLength === 'number') out += `.max(${s.maxLength})`;
    if (typeof s.pattern === 'string' && !s.format) out += `.regex(new RegExp(${str(s.pattern)}))`;
  }
  if (s.type === 'number' || s.type === 'integer') {
    if (typeof s.minimum === 'number') out += `.min(${s.minimum})`;
    if (typeof s.maximum === 'number') out += `.max(${s.maximum})`;
    if (typeof s.exclusiveMinimum === 'number') out += `.gt(${s.exclusiveMinimum})`;
    if (typeof s.exclusiveMaximum === 'number') out += `.lt(${s.exclusiveMaximum})`;
  }
  if (s.type === 'array') {
    if (typeof s.minItems === 'number') out += `.min(${s.minItems})`;
    if (typeof s.maxItems === 'number') out += `.max(${s.maxItems})`;
  }
  return out;
}

export function jsonToZod(s: any, root: any): string {
  if (!s || typeof s !== 'object' || Object.keys(s).length === 0) return 'z.unknown()';
  if (s.$ref) {
    const name = String(s.$ref).split('/').pop()!;
    const def = root.$defs?.[name] ?? root.definitions?.[name];
    return def ? jsonToZod(def, root) : 'z.unknown()';
  }
  if (s.const !== undefined) return `z.literal(${JSON.stringify(s.const)})`;
  if (Array.isArray(s.enum)) {
    if (s.enum.every((v: unknown) => typeof v === 'string')) return `z.enum([${s.enum.map(str).join(', ')}])`;
    return `z.union([${s.enum.map((v: unknown) => `z.literal(${JSON.stringify(v)})`).join(', ')}])`;
  }
  const variants = s.anyOf ?? s.oneOf;
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
      if (s.format === 'uuid') return 'z.string().uuid()';
      if (s.format === 'email') return withChecks('z.string().email()', { ...s, pattern: undefined });
      if (s.format === 'date-time') return 'z.string().datetime({ offset: true })';
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
      return withChecks(`z.array(${jsonToZod(s.items ?? {}, root)})`, s);
    case 'object': {
      const props = Object.entries(s.properties ?? {});
      if (props.length === 0 && s.additionalProperties && typeof s.additionalProperties === 'object') {
        return `z.record(z.string(), ${jsonToZod(s.additionalProperties, root)})`;
      }
      if (props.length === 0) return 'z.record(z.string(), z.unknown())';
      const req = new Set<string>(s.required ?? []);
      const body = props
        .map(
          ([k, v]) =>
            `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)}: ${jsonToZod(v, root)}${req.has(k) ? '' : '.optional()'}`,
        )
        .join(', ');
      return `z.object({ ${body} })`;
    }
    default:
      return 'z.unknown()';
  }
}

/** 读侧快照的字段 schema：敏感字段返回的是掩码值，所以只校验为字符串 */
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
        base = 'z.string().uuid()';
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

export function snapshotCode(fields: Fields, states: readonly string[]): string {
  const lines = [
    'id: z.string().uuid()',
    ...Object.entries(fields)
      .filter(([, f]) => !f.isHidden)
      .map(([k, f]) => `${k}: ${fieldReadCode(f)}`),
    `status: z.enum([${states.map(str).join(', ')}])`,
    'version: z.number().int()',
    'createdAt: z.string()',
    'updatedAt: z.string()',
  ];
  return `z.object({\n${lines.map((l) => `  ${l},`).join('\n')}\n})`;
}
