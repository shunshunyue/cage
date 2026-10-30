// 从真实 tarball 安装到仓库外，检查“开发机 workspace 能用，但发布包不能用”的问题。
// 发布前 npm 还没有这些版本，因此仅在临时验证项目中把内部依赖覆盖为 tarball；
// 脚手架原始产物仍使用正常 npm 版本，不会把本机路径写回模板。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pnpm, readJson, root, version } from './release-utils.mjs';

const release = readJson(join(root, '.cage', 'releases', version, 'manifest.json'));
const directory = mkdtempSync(join(tmpdir(), `cage-package-${version}-`));
const overrides = Object.fromEntries(release.packages.map((pkg) => [pkg.name, `file:${pkg.file.replaceAll('\\', '/')}`]));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'cage-package-smoke', private: true, type: 'module',
  dependencies: overrides, pnpm: { overrides },
}, null, 2));
const workspace = "packages: []\nonlyBuiltDependencies:\n  - esbuild\n  - embedded-postgres\n  - '@embedded-postgres/windows-x64'\n  - '@embedded-postgres/linux-x64'\n  - '@embedded-postgres/darwin-arm64'\n  - '@embedded-postgres/darwin-x64'\n";
writeFileSync(join(directory, 'pnpm-workspace.yaml'), workspace);
console.log(`压缩包验证目录：${directory}`);
console.log(pnpm(['install', '--reporter=append-only'], directory));
console.log(pnpm(['exec', 'cage', '--version'], directory));
const app = join(directory, 'application');
console.log(pnpm(['exec', 'cage', 'create', app], directory));
const manifest = readJson(join(app, 'package.json'));
manifest.pnpm = { overrides };
// pnpm 自动安装 peer 时可能先查询注册表。首版尚未发布，所以临时项目在根部
// 显式提供全部框架 tarball，让 kernel 等 peer 同样来自待发布产物。
manifest.devDependencies = { ...manifest.devDependencies, ...overrides };
writeFileSync(join(app, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(pnpm(['install', '--reporter=append-only'], app));
console.log(pnpm(['build:app'], app));
console.log(pnpm(['exec', 'cage', 'check'], app));
console.log(pnpm(['exec', 'cage', 'gen', '--check'], app));
console.log(pnpm(['exec', 'cage', 'sync', '--check'], app));
console.log('✓ 仓库外 tarball 安装、项目创建、构建及静态检查通过；没有运行数据库测试。');
console.log(`临时目录保留供查看：${directory}`);
