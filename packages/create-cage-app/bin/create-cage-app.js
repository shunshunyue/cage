#!/usr/bin/env node
// pnpm create @yss123/cage-app 与 cage create 共用实现，模板升级只需维护一处。
import { main } from '@yss123/cage-cli';
main(['create', ...process.argv.slice(2)]).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
