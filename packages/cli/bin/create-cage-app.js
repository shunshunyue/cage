#!/usr/bin/env node
/**
 * create-cage-app 的薄包装器，为同一 CLI main 前置 create 子命令。
 * 透传用户参数并设置返回退出码，异常打印 message 后标记失败。
 * 不复制第二套脚手架实现，模板选择、写盘和取消行为由 main/create 模块统一负责。
 */
import { main } from '../dist/main.js';
main(['create', ...process.argv.slice(2)]).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
