import { readFileSync } from 'node:fs';

/** 源码和 dist 都紧邻包清单，直接读取已安装 CLI 的版本。
 * 脚手架、upgrade 和 AGENTS 托管区共用它，避免升级只改了包版本却仍生成旧依赖。
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
