// 内存掩码：与数据库里的 sys.mask 语义一致，用于命令响应、审计 diff、事件载荷和日志。
import { type AnyAggregate, hiddenFields, sensitiveFields } from './primitives/aggregate.js';
import { isRelation, type Fields, type SensitiveKind } from './primitives/fields.js';
import type { Ctx } from './types.js';

/**
 * 按封闭敏感种类生成展示掩码，null/undefined 保持原值；未知种类保守地全部遮盖。
 * 掩码是展示策略而非加密，不能将返回字符串用于业务计算、唯一键或原样回写。
 */
export function maskValue(kind: SensitiveKind | string, val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const s = String(val);
  switch (kind) {
    case 'phone':
      return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : '****';
    case 'idCard':
      return s.length >= 8 ? `${s.slice(0, 4)}**********${s.slice(-4)}` : '****';
    case 'bankCard':
      return `**** **** **** ${s.slice(-4)}`;
    case 'email': {
      const at = s.indexOf('@');
      return at > 0 ? `${s.slice(0, 1)}***${s.slice(at)}` : '******';
    }
    case 'name':
      return `${s.slice(0, 1)}**`;
    case 'address':
      return `${s.slice(0, 6)}******`;
    default:
      return '******';
  }
}

/** 能不能看某聚合某种类的明文 */
export function canUnmask(ctx: Ctx | null, aggName: string, kind: string): boolean {
  return !!ctx && (ctx.unmask.includes(`${aggName}.${kind}`) || ctx.unmask.includes(`*.${kind}`));
}

/** 对外呈现快照：去掉隐藏字段；敏感字段按当前主体掩码（ctx 为 null 时一律掩码） */
/** 返回浅拷贝，不修改事务中的完整快照；集合关系另走双方授权的分页入口。 */
export function present(agg: AnyAggregate, snap: Record<string, any>, ctx: Ctx | null): Record<string, any> {
  const out = { ...snap };
  // 关联集合按需分页读取。命令响应不暴露内部完整 ID 集合，也不隐式读取目标内容。
  for (const [key, field] of Object.entries(agg.fields as Fields)) if (isRelation(field)) delete out[key];
  for (const k of hiddenFields(agg)) delete out[k];
  for (const [k, kind] of Object.entries(sensitiveFields(agg))) {
    if (k in out && !canUnmask(ctx, agg.name, kind)) out[k] = maskValue(kind, out[k]);
  }
  delete out.tenantId;
  return out;
}

/** 审计 diff：敏感字段掩码，隐藏字段只记录「已修改」 */
/** 审计不借用操作者的明文能力；即使操作者可解掩码，日志中仍遮盖敏感值。新建时 from 为 null。 */
export function auditDiff(agg: AnyAggregate, cur: Record<string, any> | null, next: Record<string, any>, changed: string[]) {
  const sens = sensitiveFields(agg);
  const hidden = new Set(hiddenFields(agg));
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of changed) {
    if (hidden.has(k)) {
      diff[k] = { from: '[hidden]', to: '[hidden]' };
      continue;
    }
    const kind = sens[k];
    diff[k] = {
      from: kind ? maskValue(kind, cur?.[k]) : cur?.[k] ?? null,
      to: kind ? maskValue(kind, next[k]) : next[k] ?? null,
    };
  }
  if (!cur || cur.status !== next.status) diff.status = { from: cur?.status ?? null, to: next.status };
  return diff;
}
