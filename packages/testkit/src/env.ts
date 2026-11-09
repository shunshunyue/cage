/**
 * 为真实 PostgreSQL 回归准备独立临时数据库、组织根节点、内核与手动驱动 worker。
 * 默认按当前声明建表，也可传入迁移文件；测试用户与角色通过领域命令创建，insert 是仅供夹具的直接写入捷径。
 * 该环境需要独立测试集群权限，会创建角色和数据库，close 会关闭连接并尝试删除本次临时库，不能连接生产集群。
 */
// 集成测试环境：每个测试文件一个临时库，执行初始化脚本、建表、重建安全层，返回内核和一组测试工具。
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AnyAggregate, type Ctx, DEFAULT_TENANT, type Kernel, createKernel, isCageError, silentLogger, systemCtx,
  toCageError, type Logger,
} from '@yss123/cage-kernel';
import { bootstrapSql, createTableSql, fieldsToColumns, runMigrations, schemaModel, type MigrationFile } from '@yss123/cage-kernel/db';
import { createWorker } from '@yss123/cage-kernel/worker';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { sampleRecord } from './fakes.js';
import { startEmbeddedPostgres, withDb, type PgInstance } from './pg.js';
import { setSessionVarsSql } from './session.js';

/**
 * 测试命令执行结果：ok=true 时包含快照，ok=false 时保留标准 code 与可选 domainCode/detail。
 * 未识别的 INTERNAL 异常仍会抛出，以免测试把实现故障当成预期业务拒绝。
 */
export type CallResult =
  | { ok: true; data: Record<string, any>; code?: undefined }
  | { ok: false; code: string; domainCode?: string; detail?: unknown; data?: undefined };

/**
 * 通过组织命令创建的测试身份，保存用户/角色 ID 及 username。
 * ctx 每次重新读取授权上下文，便于测试授权变化，不固定缓存创建时的能力集合。
 */
export interface TestUser {
  id: string;
  username: string;
  roleId: string;
  ctx(): Promise<Ctx>;
}

/**
 * 单个临时业务数据库的测试操作集合。kernel 用于真实流水线，system 是测试系统身份。
 * urls 含测试连接信息，仅供测试装配，不应输出到报告；query/audit 为受信任测试诊断捷径。
 * insert/seedFor 绕过业务命令准备夹具，业务成功路径仍须通过 callAs 验证。
 */
export interface TestEnv {
  kernel: Kernel;
  tenantId: string;
  rootDeptId: string;
  urls: { super: string; app: string; read: string; migrate: string };
  /** 拥有全部能力的系统身份 */
  system(): Ctx;
  /** 以某个身份调用命令；永远不抛异常，返回 { ok, code } */
  callAs(ctx: Ctx, capability: string, input: unknown): Promise<CallResult>;
  /** 建一个部门 */
  dept(name: string, parentId?: string): Promise<string>;
  /** 建一个带角色的用户：caps 为能力点列表（或 'all'），scopes 为各聚合的组合子 */
  user(opts: {
    caps: string[] | 'all';
    scopes?: Record<string, string | { combinator: string; deptIds?: string[] }>;
    deptId?: string;
    params?: Record<string, Record<string, unknown>>;
    username?: string;
  }): Promise<TestUser>;
  /** 有其他所有能力、唯独缺某个能力点的用户（范围为全部） */
  actorWithout(capability: string): Promise<Ctx>;
  /** 直接写入一条处在某状态的数据（测试捷径，绕过命令；只能在测试里用） */
  insert(agg: AnyAggregate | string, values?: Record<string, unknown> & { id?: string; status?: string; ownerId?: string; deptId?: string }): Promise<Record<string, any>>;
  /** 造一条处在某命令合法起始状态的数据 */
  seedFor(capability: string, values?: Record<string, unknown> & { ownerId?: string }): Promise<Record<string, any>>;
  /** 以某人身份拿读侧连接（会话变量已设置），可以直接写裸 SQL */
  readConnectionAs(ctx: Ctx): Promise<Kysely<any> & { release(): Promise<void> }>;
  /** 处理当前可领取 outbox；返回处理数量，未来重试/死信或轮数上限不表示业务全部完成。 */
  drain(): Promise<number>;
  /** 审计记录（超级用户读取） */
  audit(where?: { aggregateId?: string; command?: string; kind?: string }): Promise<any[]>;
  query(text: string, params?: unknown[]): Promise<any[]>;
  close(): Promise<void>;
}

let ownPg: PgInstance | null = null;
/**
 * 优先复用 globalSetup 提供的测试管理员连接，再读取显式测试连接，否则启动内嵌 PostgreSQL。
 * 返回的管理员连接仅用于建测试库和准备角色；缓存实例避免同进程反复启动。
 */
async function superUrl(): Promise<string> {
  if (process.env.CAGE_TEST_SUPER_URL) return process.env.CAGE_TEST_SUPER_URL;
  if (process.env.CAGE_TEST_DATABASE_URL) return process.env.CAGE_TEST_DATABASE_URL;
  ownPg ??= await startEmbeddedPostgres();
  process.env.CAGE_TEST_SUPER_URL = ownPg.superUrl;
  return ownPg.superUrl;
}

/**
 * 创建随机命名的测试库并返回可执行测试的环境，调用方必须在 teardown 中 close。
 * 先在共同管理库取得角色初始化锁，避免不同测试库并发修改同一集群角色；随后按迁移或声明建结构。
 * domain 必须包含组织模型，否则无法准备用户与部门并报错；logger 默认静默，可注入用于诊断回归。
 * 默认新库测试不等于带旧数据的升级验收，未传 migrations 时也不验证应用迁移文件。
 */
export async function createTestEnv(opts: {
  domain: object | object[];
  /** 不传时直接按声明建表（不经过迁移文件） */
  migrations?: MigrationFile[];
  logger?: Logger;
}): Promise<TestEnv> {
  const su = await superUrl();
  const dbName = `cage_t_${randomBytes(5).toString('hex')}`;
  const pw = { app: 'cage_app_pw', read: 'cage_read_pw', migrate: 'cage_migrate_pw' };
  const superDb = withDb(su, dbName);
  const admin = new pg.Client({ connectionString: su });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
    // 角色属于集群；多个测试文件即使使用不同临时库，也会同时修改同一批角色。
    // 咨询锁必须在共同的管理库上取得，在各自临时库上加锁无法互斥。
    // 只串行化初始化阶段，后续业务测试仍并行；关闭 admin 连接自动释放会话锁。
    await admin.query("select pg_advisory_lock(hashtext('cage:testkit:cluster-roles'))");
    const boot = new pg.Client({ connectionString: superDb });
    await boot.connect();
    try {
      await boot.query(bootstrapSql(pw, dbName));
    } finally {
      await boot.end();
    }
  } finally {
    await admin.end();
  }

  const urls = {
    super: superDb,
    app: withDb(su, dbName, { name: 'cage_app', password: pw.app }),
    read: withDb(su, dbName, { name: 'cage_read', password: pw.read }),
    migrate: withDb(su, dbName, { name: 'cage_migrate', password: pw.migrate }),
  };
  const kernel = createKernel({ domain: opts.domain, urls: { app: urls.app, read: urls.read }, logger: opts.logger ?? silentLogger, poolSize: 5 });
  if (!kernel.registry.command('Dept.create')) {
    throw new Error("[CAGE-ORG-001] domain 没有包含组织模型：在 domain 的 index.ts 里加上 export * from '@yss123/cage-admin/domain'");
  }
  const model = schemaModel(kernel.registry);
  const migrations = opts.migrations ?? [{ name: '0001_test_schema', sql: model.tables.map(createTableSql).join('\n\n') }];
  await runMigrations({ migrateUrl: urls.migrate, registry: kernel.registry, migrations });

  const tenantId = DEFAULT_TENANT;
  const sys = () => systemCtx({ kind: 'system', name: 'test', tenantId, capabilities: kernel.catalogCaps() });
  const root = await kernel.execute('Dept.create', { name: '总部', code: 'root' }, sys());
  const superPool = new pg.Pool({ connectionString: superDb, max: 2 });
  const worker = createWorker(kernel, { jobs: false } as any);
  const readers: pg.Pool[] = [];

  const callAs = async (ctx: Ctx, capability: string, input: unknown): Promise<CallResult> => {
    try {
      return { ok: true, data: await kernel.execute(capability, input, ctx) };
    } catch (e) {
      const ce = toCageError(e);
      if (!isCageError(e) && ce.code === 'INTERNAL') throw e;
      return { ok: false, code: ce.code, domainCode: ce.domainCode, detail: ce.detail };
    }
  };

  const env: TestEnv = {
    kernel,
    tenantId,
    rootDeptId: root.id,
    urls,
    system: sys,
    callAs,
    /**
     * 通过 Dept.create 建立测试部门，省略父级时挂到本环境根部门。
     * 返回真实持久化 ID；命令失败直接传播，不伪造可用部门。
     */
    async dept(name, parentId) {
      const d = await kernel.execute('Dept.create', { name, parentId: parentId ?? root.id }, sys());
      return d.id;
    },
    /**
     * 先创建独立角色，再逐个授能力与范围，最后创建用户并分配该角色。
     * caps=all 取当前内核目录；params 给特定能力提供额度等参数，scopes 保留组合子语义。
     * 返回的 ctx 会重新解析身份，账号没有自动设置登录密码，HTTP 测试需单独设置。
     */
    async user(o) {
      const s = sys();
      const role = await kernel.execute('Role.create', { code: `r_${randomBytes(4).toString('hex')}`, name: 'test role' }, s);
      const caps = o.caps === 'all' ? kernel.catalogCaps() : o.caps;
      for (const c of caps) await kernel.execute('Role.grantCapability', { id: role.id, capability: c, params: o.params?.[c] }, s);
      for (const [agg, sc] of Object.entries(o.scopes ?? {})) {
        const g = typeof sc === 'string' ? { combinator: sc } : sc;
        await kernel.execute('Role.setScope', { id: role.id, aggregate: agg, ...g }, s);
      }
      const username = o.username ?? `u_${randomBytes(4).toString('hex')}`;
      const u = await kernel.execute('User.create', { username, name: username, deptId: o.deptId ?? root.id }, s);
      await kernel.execute('User.assignRoles', { id: u.id, roleIds: [role.id] }, s);
      return {
        id: u.id,
        username,
        roleId: role.id,
        ctx: async () => (await kernel.contextFor(u.id, tenantId, { requestId: randomUUID() }))!,
      };
    },
    /**
     * 创建拥有其他全部能力且范围为 all 的身份，用于把拒绝原因定位到缺少目标能力。
     */
    async actorWithout(capability) {
      const u = await env.user({ caps: kernel.catalogCaps().filter((c) => c !== capability), scopes: { '*': 'all' } });
      return u.ctx();
    },
    /**
     * 直接构造测试记录并补必要引用，主表与集合关联在同一事务写入。
     * values 覆盖样例字段，可指定状态/归属；这条捷径跳过 handler、业务硬约束和命令审计，不能当业务写入范例。
     */
    async insert(aggRef, values = {}) {
      const agg = typeof aggRef === 'string' ? kernel.registry.aggregate(aggRef)! : aggRef;
      const { status, ownerId, id: givenId, ...fields } = values as Record<string, any>;
      const rec = sampleRecord(agg, fields);
      if (agg.scope.ownerField) rec[agg.scope.ownerField] = ownerId ?? fields[agg.scope.ownerField] ?? (await env.user({ caps: [] })).id;
      if (agg.scope.deptField && agg.scope.deptField !== 'id' && fields[agg.scope.deptField] === undefined) rec[agg.scope.deptField] = root.id;
      // 引用字段：指向真实存在的记录（外键）
      for (const [k, f] of Object.entries(agg.fields as Record<string, any>)) {
        if (f.kind !== 'ref' || fields[k] !== undefined || k === agg.scope.ownerField || (k === agg.scope.deptField && rec[k])) continue;
        if (f.isOptional) { rec[k] = null; continue; }
        rec[k] = f.ref === 'Dept' ? root.id : f.ref === 'User' ? (await env.user({ caps: [] })).id : (await env.insert(f.ref)).id;
      }
      const row = {
        id: givenId ?? randomUUID(), tenant_id: tenantId, ...fieldsToColumns(agg, rec), status: status ?? agg.states.initial, version: 1,
      };
      // 种子绕过命令，但仍按真实物理结构在同一事务插入主记录和关联，外键约束照常生效。
      await kernel.app.transaction().execute(async (tx) => {
        await tx.insertInto(`${agg.table.schema}.${agg.table.name}`).values(row).execute();
        for (const table of model.tables.filter((t) => t.aggregate === agg.name && t.relation)) {
          const ids = [...new Set(rec[table.relation!.field] as string[])];
          if (ids.length) await tx.insertInto(`${table.schema}.${table.name}`)
            .values(ids.map((id) => ({ tenant_id: tenantId, source_id: row.id, target_id: id }))).execute();
        }
      });
      return { ...rec, id: row.id, status: row.status, version: 1 };
    },
    /**
     * 按已有记录命令的第一个合法起始状态建立夹具，调用者可覆盖字段。
     * 新建命令不需要种子，传入会报错；只保证选用声明状态，不保证满足任意业务不变量。
     */
    async seedFor(capability, values = {}) {
      const rc = kernel.registry.command(capability);
      if (!rc) throw new Error(`没有命令 ${capability}`);
      if (rc.cmd.from === 'new') throw new Error(`${capability} 是新建命令，不需要种子数据`);
      return env.insert(rc.cmd.agg, { status: (rc.cmd.from as string[])[0], ...values });
    },
    /**
     * 创建单连接的只读池，设置会话级范围与掩码变量后返回 Kysely 连接。
     * 用于验证直接读取安全视图也受限制；调用者应 release，环境 close 另作最终清理。
     */
    async readConnectionAs(ctx) {
      const pool = new pg.Pool({ connectionString: urls.read, max: 1, idleTimeoutMillis: 0 });
      readers.push(pool);
      const c = await pool.connect();
      await c.query(setSessionVarsSql(ctx));
      c.release();
      const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) }) as Kysely<any> & { release(): Promise<void> };
      db.release = async () => {
        await db.destroy();
      };
      return db;
    },
    drain: () => worker.drain(),
    /**
     * 以测试管理员查询审计记录，可按对象 ID、命令与类别过滤，按 ID 返回。
     * 这是断言审计行为的测试通道，不代表业务角色能绕过安全视图读取审计。
     */
    async audit(where = {}) {
      const cond: string[] = [];
      const params: unknown[] = [];
      if (where.aggregateId) cond.push(`aggregate_id = $${params.push(where.aggregateId)}`);
      if (where.command) cond.push(`command = $${params.push(where.command)}`);
      if (where.kind) cond.push(`kind = $${params.push(where.kind)}`);
      const r = await superPool.query(`select * from sys.audit_log ${cond.length ? 'where ' + cond.join(' and ') : ''} order by id`, params);
      return r.rows;
    },
    /**
     * 使用本测试库管理员执行参数化 SQL 并返回行，用于夹具检查与故障注入。
     * 只能在测试中使用，调用者负责 SQL 意图与参数，不经过领域命令和业务范围。
     */
    async query(text, params = []) {
      return (await superPool.query(text, params)).rows;
    },
    /**
     * 关闭内核、读池与管理员池，再尝试强制删除本次随机命名的临时数据库。
     * 不停止调用方提供的集群；个别清理失败按当前实现被忽略，连接异常仍可能传播。
     */
    async close() {
      await kernel.close();
      for (const p of readers) await p.end().catch(() => {});
      await superPool.end();
      const c = new pg.Client({ connectionString: su });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await c.end();
    },
  };
  void sql;
  return env;
}
