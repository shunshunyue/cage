import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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

export function launch(file: string, args: string[], cwd: string, env = process.env): ChildProcess {
  return spawn(process.execPath, [file, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
}

export async function run(file: string, args: string[], cwd: string, env = process.env): Promise<number> {
  const child = launch(file, args, cwd, env);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** 升级时安装更新后的清单。这里不接收任意 shell 字符串，参数固定为 install。 */
export async function installDependencies(cwd: string): Promise<number> {
  const pnpm = process.env.npm_execpath;
  if (pnpm && /pnpm/i.test(pnpm)) return run(pnpm, ['install'], cwd);
  const child = spawn('pnpm', ['install'], { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
