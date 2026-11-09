/**
 * CLI 运行 Node 工具与 pnpm 的统一子进程适配，供 dev、verify、upgrade 等使用。
 * 从已安装包解析 bin 路径，使用当前 Node 启动脚本并继承受控工作目录和环境。
 * 标准输入输出继承终端；launch 返回句柄由调用方管理，run 等待退出码，启动失败拒绝 Promise。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 从已安装包解析实际 bin 文件，不依赖全局脚本路径。
 * @param pkg 包名，按 ESM 条件解析后向上核对清单名称。
 * @param bin 多入口包的命令名，省略则选清单首个入口。
 * @returns bin 绝对路径；包或入口不可解析时抛出。
 */
export function binPath(pkg: string, bin?: string): string {
  // 使用 ESM 解析条件，dependency-cruiser 等纯 ESM 包没有 require 入口。
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  while (
    !existsSync(join(dir, 'package.json')) ||
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== pkg
  ) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${pkg} 的命令入口`);
    dir = parent;
  }
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return join(dir, typeof p.bin === 'string' ? p.bin : p.bin[bin ?? Object.keys(p.bin)[0]]);
}

/**
 * 用当前 Node 启动脚本并继承终端输入输出。
 * @param file Node 脚本路径，不是 shell 字符串。
 * @param args 原样传递的参数数组。
 * @param cwd 工作目录。
 * @param env 子进程环境。
 * @returns 立即返回子进程句柄，调用方负责监听错误与清理。
 */
export function launch(file: string, args: string[], cwd: string, env = process.env): ChildProcess {
  return spawn(process.execPath, [file, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
}

/**
 * 启动一次 Node 工具并等待退出，用于串行门禁。
 * @param file 脚本路径。
 * @param args 参数数组。
 * @param cwd 工作目录。
 * @param env 环境对象，默认当前环境。
 * @returns 退出码；无数字码按 1 处理，启动错误拒绝 Promise。
 */
export async function run(file: string, args: string[], cwd: string, env = process.env): Promise<number> {
  const child = launch(file, args, cwd, env);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** 升级时安装更新后的清单。这里不接收任意 shell 字符串，参数固定为 install。 */
/**
 * 执行固定 pnpm install，优先复用 npm_execpath 中的 pnpm。
 * @param cwd 已改清单的应用目录。
 * @returns 安装退出码；会修改依赖和锁文件，失败不回滚，Windows 命令解析使用 shell。
 */
export async function installDependencies(cwd: string): Promise<number> {
  const pnpm = process.env.npm_execpath;
  if (pnpm && /pnpm/i.test(pnpm)) return run(pnpm, ['install'], cwd);
  const child = spawn('pnpm', ['install'], { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
