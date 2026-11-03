// @yss123/cage-testkit：handler 单测工具、集成测试环境、派生测试运行时。
export { fakeRepo, draftOf, sampleValue, sampleRecord, arbitraryOf, arbitrarySnapshot, handlerCtx } from './fakes.js';
export { createTestEnv, type TestEnv, type TestUser, type CallResult } from './env.js';
export { startEmbeddedPostgres, withDb, freePort, type PgInstance } from './pg.js';
export { setSessionVarsSql } from './session.js';
export { derived, SKIP, DerivedTestError, type Derived, type Skip, type DerivedOptions, type DerivedFixtureContext, type DerivedCommandTrace, type DerivedRunTrace, type DerivedInvariantResult } from './derived.js';
