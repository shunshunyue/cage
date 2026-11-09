/**
 * 测试工具包的公共入口：纯 handler 假依赖、真实 PostgreSQL 集成环境及声明派生测试。
 * 业务测试按需要选择层次；fake 工具不证明数据库权限，集成工具使用独立可丢弃数据库。
 * 本入口只重导出，不启动 PostgreSQL；生命周期由 createTestEnv 或 Vitest globalSetup 的调用方管理。
 */
// @yss123/cage-testkit：handler 单测工具、集成测试环境、派生测试运行时。
export { fakeRepo, draftOf, sampleValue, sampleRecord, arbitraryOf, arbitrarySnapshot, handlerCtx } from './fakes.js';
export { createTestEnv, type TestEnv, type TestUser, type CallResult } from './env.js';
export { startEmbeddedPostgres, withDb, freePort, type PgInstance } from './pg.js';
export { setSessionVarsSql } from './session.js';
export { derived, SKIP, DerivedTestError, type Derived, type Skip, type DerivedOptions, type DerivedFixtureContext, type DerivedCommandTrace, type DerivedRunTrace, type DerivedInvariantResult } from './derived.js';
