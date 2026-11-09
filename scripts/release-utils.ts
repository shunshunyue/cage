/**
 * 发布维护脚本共享的仓库定位、包清单读取、依赖排序和 pnpm 子进程调用。
 * 模块加载时仅扫描 packages 下的非 private 包并拓扑排序；读取 CLI 版本作为统一版本基线。
 * 执行 pnpm 的辅助函数复用当前包管理器入口，以参数数组启动进程，不拼接 shell，也不自动发布包。
 */
// 发布脚本只处理 packages/*，不把范例或模板工作区当作 npm 包发布。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** 发布脚本实际使用的清单字段；业务模板与框架包共享依赖表示。 */
/**
 * 包 exports/bin 的递归路径形状，支持字符串入口与条件导出对象，供打包检查递归展开。
 */
export type ExportTarget = string | { [condition: string]: ExportTarget };
/**
 * 维护脚本实际读取/修改的 package.json 字段集合。
 * 依赖分组用于校验与版本替换，pnpm.overrides 仅在仓库外压缩包验收中绑定临时本地包；不代表完整 npm schema。
 */
export interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  repository?: { url: string };
  publishConfig?: { access: string };
  exports?: ExportTarget;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pnpm?: { overrides: Record<string, string> };
}

/**
 * 根据脚本所在位置定位仓库根目录，不受调用终端 cwd 影响。
 */
export const root = fileURLToPath(new URL('../', import.meta.url));
/**
 * 读取指定 JSON 文件并解析，文件不存在或格式错误直接失败；泛型只提供静态类型，不运行 schema 校验。
 */
export const readJson = <T = PackageManifest>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
/**
 * 扫描 packages 的非私有包，保留目录、清单路径与内容，随后原地按内部运行/peer 依赖排序。
 * 循环依赖会在模块加载时失败，不把范例、业务模板或 private 工作区作为发布包。
 */
export const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join(root, 'packages', entry.name);
    return {
      directory: entry.name,
      dir,
      manifest: join(dir, 'package.json'),
      pkg: readJson(join(dir, 'package.json')),
    };
  })
  .filter((entry) => !entry.pkg.private);
/**
 * 以 CLI 清单版本作为本次发布检查的统一版本，其他包是否一致由发布流程核对。
 */
export const version = packages.find((entry) => entry.directory === 'cli')!.pkg.version;

// 发布时先基础包、后依赖它们的包；创建工具最后可用，避免先暴露无法安装的入口。
const remaining = new Set(packages);
const ordered: typeof packages = [];
while (remaining.size) {
  const ready = [...remaining].filter(
    (entry) =>
      ![...remaining].some(
        (other) =>
          other !== entry &&
          Object.keys({ ...entry.pkg.dependencies, ...entry.pkg.peerDependencies }).includes(other.pkg.name),
      ),
  );
  if (!ready.length) throw new Error('发布包存在循环依赖，请先理清运行时依赖');
  for (const entry of ready) {
    ordered.push(entry);
    remaining.delete(entry);
  }
}
packages.splice(0, packages.length, ...ordered);

/** pnpm run 提供实际执行路径。直接传参数，避免 Windows 的 .cmd 和 shell 转义差异。 */
/**
 * 在指定 cwd 同步执行当前 pnpm，返回标准输出；非零退出或超出输出预算由 execFileSync 抛错。
 * 必须经 pnpm 脚本调用以取得 npm_execpath；Windows 隐藏子进程窗口，避免 .cmd 和 shell 引号差异。
 */
export function pnpm(args: string[], cwd = root): string {
  const executable = process.env.npm_execpath;
  if (!executable) throw new Error('请通过 pnpm release:pack / pnpm release:version 执行发布脚本');
  const native = /\.exe$/i.test(executable);
  return execFileSync(native ? executable : process.execPath, native ? args : [executable, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}
