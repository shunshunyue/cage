// 对外公开可组合的工具链；bin/cage.js 是这些函数的命令行封装。
export * from './analyze.js';
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
export * from './verify.js';
export * from './database.js';
export { serveGraph, collectGraph } from './graph.js';
export { main } from './main.js';
