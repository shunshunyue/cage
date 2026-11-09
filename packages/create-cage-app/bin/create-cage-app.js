#!/usr/bin/env node
/**
 * npm 创建工具的薄入口，转交 Cage CLI 的统一脚手架实现。
 * 这里不维护第二套模板或创建规则；版本、交互和目录校验以依赖 CLI 为准。
 * 保留首行 shebang 以支持包管理器直接执行。
 */
// pnpm create @yss123/cage-app 与 cage create 共用实现，模板升级只需维护一处。
import { main } from '@yss123/cage-cli';
main(['create', ...process.argv.slice(2)]).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
