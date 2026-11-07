// @yss123/cage-kernel：声明原语、写入流水线、范围组合子、读侧上下文。不含任何业务名词。
export * from './brands.js';
export * from './errors.js';
export * from './types.js';
export { runtimeServices, type RuntimeDefinition, type RuntimeService } from './runtime.js';
export {
  Field, text, int, number, money, id, date, datetime, bool, enumOf, ref, hasMany, manyToMany, isRelation, file, files, isFile, list, json, isField, objectSchema,
  SENSITIVE_KINDS, type SensitiveKind, type FieldKind, type FieldMeta, type FilePolicy, type AnyField, type Fields, type FieldValues, type ValueOf,
} from './primitives/fields.js';
export { states, isStates, DEFAULT_STATES, type StatesDef } from './primitives/states.js';
export { businessProcess, type BusinessProcess, type BusinessStage, type BusinessAction, type BusinessTransition } from './primitives/business-process.js';
export {
  aggregate, isAggregate, hasStates, hiddenFields, sensitiveFields, RESERVED_FIELDS,
  type Aggregate, type AnyAggregate, type Snapshot, type SnapshotOf, type StateOf, type FieldsOf, type FieldValuesOf, type SystemCols,
} from './primitives/aggregate.js';
export {
  command, isCommand, idOnly, empty,
  type Command, type AnyCommand, type Reads, type ReadRepo, type DepsOf, type Draft, type HandlerCtx, type HandlerResult, type Invoker, type FindOptions,
} from './primitives/command.js';
export { event, emit, isEvent, defaultPayload, type Event, type AnyEvent, type PayloadOf, type EmitSpec } from './primitives/event.js';
export { reactionEach, reactionInputs } from './primitives/collection.js';
export {
  sod, ceiling, stepUp, ok, violation, type Constraint, type ConstraintResult, type ConstraintMeta,
} from './primitives/constraints.js';
export {
  reaction, query, approval, job, unsafe, daysAgo,
  type Reaction, type AnyReaction, type Query, type AnyQuery, type Approval, type Job, type JobApi, type JobQueryApi, type TxMode, type UnsafeTag,
} from './primitives/flow.js';
export { scope, compileScope, compileGrant, scopeMatches, grantsFor, DEFAULT_GRANTS, type ScopeSpec } from './scope/index.js';
export { buildRegistry, registryFingerprint, type Registry, type RegisteredCommand, type CatalogEntry, type RegistryOptions, type RuntimeExtension } from './registry.js';
export { Kernel, createKernel, type KernelOptions, type AuditEntry, type BatchResult, type EmittedEvent } from './kernel.js';
export { explainAuthorization, type AuthorizationCheck } from './authorization.js';
export { ReadSide, compileNamedSql, type ListParams, type Page } from './read.js';
export { DataTransfers, importRequestSchema, type TransferTask } from './transfer/index.js';
export { maskValue, present, canUnmask, auditDiff } from './mask.js';
export { mergeCaps, mergeScopes, unmaskFrom, loadUserGrants, userCtx, anonymousCtx, systemCtx, type UserGrants, type RoleGrantRow } from './org.js';
export { step, traceCarrier, withCarrier, consoleLogger, silentLogger, type Logger } from './telemetry.js';
export { snake, kebab, camel, lowerFirst, upperFirst, hash32, stableStringify } from './util/names.js';
export { loadScoped, bindReads, scopedFind, tableRef } from './pipeline/load.js';
export { setSessionVars } from './db/session.js';
export { urlsFromEnv, type DatabaseUrls } from './db/connect.js';
export { DEFAULT_TENANT } from './db/ddl.js';
