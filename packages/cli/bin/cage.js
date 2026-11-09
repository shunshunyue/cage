#!/usr/bin/env node
/**
 * npm cage 可执行包装器，保留 shebang 并调用已构建 main。
 * Promise 完成后设置退出码；异常只打印 message，具体受控诊断由命令模块负责。
 * 不强制 process.exit，让开发服务等句柄按自己的生命周期退出；运行前必须已有 dist。
 */
import { main } from '../dist/main.js';
main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
