/**
 * 为 CLI 生成的测试提供真实数据库性质检查：能力、状态、范围、掩码、审计、幂等与不变量。
 * setup/teardown 控制隔离测试环境，通用样例无法构造或未覆盖成功路径时返回 SKIP，不能计为业务通过。
 * 不变量序列使用固定种子并保存脱敏轨迹；通用性质测试补充项目定向用例，不能替代完整业务验收。
 */
// cage test 生成的测试文件调用这里，对可构造的样本执行内核性质检查。
// 它能发现已覆盖路径的授权与不变量回归，不能证明任意业务输入或所有 HTTP 路由都安全。
import { loadScoped, systemCtx, type AnyAggregate, type AnyField, type Ctx, type Fields, type RegisteredCommand } from '@yss123/cage-kernel';
import { sql } from 'kysely';
import { z } from 'zod';
import { createTestEnv, type CallResult, type TestEnv } from './env.js';
import { sampleValue } from './fakes.js';
import { DerivedTestError, derivedRedactor, seededRandom, seededUuid, type DerivedInvariantResult, type DerivedOptions, type DerivedRunTrace } from './derived-diagnostics.js';
export { DerivedTestError, type DerivedOptions, type DerivedFixtureContext, type DerivedCommandTrace, type DerivedRunTrace, type DerivedInvariantResult } from './derived-diagnostics.js';

/**
 * 派生检查未执行到目标性质时的显式返回标识，用于由测试调用方记录跳过。
 */
export type Skip = 'skip';
/**
 * 统一跳过值，与成功断言结果区分；调用方须保留跳过计数和原因上下文。
 */
export const SKIP: Skip = 'skip';

/**
 * 从可表达的 JSON Schema 生成简单候选输入，优先常量/枚举与非 null 分支。
 * 不求解任意正则、refine 或跨字段规则；最终还需 safeParse，失败可导致派生用例跳过。
 */
function sampleJson(s: any, random: () => number): unknown {
  if (!s || typeof s !== 'object') return null;
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sampleJson(s.anyOf.find((x: any) => x.type !== 'null') ?? s.anyOf[0], random);
  switch (Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type) {
    case 'string':
      if (s.format === 'uuid') return seededUuid(random);
      if (s.format === 'email') return 'someone@example.com';
      if (s.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (s.pattern) return s.pattern.includes('\\d') ? '100.00' : 'a';
      return 'x'.repeat(Math.max(1, s.minLength ?? 1));
    case 'integer':
    case 'number':
      return Math.max(1, s.minimum ?? 1);
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => sampleJson(s.items, random));
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => (s.required ?? []).includes(k)).map(([k, v]) => [k, sampleJson(v, random)]));
    default:
      return null;
  }
}

/**
 * 派生检查句柄，先 setup 再调用检查，结束时 teardown。
 * 各方法返回可断言的观察结果或 SKIP；env 供项目定向检查复用，不能在 setup 前使用。
 */
export interface Derived {
  env(): TestEnv;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  capabilityDenied(cap: string): Promise<CallResult | Skip>;
  invalidTransition(cap: string, state: string): Promise<CallResult | Skip>;
  auditOnce(cap: string): Promise<{ rows: number } | Skip>;
  idempotent(cap: string): Promise<{ same: boolean; rows: number } | Skip>;
  scopeHidden(agg: string, combinator: 'self' | 'dept'): Promise<{ get: string; listed: boolean; rawVisible: boolean; baseDenied: boolean } | Skip>;
  outOfScopeWrite(cap: string): Promise<CallResult | Skip>;
  masked(agg: string): Promise<{ field: string; plain: unknown; seen: unknown }[] | Skip>;
  invariantsHold(agg: string, runs?: number): Promise<DerivedInvariantResult | Skip>;
}

/**
 * 为一个 domain 建立延迟初始化的性质测试集合，默认固定种子，非法 seed 立即拒绝。
 * 能力/状态检查构造针对性身份，范围检查验证详情、列表和裸安全视图；成功性质无法执行时报告 SKIP。
 * invariantsHold 先验证初始夹具再执行有限命令序列，区分准备失败和执行失败，并保留可定位轨迹。
 */
export function derived(domain: object, options: DerivedOptions = {}): Derived {
  const seed = options.seed ?? 20261103;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError('DerivedOptions.seed 必须是 uint32 整数');
  const random = seededRandom(seed);
  const uuid = () => seededUuid(random);
  let env: TestEnv;
  const rc = (cap: string): RegisteredCommand => {
    const c = env.kernel.registry.command(cap);
    if (!c) throw new Error(`没有命令 ${cap}`);
    return c;
  };
  const agg = (name: string): AnyAggregate => env.kernel.registry.aggregate(name)!;

  /**
   * 为样例中的引用准备真实记录 ID：部门复用根节点，用户新建空权限身份，其他对象走测试 insert。
   */
  async function refValue(target: string): Promise<string> {
    if (target === 'Dept') return env.rootDeptId;
    if (target === 'User') return (await env.user({ caps: [] })).id;
    return (await env.insert(target, { id: uuid() })).id;
  }

  /**
   * 使用指定随机源构造字段候选，文本和 ID 随种子变化，嵌套列表递归处理。
   * 仅为造数据策略，不保证满足业务不变量或已存在引用。
   */
  function fieldValue(field: AnyField, name: string, rng: () => number): unknown {
    if (field.isOptional) return null;
    if (field.kind === 'id' || field.kind === 'ref') return seededUuid(rng);
    if (field.kind === 'text' && !field.sensitiveKind) return `${name || 'text'}-${seededUuid(rng).slice(0, 8)}`.slice(0, field.max ?? 500);
    if (field.kind === 'list' && field.shape) {
      if ('item' in field.shape && Object.keys(field.shape).length === 1) return [fieldValue(field.shape.item, 'item', rng)];
      return [Object.fromEntries(Object.entries(field.shape).map(([key, entry]) => [key, fieldValue(entry, key, rng)]))];
    }
    return sampleValue(field, name);
  }

  /** 构造可通过输入 schema 的候选；handler 的业务规则仍可能拒绝。 */
  /**
   * 结合已有记录、同名聚合字段及输入 schema 构造命令候选，并用 Zod 做最终输入校验。
   * 集合引用先准备目标记录；非对象 schema 或校验失败返回 null，不猜测任意业务合法值。
   */
  async function sampleInput(c: RegisteredCommand, seeded: Record<string, any> | null, rng = random): Promise<unknown | null> {
    const schema = c.cmd.input;
    if (!(schema instanceof z.ZodObject)) return null;
    let js: any = {};
    try {
      js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    } catch {
      js = {};
    }
    const fields = c.cmd.agg.fields as Fields;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(schema.shape)) {
      const required = (js.required ?? []).includes(key);
      if (key === 'id' && seeded) out.id = seeded.id;
      else if (seeded && key in seeded && seeded[key] !== null && seeded[key] !== undefined) out[key] = seeded[key];
      else if (key in fields) {
        const f = fields[key];
        if (f.isOptional && !required) continue;
        // 集合引用需要目标 ID 数组，不能沿用标量 ref 的取值；否则用例会被误判为无法造输入而跳过。
        out[key] = f.kind === 'manyToMany' ? [await refValue(f.ref!)] : f.kind === 'ref' ? await refValue(f.ref!) : fieldValue(f, key, rng);
      } else if (required) out[key] = sampleJson(js.properties?.[key], rng);
    }
    return schema.safeParse(out).success ? out : null;
  }

  /** 拥有全部能力、范围为全部的执行者；流程或外部专用命令用对应的系统身份 */
  /**
   * 按命令合法调用身份准备执行上下文；user 命令用全能力测试用户，流程类命令构造对应系统身份。
   * 只用于隔离测试，不表明生产系统会自动授权或允许客户端选择身份。
   */
  async function powerActor(c: RegisteredCommand): Promise<Ctx> {
    if (c.cmd.invokedBy.includes('user')) return (await env.user({ caps: 'all', scopes: { '*': 'all' } })).ctx();
    const kind = c.cmd.invokedBy[0] as 'process' | 'job' | 'external';
    return systemCtx({ kind, name: 'derived-test', tenantId: env.tenantId, capabilities: [c.capability], onBehalfOf: (await env.user({ caps: [] })).id });
  }

  return {
    env: () => env,
    async setup() {
      env = await createTestEnv({ domain });
    },
    async teardown() {
      await env?.close();
    },

    /**
     * 创建唯独缺少目标能力的用户，核对普通用户命令被拒绝；非 user 入口或无法造输入时跳过。
     */
    async capabilityDenied(cap) {
      const c = rc(cap);
      if (!c.cmd.invokedBy.includes('user')) return SKIP;
      const seeded = c.cmd.from === 'new' ? null : await env.seedFor(cap);
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      return env.callAs(await env.actorWithout(cap), cap, input);
    },

    /**
     * 以有足够权限的身份对指定非法状态尝试命令，使断言聚焦状态机拒绝。
     */
    async invalidTransition(cap, state) {
      const c = rc(cap);
      const seeded = await env.insert(c.cmd.agg, { status: state });
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      return env.callAs(await powerActor(c), cap, input);
    },

    /**
     * 执行一次成功命令后读取该对象/命令的写审计数量。
     * 样例被业务规则拒绝时跳过，不能把没走到成功路径解释成审计性质已验证。
     */
    async auditOnce(cap) {
      const c = rc(cap);
      const seeded = c.cmd.from === 'new' ? null : await env.seedFor(cap);
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      const r = await env.callAs(await powerActor(c), cap, input);
      if (!r.ok) return SKIP; // 业务规则拒绝了示例数据：没法走到成功路径
      const rows = await env.audit({ aggregateId: r.data.id, command: cap, kind: 'write' });
      return { rows: rows.length };
    },

    /**
     * 使用同一用户身份与幂等键并发执行两次，比较对象 ID、版本和写审计数量。
     * 非 user 或任一次失败返回 SKIP；该检查仅覆盖本次成功样例的幂等行为。
     */
    async idempotent(cap) {
      const c = rc(cap);
      if (!c.cmd.invokedBy.includes('user')) return SKIP;
      const seeded = c.cmd.from === 'new' ? null : await env.seedFor(cap);
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      const ctx = { ...(await powerActor(c)), idempotencyKey: uuid() };
      const [a, b] = await Promise.all([env.callAs(ctx, cap, input), env.callAs(ctx, cap, input)]);
      if (!a.ok || !b.ok) return SKIP;
      const rows = await env.audit({ aggregateId: a.data.id, command: cap, kind: 'write' });
      return { same: a.data.id === b.data.id && a.data.version === b.data.version, rows: rows.length };
    },

    /**
     * 准备不同归属身份，核对范围外对象在详情、列表和裸安全视图均不可见，并检查基表读取被拒绝。
     * 只覆盖 self/dept 且要求相应范围字段，不穷尽全部角色组合。
     */
    async scopeHidden(aggName, combinator) {
      const a = agg(aggName);
      if (combinator === 'self' && !a.scope.ownerField) return SKIP;
      if (combinator === 'dept' && (!a.scope.deptField || a.scope.deptField === 'id')) return SKIP;
      const deptA = await env.dept(`derived-a-${uuid().slice(0, 6)}`);
      const deptB = await env.dept(`derived-b-${uuid().slice(0, 6)}`);
      const owner = await env.user({ caps: [], deptId: deptA });
      const rec = await env.insert(a, { ownerId: owner.id, ...(a.scope.deptField && a.scope.deptField !== 'id' ? { [a.scope.deptField]: deptA } : {}) });
      const other = await env.user({ caps: [`${aggName}.read`], scopes: { [aggName]: combinator }, deptId: deptB });
      const ctx = await other.ctx();
      let get = 'ok';
      try {
        await env.kernel.read.get(a, rec.id, ctx);
      } catch (e: any) {
        get = e.code ?? 'ERROR';
      }
      const list = await env.kernel.read.list(a, { pageSize: 200 }, ctx);
      const db = await env.readConnectionAs(ctx);
      const raw = await sql<any>`select id from ${sql.table(`safe.${a.table.name}`)}`.execute(db);
      let baseDenied = false;
      try {
        await sql`select 1 from ${sql.table(`${a.table.schema}.${a.table.name}`)}`.execute(db);
      } catch (e) {
        baseDenied = /permission denied/.test(String(e));
      }
      await db.release();
      return { get, listed: list.items.some((x) => x.id === rec.id), rawVisible: raw.rows.some((r) => r.id === rec.id), baseDenied };
    },

    /**
     * 用本人范围身份尝试写入他人的记录，验证能力充足仍不能越过记录范围。
     * 新建命令、非用户入口或无 owner 字段时不适用并返回 SKIP。
     */
    async outOfScopeWrite(cap) {
      const c = rc(cap);
      if (c.cmd.from === 'new' || !c.cmd.invokedBy.includes('user') || !c.cmd.agg.scope.ownerField) return SKIP;
      const owner = await env.user({ caps: [] });
      const seeded = await env.seedFor(cap, { ownerId: owner.id });
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      const other = await env.user({ caps: 'all', scopes: { [c.cmd.agg.name]: 'self' } });
      return env.callAs(await other.ctx(), cap, input);
    },

    /**
     * 写入敏感字段样例后以只有读取能力的用户查询，返回原值与可见值供掩码断言。
     */
    async masked(aggName) {
      const a = agg(aggName);
      const sens = Object.entries(a.fields as Fields).filter(([, f]) => f.sensitiveKind);
      if (sens.length === 0) return SKIP;
      const values = Object.fromEntries(sens.map(([k, f]) => [k, sampleValue(f, k, true)]));
      const rec = await env.insert(a, values);
      const reader = await env.user({ caps: [`${aggName}.read`], scopes: { [aggName]: 'all' } });
      const got = await env.kernel.read.get(a, rec.id, await reader.ctx());
      return sens.map(([k]) => ({ field: k, plain: values[k], seen: got[k] }));
    },

    /**
     * 按固定种子运行有限轮次与命令序列，先核验初始持久快照，随后每步读取真实结果检查全部不变量。
     * 夹具失败立即抛结构化错误；序列第一次观察到不变量失败时保存前缀，不继续污染失败轨迹。
     * 正常业务拒绝仍作为一次尝试记录，不等于框架异常；返回 steps 供判断实际覆盖深度。
     */
    async invariantsHold(aggName, runs = 8) {
      const a = agg(aggName);
      const names = Object.keys(a.invariants);
      if (names.length === 0) return SKIP;
      const cmds = env.kernel.registry.commands.filter((c) => c.cmd.agg === a);
      const rng = seededRandom(seed);
      const redact = derivedRedactor(env.kernel.registry.aggregates);
      const violations: string[] = [];
      const traces: DerivedRunTrace[] = [];
      let steps = 0;
      const failedInvariants = (snapshot: Record<string, any>) => names.filter((name) => {
        try { return !a.invariants[name](snapshot as any); } catch { return true; }
      });
      for (let run = 0; run < runs; run++) {
        const trace: DerivedRunTrace = { aggregate: aggName, seed, run, phase: 'fixture', initial: null, preparation: [], commands: [], failedInvariants: [], minimalPrefix: [] };
        let rec: Record<string, any> | null = null;
        try {
          const fixture = options.fixtures?.[aggName];
          if (typeof fixture === 'function') {
            rec = await fixture({ env, aggregate: a, run, seed, random: rng, uuid: () => seededUuid(rng) });
          } else if (fixture) {
            rec = await env.insert(a, { id: seededUuid(rng), ...fixture });
          } else {
            const creators = cmds.filter((c) => c.cmd.from === 'new');
            if (creators.length) {
              const c = creators[run % creators.length];
              const input = await sampleInput(c, null, rng);
              if (input) {
                const result = await env.callAs(await powerActor(c), c.capability, input);
                trace.preparation.push({ step: 0, capability: c.capability, input: redact(input), result: { ok: result.ok, code: result.code, ...(!result.ok ? { domainCode: result.domainCode } : {}) } });
                if (result.ok) rec = result.data;
              }
            }
            if (!rec) {
              const values = Object.fromEntries(Object.entries(a.fields as Fields)
                .filter(([, field]) => field.kind !== 'ref' && field.kind !== 'hasMany').map(([name, field]) => [name, fieldValue(field, name, rng)]));
              trace.initial = redact(values);
              rec = await env.insert(a, { id: seededUuid(rng), ...values });
            }
          }
          // 必须读取完整持久快照检查初始不变量，不能等第一条业务命令失败才把非法种子算作业务反例。
          const initial = rec?.id ? await loadScoped(env.kernel.app, a, rec.id, env.system(), false) : null;
          if (!initial) throw new Error('fixture-record-missing');
          rec = initial;
          trace.initial = redact(initial);
          trace.failedInvariants = failedInvariants(initial);
          if (trace.failedInvariants.length) throw new DerivedTestError(trace);
        } catch (e) {
          if (e instanceof DerivedTestError) throw e;
          trace.failedInvariants = [`fixtureConstruction:${(e as { code?: string }).code ?? (e as Error).name ?? 'Error'}`];
          throw new DerivedTestError(trace);
        }
        trace.phase = 'execution';
        for (let i = 0; i < 4; i++) {
          const options = cmds.filter((c) => c.cmd.from !== 'new' && (c.cmd.from as string[]).includes(rec!.status));
          if (options.length === 0) break;
          const c = options[Math.floor(rng() * options.length)];
          const input = await sampleInput(c, rec, rng);
          if (!input) continue;
          let result: CallResult;
          try { result = await env.callAs(await powerActor(c), c.capability, input); }
          catch (e) {
            trace.commands.push({ step: i, capability: c.capability, input: redact(input), result: { ok: false, code: (e as { code?: string }).code ?? 'INTERNAL' } });
            trace.minimalPrefix = [...trace.commands];
            throw new DerivedTestError(trace);
          }
          steps++;
          trace.commands.push({ step: i, capability: c.capability, input: redact(input), result: { ok: result.ok, code: result.code, ...(!result.ok ? { domainCode: result.domainCode } : {}) } });
          const snap: Record<string, any> = (await loadScoped(env.kernel.app, a, rec!.id, env.system(), false))!;
          trace.failedInvariants = snap ? failedInvariants(snap) : ['recordMissing'];
          if (trace.failedInvariants.length) {
            trace.minimalPrefix = [...trace.commands];
            violations.push(`${c.capability} 之后 ${aggName}.${trace.failedInvariants.join(',')} 不成立；${JSON.stringify(trace)}`);
            break;
          }
          rec = snap;
        }
        traces.push(trace);
      }
      return { steps, violations, seed, traces };
    },
  };
}
