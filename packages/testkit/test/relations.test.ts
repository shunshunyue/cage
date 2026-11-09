// 使用真实 PostgreSQL 和真实 app/read 账号，验证关系在安全与事务边界中工作。
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type CageServer } from '@yss123/cage-http';
import { buildRegistry, type Ctx } from '@yss123/cage-kernel';
import { createTableSql, diffSchemas, runMigrations, schemaModel } from '@yss123/cage-kernel/db';
import { createTestEnv, derived, type TestEnv, type TestUser } from '../src/index.js';
import * as domain from './fixtures/relations.js';

let env: TestEnv, server: CageServer, alice: TestUser, bob: TestUser, outsider: TestUser;
let dept: string, otherDept: string;
/** 派生测试与手写场景复用同一组完整关系声明，避免派生造数把关系字段误当作不可执行输入。 */
const generatedTests = derived(domain);
/** 准备同部门与范围外用户，HTTP 服务使用相同测试库；拆出 read 账号验证数据库安全视图边界。 */
beforeAll(async () => {
  await generatedTests.setup();
  env = generatedTests.env();
  dept = await env.dept('业务部'); otherDept = await env.dept('其他部门');
  const caps = ['Note.create', 'Note.read', 'Note.setMembers', 'Note.rename', 'Note.move', 'Notebook.read', 'Notebook.create', 'User.read'];
  alice = await env.user({ caps, deptId: dept, scopes: { Note: 'dept', Notebook: 'self', User: 'dept' } });
  bob = await env.user({ caps: [], deptId: dept });
  outsider = await env.user({ caps: [], deptId: otherDept });
  await env.kernel.execute('User.update', { id: bob.id, phone: '13812345678' }, env.system());
  server = createServer({ domain, urls: { app: env.urls.app, read: env.urls.read }, bootstrap: false, logger: false, csrf: false });
  await server.ready();
});
/** 先关 HTTP 的额外连接，再由派生测试拥有者清理环境，避免同一数据库重复销毁。 */
afterAll(async () => { await server?.close(); if (env) await generatedTests.teardown(); });

/** 通过 alice 的真实范围创建便笺；extra 用于切换归属或自关联，默认不预先添加成员。 */
const create = async (members: string[] = [], extra: Record<string, unknown> = {}) =>
  env.kernel.execute('Note.create', { title: '关系便笺', members, ...extra }, await alice.ctx());
/** 仅测试断言通过管理连接观察真实中间表，稳定排序使集合断言不依赖 PostgreSQL 返回顺序。 */
const ids = async (id: string) => (await env.query('select target_id from core.note__members where source_id = $1 order by target_id', [id])).map((r) => r.target_id);

/** 验证索引/同租户外键、完整替换、旧关系保留和回滚；SQL 故障造数仅用于攻击边界或构造反例。 */
describe('关系存储与写入', () => {
  it('真实中间表使用组合主键和同租户外键，主表没有虚拟列；ref.unique 保证至多一对一', async () => {
    const note = await create([bob.id]);
    const columns = await env.query("select column_name from information_schema.columns where table_schema='core' and table_name='note'");
    expect(columns.map((r) => r.column_name)).not.toContain('members');
    await expect(env.query('insert into core.note__members values ($1, $2, $3)', [env.tenantId, note.id, bob.id])).rejects.toMatchObject({ code: '23505' });
    await expect(env.query('insert into core.note__members values ($1, $2, $3)', [randomUUID(), note.id, bob.id])).rejects.toMatchObject({ code: '23503' });
    await env.query('update core.note set reviewer_id=$1 where id=$2', [bob.id, note.id]);
    const another = await create();
    await expect(env.query('update core.note set reviewer_id=$1 where id=$2', [bob.id, another.id])).rejects.toMatchObject({ code: '23505' });
  });

  it('创建、去重、替换、清空都是命令写入，普通响应不泄漏内部 ID 数组，幂等和版本同时生效', async () => {
    const ctx = await alice.ctx();
    const note = await create([bob.id, bob.id]);
    expect(note).not.toHaveProperty('members');
    expect(await ids(note.id)).toEqual([bob.id]);
    const replayCtx = { ...ctx, idempotencyKey: randomUUID() };
    const input = { id: note.id, expectedVersion: 1, members: [alice.id] };
    const first = await env.kernel.execute('Note.setMembers', input, replayCtx);
    expect(await env.kernel.execute('Note.setMembers', input, replayCtx)).toEqual(first);
    expect(first.version).toBe(2);
    expect(await ids(note.id)).toEqual([alice.id]);
    expect((await env.callAs(ctx, 'Note.setMembers', { ...input, members: [] })).code).toBe('CONFLICT');
    await env.kernel.execute('Note.setMembers', { id: note.id, expectedVersion: 2, members: [] }, ctx);
    expect(await ids(note.id)).toEqual([]);
    const audit = await env.audit({ aggregateId: note.id, kind: 'write' });
    expect(audit).toHaveLength(3);
    expect(audit[1].diff.members).toEqual({ from: [bob.id], to: [alice.id] });
    expect(await env.kernel.read.get('Note', note.id, ctx)).not.toHaveProperty('members');
  });

  it('旧成员变为范围外时，无关更新保留原关联；get/find/findOne 读取依赖行为一致', async () => {
    const note = await create([bob.id]);
    await env.kernel.execute('User.update', { id: bob.id, deptId: otherDept }, env.system());
    try {
      await env.kernel.execute('Note.rename', { id: note.id, title: '只改标题' }, await alice.ctx());
      expect(await ids(note.id)).toEqual([bob.id]);
      expect((await env.kernel.read.related('Note', note.id, 'members', {}, await alice.ctx())).total).toBe(0);
    } finally {
      await env.kernel.execute('User.update', { id: bob.id, deptId: dept }, env.system());
    }
    for (const mode of ['get', 'find', 'findOne']) {
      const target = await create();
      await env.kernel.execute('Note.copyMembers', { id: target.id, sourceId: note.id, mode }, env.system());
      expect(await ids(target.id)).toEqual([bob.id]);
    }
  });

  it('新增范围外或跨租户目标返回 404；缺少目标 read 返回 403，主表和关联全部回滚', async () => {
    const note = await create([bob.id]), ctx = await alice.ctx();
    const otherTenant = randomUUID(), foreign = randomUUID();
    await env.query('insert into sys.tenant(id,name) values ($1,$2)', [otherTenant, 'foreign']);
    await env.query('insert into core.note(id,tenant_id,title,dept_id,created_by,status) values ($1,$2,$3,$4,$5,$6)', [foreign, otherTenant, '跨租户', dept, alice.id, 'active']);
    for (const target of [outsider.id, randomUUID()]) {
      expect((await env.callAs(ctx, 'Note.setMembers', { id: note.id, members: [target] })).code).toBe('NOT_FOUND');
    }
    const cross = await env.callAs(ctx, 'Note.create', { title: '跨租户关联', relatedNotes: [foreign] });
    expect(cross.code).toBe('NOT_FOUND');
    expect(await env.query("select id from core.note where title='跨租户关联'")).toEqual([]);
    const limited: Ctx = { ...ctx, capabilities: new Set(['Note.setMembers']) };
    expect((await env.callAs(limited, 'Note.setMembers', { id: note.id, members: [alice.id] })).code).toBe('FORBIDDEN');
    expect(await ids(note.id)).toEqual([bob.id]);
    expect((await env.kernel.read.get('Note', note.id, ctx)).version).toBe(1);
    expect(await env.audit({ aggregateId: note.id, kind: 'write' })).toHaveLength(1);
  });

  it('自关联支持关联自己和同聚合对象，解绑保留目标记录', async () => {
    const note = await create(), target = await create();
    await env.kernel.execute('Note.setRelatedNotes', { id: note.id, relatedNotes: [note.id, target.id] }, env.system());
    expect((await env.kernel.read.related('Note', note.id, 'relatedNotes', {}, await alice.ctx())).total).toBe(2);
    await env.kernel.execute('Note.setRelatedNotes', { id: note.id, relatedNotes: [] }, env.system());
    expect((await env.kernel.read.get('Note', target.id, await alice.ctx())).id).toBe(target.id);
  });

  it('同事务反应失败时，主表版本、关系、审计和 outbox 一起回滚', async () => {
    const note = await create([bob.id]);
    const res = await env.callAs(env.system(), 'Note.failAfterMemberChange', { id: note.id, members: [alice.id] });
    expect(res.domainCode).toBe('CHANGE_REJECTED');
    expect(await ids(note.id)).toEqual([bob.id]);
    expect((await env.kernel.read.get('Note', note.id, env.system())).version).toBe(1);
    expect(await env.audit({ aggregateId: note.id, kind: 'write' })).toHaveLength(1);
    expect(await env.query("select id from sys.outbox where event='MembersChanged' and aggregate_id=$1", [note.id])).toEqual([]);
  });
});

/**
 * hasMany 由子对象外键变化驱动，分页读必须同时检查源与目标范围，并保留目标掩码。
 * 迁移场景额外建临时库执行旧结构→新关系 SQL，再重建安全层；不是只比较生成文本。
 */
describe('关系读取与迁移', () => {
  it('关系命令的派生用例不会误跳过，性质检查使用带关联集合的完整快照', async () => {
    expect(await generatedTests.capabilityDenied('Note.create')).toMatchObject({ code: 'FORBIDDEN' });
    expect(await generatedTests.auditOnce('Note.create')).toEqual({ rows: 1 });
    expect(await generatedTests.idempotent('Note.setMembers')).toEqual({ same: true, rows: 1 });
    expect(await generatedTests.invariantsHold('Note', 1)).toMatchObject({ violations: [] });
  });
  it('hasMany 反查复用子对象外键，改变归属执行子命令，父命令不能写反向集合', async () => {
    const ctx = await alice.ctx();
    const a = await env.kernel.execute('Notebook.create', { title: 'A' }, ctx);
    const b = await env.kernel.execute('Notebook.create', { title: 'B' }, ctx);
    const note = await create([], { notebookId: a.id });
    expect((await env.kernel.read.related('Notebook', a.id, 'notes', {}, ctx)).items.map((r) => r.id)).toEqual([note.id]);
    await env.kernel.execute('Note.move', { id: note.id, notebookId: b.id }, ctx);
    expect((await env.kernel.read.related('Notebook', a.id, 'notes', {}, ctx)).total).toBe(0);
    expect((await env.kernel.read.related('Notebook', b.id, 'notes', {}, ctx)).total).toBe(1);
    expect((await env.callAs(ctx, 'Notebook.create', { title: '非法集合写入', notes: [note.id] })).code).toBe('INVALID_INPUT');
  });

  it('关联分页对两侧执行能力和范围校验，目标字段掩码，裸 SQL 也不能读出范围外链接', async () => {
    const note = await create([alice.id, bob.id]), ctx = await alice.ctx();
    const page = await env.kernel.read.related('Note', note.id, 'members', { pageSize: 1, sort: 'name' }, ctx);
    expect(page.total).toBe(2); expect(page.items).toHaveLength(1);
    const visible = await env.kernel.read.related('Note', note.id, 'members', { id: bob.id }, ctx);
    expect(visible.items[0].phone).toBe('138****5678');
    expect(visible.items[0]).not.toHaveProperty('passwordHash');
    await expect(env.kernel.read.related('Note', note.id, 'members', {}, { ...ctx, capabilities: new Set(['Note.read']) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(env.kernel.read.related('Note', note.id, 'members', {}, { ...ctx, scopes: { Note: [{ combinator: 'deptSet', deptIds: [otherDept] }], User: [{ combinator: 'all' }] } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const read = await env.readConnectionAs({ ...ctx, scopes: { Note: [{ combinator: 'all' }], User: [{ combinator: 'deptSet', deptIds: [otherDept] }] } });
    try {
      expect((await sql`select * from safe.note__members where source_id=${note.id}`.execute(read)).rows).toEqual([]);
      await expect(sql`select * from core.note__members`.execute(read)).rejects.toThrow(/permission denied/);
    } finally { await read.release(); }
    await expect(env.kernel.read.list('Note', { members: bob.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(env.kernel.read.list('Note', { sort: 'members' }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('HTTP 自动注册关系路由，OpenAPI 使用目标分页类型；没有登录返回 401', async () => {
    const note = await create([bob.id]);
    await env.kernel.execute('User.setPassword', { id: alice.id, password: 'relations-test-password' }, env.system());
    const login = await server.app.inject({ method: 'POST', url: '/auth/login', payload: { username: alice.username, password: 'relations-test-password' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const path = `/api/note/${note.id}/relations/members`;
    const res = await server.app.inject({ url: path, headers: { cookie } });
    expect(res.statusCode).toBe(200); expect(res.json().items[0].id).toBe(bob.id);
    expect((await server.app.inject({ url: path })).statusCode).toBe(401);
    const doc = (await server.app.inject({ url: '/api/openapi.json', headers: { cookie } })).json();
    expect(doc.components.schemas.Note.properties).not.toHaveProperty('members');
    expect(doc.paths['/api/note/{id}/relations/members'].get.responses[200].content['application/json'].schema.properties.items.items.$ref).toBe('#/components/schemas/User');
  });

  it('从旧快照新增关系生成可执行迁移，安全层可重建；删除关系声明不会留下视图依赖', async () => {
    const registry = buildRegistry(domain), next = schemaModel(registry);
    const prev = structuredClone(next);
    prev.tables = prev.tables.filter((t) => !t.relation);
    for (const table of prev.tables) table.indexes = table.indexes.filter((i) => !i.unique);
    const delta = diffSchemas(prev, next);
    expect(delta.some((s) => s.includes('UNIQUE INDEX'))).toBe(true);
    expect(delta.some((s) => s.includes('note__members'))).toBe(true);
    // 额外临时库从旧结构升级，验证新增索引先于关系表，而不是只比较 SQL 文本。
    const upgraded = await createTestEnv({ domain, migrations: [
      { name: '0001_without_relations', sql: prev.tables.map(createTableSql).join('\n') },
      { name: '0002_relations', sql: delta.join('\n') },
    ] });
    try {
      await runMigrations({ migrateUrl: upgraded.urls.migrate, registry, migrations: [] });
      const withoutRelations = { ...registry, aggregates: registry.aggregates.map((a) => ({ ...a, fields: Object.fromEntries(Object.entries(a.fields).filter(([, f]: [string, any]) => f.kind !== 'manyToMany')) })) };
      await runMigrations({ migrateUrl: upgraded.urls.migrate, registry: withoutRelations, migrations: [] });
      expect(await upgraded.query("select viewname from pg_views where schemaname='safe' and viewname='note__members'")).toEqual([]);
    } finally { await upgraded.close(); }
  });
});
