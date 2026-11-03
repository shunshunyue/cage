// pnpm test:docker 已启动隔离的测试容器，并用 Node --env-file 注入它的连接串。
// 以当前 pnpm 的 JS 入口启动，Windows 上也不需要 shell 拼接或在命令行暴露密码。
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.env.npm_execpath!, 'test'], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});
process.exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
