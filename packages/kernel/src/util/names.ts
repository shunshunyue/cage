// 命名转换：聚合名大驼峰 → 表名 snake_case、路由 kebab-case；字段名 camelCase ↔ 列名 snake_case。

/** 兼顾连续大写缩写和普通驼峰边界；输出用作数据库名字，调用前由声明层约束合法标识。 */
export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** 与表名转换共享分词规则，使自动 HTTP 路径和领域命名保持可推导关系。 */
export function kebab(s: string): string {
  return snake(s).replace(/_/g, '-');
}

/** 将数据库下划线列名转换为业务字段名；不改变已经是驼峰的字段。 */
export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 只改变首字符，供生成器保留后续缩写/驼峰；空字符串仍返回空字符串。 */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** 只改变首字符，适合从字段名构造公开类型名，不承担标识符合法性检查。 */
export function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 32 位哈希（FNV-1a），用于咨询锁编号 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** 稳定的 JSON 序列化（键排序），用于本体图比较 */
/** 对对象键排序但保持数组顺序；仅用于可 JSON 化的声明资料，不作为密码学签名规范。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}
