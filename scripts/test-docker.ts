/**
 * 衔接 package.json 中已启动的独立 Docker 测试环境与框架测试命令。
 * 本脚本只继承已注入的环境并启动当前 pnpm test，不自行创建容器或打印连接凭据。
 * 子进程退出码向父流程传递，未知退出按失败处理，输出直接接到当前终端供查看完整诊断。
 */
// pnpm test:docker 已启动隔离的测试容器，并用 Node --env-file 注入它的连接串。
// 以当前 pnpm 的 JS 入口启动，Windows 上也不需要 shell 拼接或在命令行暴露密码。
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.env.npm_execpath!, 'test'], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});
process.exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
