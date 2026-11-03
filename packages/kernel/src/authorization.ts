import { cageError, toCageError } from './errors.js';
import type { Kernel } from './kernel.js';
import { loadUserGrants } from './org.js';
import { assertInvoker } from './pipeline/invoker.js';
import { loadScoped } from './pipeline/load.js';
import type { ConstraintMeta } from './primitives/constraints.js';
import type { Ctx } from './types.js';
import { newDraft, splitRaw } from './pipeline/draft.js';

export interface AuthorizationCheck { stage: string; status: 'pass' | 'fail' | 'not-inspected'; code?: string; reason?: unknown }

function constraintReason(name: string): string {
  if (name.startsWith('ceiling(')) return '额度未配置或不足；请检查该能力的有效参数';
  if (name.startsWith('sod.notSameAs(')) return '职责分离条件未满足';
  if (name === 'stepUp') return '需要近期二次认证';
  return '硬约束未满足；请按约束名称检查规则';
}

/** 无 handler、无锁、无写入；可解释的判断复用实际身份、范围和约束实现。结果仅代表观测时刻。 */
export async function explainAuthorization(k: Kernel, capability: string, raw: Record<string, unknown>, ctx: Ctx) {
  const rc = k.registry.command(capability);
  if (!rc) throw cageError('NOT_FOUND');
  const cmd = rc.cmd, checks: AuthorizationCheck[] = [];
  const add = (stage: string, allowed: boolean, code?: string, reason?: unknown) => checks.push({ stage, status: allowed ? 'pass' : 'fail', code: allowed ? undefined : code, reason });
  add('authentication', !!ctx.actor && (ctx.actor.kind !== 'anonymous' || cmd.public), 'UNAUTHENTICATED');
  let split: ReturnType<typeof splitRaw>;
  try { split = splitRaw(raw); }
  catch (error) {
    const result = toCageError(error);
    checks.push({ stage: 'input', status: 'fail', code: result.code, reason: result.detail });
    return { command: capability, actor: ctx.actor, observedAt: new Date().toISOString(), allowed: false, checks };
  }
  const { expectedVersion, rest } = split;
  const parsed = cmd.input.safeParse(rest);
  add('input', parsed.success, 'INVALID_INPUT', parsed.success ? undefined : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  try { if (ctx.actor) assertInvoker(cmd, ctx, capability); else throw cageError('UNAUTHENTICATED'); add('invoker', true); }
  catch (error) { const result = toCageError(error); add('invoker', false, result.code, result.detail); }
  add('capability', cmd.public || ctx.capabilities.has(capability), 'FORBIDDEN', { capability });
  if (checks.every((check) => check.status === 'pass')) await k.app.transaction().setAccessMode('read only').execute(async (tx) => {
    const parsedInput = parsed.data as Record<string, unknown>;
    const current = cmd.from === 'new' ? newDraft(cmd, parsedInput, ctx, new Date()) : typeof parsedInput.id === 'string' ? await loadScoped(tx, cmd.agg, parsedInput.id, ctx, false) : null;
    if (cmd.from === 'new') checks.push({ stage: 'scope', status: 'not-inspected', reason: '新建最终范围要在 handler 合并后实际校验；诊断不执行 handler' });
    else add('scope', !!current, 'NOT_FOUND', current ? undefined : '对象不存在或不在有效范围内');
    if (!current) return;
    add('state', cmd.from === 'new' || (cmd.from as readonly string[]).includes(current.status), 'INVALID_TRANSITION');
    add('version', cmd.from === 'new' || expectedVersion === undefined || expectedVersion === current.version, 'CONFLICT');
    const meta: ConstraintMeta = {
      capability, capabilitiesOf: async (id) => (await loadUserGrants(tx, id, ctx.tenantId))?.capabilities ?? new Map(),
      load: async (name, id) => { const agg = k.registry.aggregate(name); return agg ? loadScoped(tx, agg, id, ctx, false) : null; },
      catalog: () => k.catalogCaps(),
    };
    for (const constraint of cmd.constraints) {
      // 自定义 message 可能拼入未解掩码的字段或关联对象值，诊断只返回固定说明与规则名称。
      try { const result = await constraint.check(current, ctx, parsed.data, meta); add(`constraint:${constraint.name}`, result.ok, 'CONSTRAINT_VIOLATED', result.ok ? undefined : constraintReason(constraint.name)); }
      catch { checks.push({ stage: `constraint:${constraint.name}`, status: 'not-inspected', reason: '约束检查依赖不可用，不能判定通过' }); }
    }
  });
  return { command: capability, actor: ctx.actor, observedAt: new Date().toISOString(), allowed: checks.some((check) => check.status === 'fail') ? false : checks.some((check) => check.status === 'not-inspected') ? null : true, checks,
    scope: ctx.scopes[cmd.agg.name] ?? ctx.scopes['*'] ?? [{ combinator: 'self' }], params: ctx.capabilities.get(capability) ?? {},
    limitations: ['只解释认证、输入、调用身份、能力、范围、状态、版本和硬约束；不执行 handler 或预测最终不变量。', '执行时会重新鉴权和加锁，诊断结果不能用于跳过实际授权。'] };
}
