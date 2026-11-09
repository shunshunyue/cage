/**
 * 维护者显式更新全部可发布框架包的版本号。
 * 先校验命令行版本形状，再仅重写各包清单 version；不执行安装、构建、提交、打标签或 npm 发布。
 * CLI 和模板后续从包清单读取版本，锁文件与分发资源需按输出提示另行同步。
 */
// 所有框架包保持同一版本；CLI 和模板随后从包清单读取版本，不再各自保存常量。
import { writeFileSync } from 'node:fs';
import { packages, version } from './release-utils.ts';

const next = process.argv[2] ?? '';
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) {
  throw new Error('用法：pnpm release:version 0.1.1（也支持 0.1.1-beta.1）');
}
for (const entry of packages) {
  entry.pkg.version = next;
  writeFileSync(entry.manifest, JSON.stringify(entry.pkg, null, 2) + '\n');
}
console.log(`已将 ${packages.length} 个包从 ${version} 统一为 ${next}。`);
console.log('随后运行 pnpm install、pnpm release:prepare，并更新 CHANGELOG.md；不会自动提交、打标签或发布。');
