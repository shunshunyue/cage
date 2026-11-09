/**
 * 把模型提交的有限查询计划编译到已授权聚合的 safe 视图。
 * 由助理查询工具调用，字段来自注册表、值使用参数绑定；不接受任意 SQL、关联表或隐藏字段，结果在审计成功后才交给模型。
 */
import { cageError, snake, isRelation, canUnmask, type Kernel, type Ctx, type AnyField } from '@yss123/cage-kernel';
import { queryPlanSchema } from '@yss123/cage-ai-protocol';
import { sql } from 'kysely';
import { parse } from './security.js';

/** NL2Query 编译到有限查询计划；标识符来自注册表，值永远参数化，执行账号只能读 safe。 */
/**
 * 验证查询计划与聚合 read 能力，并构造受限投影、过滤、排序和分组指标。
 * 隐藏字段、关系和 JSON 不参与计划；对敏感字段做过滤/排序/汇总要求解掩码能力，sum/avg 仅支持数值字段。
 * 在安全只读事务内设置 5 秒语句超时，取 limit+1 行判断截断；随后可靠写入用途审计，审计失败不交付已查询数据。
 * 返回来源、前 limit 行与 truncated 标记；结果受当前租户/范围约束，不能把截断页当作完整统计。
 */
export async function queryPlan(kernel: Kernel, ctx: Ctx, input: unknown): Promise<unknown> {
  const plan = parse(queryPlanSchema, input), agg = kernel.registry.aggregate(plan.aggregate);
  if (!agg || !ctx.capabilities.has(`${agg.name}.read`)) throw cageError('FORBIDDEN');
  const system: Record<string, string> = { id: 'id', status: 'status', version: 'version', createdAt: 'created_at', updatedAt: 'updated_at' };
  // 标识符只从系统字段和注册字段映射；对敏感值做过滤/排序/汇总可能泄漏信息，因此 operation 额外要求解掩码权。
  const field = (name: string, operation = false): string => {
    if (Object.hasOwn(system, name)) return system[name];
    const f: AnyField | undefined = agg.fields[name];
    if (!f || f.isHidden || isRelation(f) || f.sql === 'jsonb') throw cageError('INVALID_INPUT', '字段不支持查询计划');
    if (operation && f.sensitiveKind && !canUnmask(ctx, agg.name, f.sensitiveKind)) throw cageError('FORBIDDEN');
    return snake(name);
  };
  if (plan.metrics.length && plan.select?.some(n => !plan.groupBy.includes(n))) throw cageError('INVALID_INPUT', '汇总查询只能选择分组字段和指标');
  if (plan.groupBy.length && !plan.metrics.length) throw cageError('INVALID_INPUT', '分组必须包含指标');
  const selected = plan.select ?? (plan.metrics.length ? plan.groupBy : ['id', 'status', 'version']);
  const aliases = new Set(selected);
  const projections = selected.map(n => sql.ref(field(n, plan.metrics.length > 0)).as(n));
  for (const metric of plan.metrics) {
    if (aliases.has(metric.as)) throw cageError('INVALID_INPUT', '指标名称重复');
    aliases.add(metric.as);
    const ref = metric.field ? sql.ref(field(metric.field, true)) : sql.raw('*');
    if (metric.op !== 'count' && !metric.field) throw cageError('INVALID_INPUT', '该指标需要字段');
    if (['sum', 'avg'].includes(metric.op) && !['int', 'number', 'money'].includes(agg.fields[metric.field!]?.kind)) throw cageError('INVALID_INPUT', '汇总需要数值字段');
    const expr = metric.op === 'count' ? sql`count(${ref})` : metric.op === 'sum' ? sql`sum(${ref})` : metric.op === 'avg' ? sql`avg(${ref})` : metric.op === 'min' ? sql`min(${ref})` : sql`max(${ref})`;
    projections.push(expr.as(metric.as));
  }
  if (!projections.length) throw cageError('INVALID_INPUT', '必须选择字段或指标');
  const rows = await kernel.read.tx(ctx, async tx => {
    await sql`select set_config('statement_timeout', '5000', true)`.execute(tx);
    let query: any = tx.selectFrom(`safe.${agg.table.name}`).select(projections).where('status', '<>', 'deleted');
    const ops = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', in: 'in' } as const;
    for (const where of plan.where) {
      const column = field(where.field, true), f = agg.fields[where.field];
      const values = where.op === 'in' ? where.value : [where.value];
      if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => v === null || typeof v === 'object')) throw cageError('INVALID_INPUT', '过滤值必须是有界标量');
      if (f) for (const value of values) parse(f.base, value);
      query = query.where(sql.ref(column), ops[where.op], where.value);
    }
    for (const group of plan.groupBy) query = query.groupBy(sql.ref(field(group, true)));
    if (plan.orderBy) {
      if (plan.metrics.length && !aliases.has(plan.orderBy.field)) throw cageError('INVALID_INPUT', '只能按所选字段排序');
      query = query.orderBy(sql.ref(plan.metrics.length && aliases.has(plan.orderBy.field) ? plan.orderBy.field : field(plan.orderBy.field, true)), plan.orderBy.direction);
    }
    return query.limit(plan.limit + 1).execute();
  });
  // 计划可能读取敏感明文；审计失败时不向模型交付结果。
  await kernel.writeAudit(kernel.app, { tenantId: ctx.tenantId, actor: ctx.actor!.id, actorKind: ctx.actor!.kind, source: ctx.source,
    kind: 'read', capability: `${agg.name}.read`, aggregate: agg.name, result: 'ok', requestId: ctx.requestId,
    diff: { purpose: 'ai.queryPlan', fields: selected, metrics: plan.metrics, rows: rows.length } });
  return { source: `aggregate:${agg.name}`, rows: rows.slice(0, plan.limit), truncated: rows.length > plan.limit, limit: plan.limit };
}
