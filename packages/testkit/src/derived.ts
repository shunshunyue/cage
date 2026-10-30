// 派生测试运行时：cage test 生成的测试文件调用这里。它们不是测 handler，而是持续证明「笼子没有洞」：
// 如果有人把内核的能力判定改坏了，或者某个路由绕过了内核，这一批测试会同时失败。
import { randomUUID } from 'node:crypto';
import { rowToSnapshot } from '@yss123/cage-kernel/db';
import { systemCtx, type AnyAggregate, type Ctx, type Fields, type RegisteredCommand } from '@yss123/cage-kernel';
import { sql } from 'kysely';
import { z } from 'zod';
import { createTestEnv, type CallResult, type TestEnv } from './env.js';
import { sampleValue } from './fakes.js';

export type Skip = 'skip';
export const SKIP: Skip = 'skip';

function sampleJson(s: any): unknown {
  if (!s || typeof s !== 'object') return null;
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sampleJson(s.anyOf.find((x: any) => x.type !== 'null') ?? s.anyOf[0]);
  switch (Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type) {
    case 'string':
      if (s.format === 'uuid') return randomUUID();
      if (s.format === 'email') return 'someone@example.com';
      if (s.format === 'date-time') return new Date().toISOString();
      if (s.pattern) return s.pattern.includes('\\d') ? '100.00' : 'a';
      return 'x'.repeat(Math.max(1, s.minLength ?? 1));
    case 'integer':
    case 'number':
      return Math.max(1, s.minimum ?? 1);
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => sampleJson(s.items));
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => (s.required ?? []).includes(k)).map(([k, v]) => [k, sampleJson(v)]));
    default:
      return null;
  }
}

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
  invariantsHold(agg: string, runs?: number): Promise<{ steps: number; violations: string[] } | Skip>;
}

export function derived(domain: object): Derived {
  let env: TestEnv;
  const rc = (cap: string): RegisteredCommand => {
    const c = env.kernel.registry.command(cap);
    if (!c) throw new Error(`没有命令 ${cap}`);
    return c;
  };
  const agg = (name: string): AnyAggregate => env.kernel.registry.aggregate(name)!;

  async function refValue(target: string): Promise<string> {
    if (target === 'Dept') return env.rootDeptId;
    if (target === 'User') return (await env.user({ caps: [] })).id;
    return (await env.insert(target)).id;
  }

  /** 构造一份合法输入：id 取种子数据；聚合同名字段取种子值或示例值；其他按 schema 造 */
  async function sampleInput(c: RegisteredCommand, seeded: Record<string, any> | null): Promise<unknown | null> {
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
        out[key] = f.ref ? await refValue(f.ref) : sampleValue(f, key);
      } else if (required) out[key] = sampleJson(js.properties?.[key]);
    }
    return schema.safeParse(out).success ? out : null;
  }

  /** 拥有全部能力、范围为全部的执行者；流程或外部专用命令用对应的系统身份 */
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

    async capabilityDenied(cap) {
      const c = rc(cap);
      if (!c.cmd.invokedBy.includes('user')) return SKIP;
      const seeded = c.cmd.from === 'new' ? null : await env.seedFor(cap);
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      return env.callAs(await env.actorWithout(cap), cap, input);
    },

    async invalidTransition(cap, state) {
      const c = rc(cap);
      const seeded = await env.insert(c.cmd.agg, { status: state });
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      return env.callAs(await powerActor(c), cap, input);
    },

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

    async idempotent(cap) {
      const c = rc(cap);
      if (!c.cmd.invokedBy.includes('user')) return SKIP;
      const seeded = c.cmd.from === 'new' ? null : await env.seedFor(cap);
      const input = await sampleInput(c, seeded);
      if (input === null) return SKIP;
      const ctx = { ...(await powerActor(c)), idempotencyKey: randomUUID() };
      const [a, b] = await Promise.all([env.callAs(ctx, cap, input), env.callAs(ctx, cap, input)]);
      if (!a.ok || !b.ok) return SKIP;
      const rows = await env.audit({ aggregateId: a.data.id, command: cap, kind: 'write' });
      return { same: a.data.id === b.data.id && a.data.version === b.data.version, rows: rows.length };
    },

    async scopeHidden(aggName, combinator) {
      const a = agg(aggName);
      if (combinator === 'self' && !a.scope.ownerField) return SKIP;
      if (combinator === 'dept' && (!a.scope.deptField || a.scope.deptField === 'id')) return SKIP;
      const deptA = await env.dept(`derived-a-${randomUUID().slice(0, 6)}`);
      const deptB = await env.dept(`derived-b-${randomUUID().slice(0, 6)}`);
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

    async invariantsHold(aggName, runs = 8) {
      const a = agg(aggName);
      const names = Object.keys(a.invariants);
      if (names.length === 0) return SKIP;
      const cmds = env.kernel.registry.commands.filter((c) => c.cmd.agg === a);
      const violations: string[] = [];
      let steps = 0;
      for (let run = 0; run < runs; run++) {
        // 随机命令序列：每一步之后，库里的数据都必须满足所有不变量
        let rec: Record<string, any> | null = null;
        const creators = cmds.filter((c) => c.cmd.from === 'new');
        if (creators.length) {
          const c = creators[run % creators.length];
          const input = await sampleInput(c, null);
          if (input) {
            const r = await env.callAs(await powerActor(c), c.capability, input);
            if (r.ok) rec = r.data;
          }
        }
        rec ??= await env.insert(a);
        for (let i = 0; i < 4; i++) {
          const options = cmds.filter((c) => c.cmd.from !== 'new' && (c.cmd.from as string[]).includes(rec!.status));
          if (options.length === 0) break;
          const c = options[Math.floor(Math.random() * options.length)];
          const input = await sampleInput(c, rec);
          if (!input) continue;
          const r = await env.callAs(await powerActor(c), c.capability, input);
          steps++;
          const [row] = await env.query(`select * from "${a.table.schema}"."${a.table.name}" where id = $1`, [rec.id]);
          const snap = rowToSnapshot(a, row);
          for (const n of names) {
            let ok = false;
            try {
              ok = !!a.invariants[n](snap as any);
            } catch {
              ok = false;
            }
            if (!ok) violations.push(`${c.capability} 之后 ${aggName}.${n} 不成立`);
          }
          if (r.ok) rec = { ...rec, ...snap };
        }
      }
      return { steps, violations };
    },
  };
}
