// 模板与已验证的标准范例共享薄壳。排除依赖、数据库、构建产物和生成缓存。
// 框架包始终通过依赖引用；只有领域声明、启动代码、前端与迁移进入模板。
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// 发布版本取自 CLI 包清单；模板不能继续依赖某个写死的历史版本。
const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const target = join(root, 'templates/app');
mkdirSync(target, { recursive: true });
cpSync(join(root, 'examples/purchase-admin'), target, { recursive: true, filter: (path) =>
  !/(^|[\\/])(node_modules|dist|\.cage|generated|\.turbo)([\\/]|$)/.test(path) &&
  // 本地凭证不可进入模板；只有不含密钥的 .env.example 可以分发。
  (!/^\.env(?:\..+)?$/.test(basename(path)) || basename(path) === '.env.example') });
writeFileSync(join(target, 'pnpm-workspace.yaml'), "packages:\n  - apps/*\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n  - embedded-postgres\n  - '@embedded-postgres/windows-x64'\n  - '@embedded-postgres/linux-x64'\n  - '@embedded-postgres/darwin-arm64'\n  - '@embedded-postgres/darwin-x64'\n");
writeFileSync(join(target, '.gitignore'), 'node_modules/\ndist/\n.cage/\ngenerated/\n.env\n.env.*\n!.env.example\n*.log\n');
cpSync(join(root, 'renovate.json'), join(target, 'renovate.json'));
// 脚手架首次创建会再次按所选版本统一替换；模板本身也不残留 workspace:* 框架版本。
function manifests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) manifests(file);
    else if (entry.name === 'package.json') {
      const p = JSON.parse(readFileSync(file, 'utf8'));
      for (const group of ['dependencies', 'devDependencies']) for (const name of Object.keys(p[group] ?? {})) if (name.startsWith('@yss123/cage-')) p[group][name] = version;
      writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
    }
  }
}
manifests(target);
