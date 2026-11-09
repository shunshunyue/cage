/**
 * 从 CLI 包清单读取当前安装版本，供创建、升级、快照及托管说明使用。
 * 模块加载时同步读相邻 package.json，源码和 dist 保持同一相对布局。
 * 这里不查询 npm 或选择最新版本；清单缺失或无效会直接阻止模块加载。
 */
import { readFileSync } from 'node:fs';

/** 源码和 dist 都紧邻包清单，直接读取已安装 CLI 的版本。
 * 脚手架、upgrade 和 AGENTS 托管区共用它，避免升级只改了包版本却仍生成旧依赖。
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
