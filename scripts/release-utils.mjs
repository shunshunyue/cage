// 发布脚本只处理 packages/*，不把范例或模板工作区当作 npm 包发布。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join(root, 'packages', entry.name);
    return { directory: entry.name, dir, manifest: join(dir, 'package.json'), pkg: readJson(join(dir, 'package.json')) };
  })
  .filter((entry) => !entry.pkg.private);
export const version = packages.find((entry) => entry.directory === 'cli').pkg.version;

// 发布时先基础包、后依赖它们的包；创建工具最后可用，避免先暴露无法安装的入口。
const remaining = new Set(packages);
const ordered = [];
while (remaining.size) {
  const ready = [...remaining].filter((entry) =>
    ![...remaining].some((other) => other !== entry &&
      Object.keys({ ...entry.pkg.dependencies, ...entry.pkg.peerDependencies }).includes(other.pkg.name)));
  if (!ready.length) throw new Error('发布包存在循环依赖，请先理清运行时依赖');
  for (const entry of ready) { ordered.push(entry); remaining.delete(entry); }
}
packages.splice(0, packages.length, ...ordered);

/** pnpm run 提供实际执行路径。直接传参数，避免 Windows 的 .cmd 和 shell 转义差异。 */
export function pnpm(args, cwd = root) {
  const executable = process.env.npm_execpath;
  if (!executable) throw new Error('请通过 pnpm release:pack / pnpm release:version 执行发布脚本');
  const native = /\.exe$/i.test(executable);
  return execFileSync(native ? executable : process.execPath, native ? args : [executable, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024,
  });
}
