/**
 * CLI 包的可组合公共入口，导出分析、查询、生成、诊断、迁移准备及脚手架相关工具。
 * 终端入口通过 main 编排这些实现，测试或其他工具也可直接调用原函数。
 * 本文件只转导出职责，不自动执行 main、不启动服务，也不复制各声明的参数文档。
 */
// 对外公开可组合的工具链；bin/cage.js 是这些函数的命令行封装。
export * from './analyze.js';
export * from './context.js';
export * from './graph-query.js';
export * from './graph-search.js';
export * from './graph-presentation.js';
export * from './config.js';
export * from './ontology.js';
export * from './rules.js';
export * from './findings.js';
export * from './impact.js';
export * from './derive.js';
export * from './gen/index.js';
export * from './sync.js';
export * from './upgrade.js';
export * from './budget.js';
export * from './create.js';
export * from './init.js';
export * from './verify.js';
export * from './doctor.js';
export * from './capabilities.js';
export * from './snapshots.js';
export * from './bootstrap.js';
export * from './runtime-diagnostics.js';
export { serveGraph, collectGraph } from './graph.js';
export { main } from './main.js';
