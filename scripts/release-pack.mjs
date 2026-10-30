// 实际生成 tarball，再检查 tarball 里的内容。源码目录检查无法发现漏打 dist、
// workspace 依赖未转换、模板混入 .env 等分发问题，因此以最终压缩包为准。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { packages, pnpm, root, version } from './release-utils.mjs';

const output = join(root, '.cage', 'releases', version);
mkdirSync(output, { recursive: true });
const names = new Set(packages.map((entry) => entry.pkg.name));
const results = [];
const targets = (value) => typeof value === 'string' ? [value]
  : Object.values(value ?? {}).flatMap(targets);

for (const entry of packages) {
  const { pkg, dir } = entry;
  assert.equal(pkg.version, version, `${pkg.name} 的版本未统一`);
  assert.equal(pkg.license, 'MIT', `${pkg.name} 缺少已选定的 MIT 许可证`);
  assert.equal(pkg.publishConfig?.access, 'public', `${pkg.name} 未声明公开发布`);
  assert.equal(pkg.repository?.url, 'git+https://github.com/shunshunyue/cage.git');
  // npm 会自动携带包目录中的 LICENSE；每次取根文件，避免许可证副本发生分歧。
  copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
  pnpm(['pack', '--json', '--pack-destination', output], dir);
  const archive = join(output, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const files = new Set(entries.filter((name) => !name.endsWith('/')).map((name) => name.replace(/^package\//, '')));
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', windowsHide: true }));

  for (const path of ['README.md', 'LICENSE', ...targets(pkg.exports), ...targets(pkg.bin)]) {
    assert(files.has(path.replace(/^\.\//, '')), `${pkg.name} 的包中缺少 ${path}`);
  }
  for (const path of files) {
    assert(!/(^|\/)(node_modules|\.cage|\.git|\.turbo|\.pgdata)(\/|$)/.test(path), `${pkg.name} 混入运行目录：${path}`);
    assert(!/(^|\/)\.env(?:$|\.(?!example$))|\.log$|\.tgz$/.test(path), `${pkg.name} 混入本地文件：${path}`);
  }
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      assert(!/^(workspace:|link:|file:)/.test(range), `${pkg.name} 存在无法从 npm 安装的依赖 ${name}: ${range}`);
      if (names.has(name)) assert.equal(range, version, `${pkg.name} 的内部依赖 ${name} 版本未统一`);
    }
  }
  if (entry.directory === 'cli') {
    for (const path of ['graph-ui/index.html', 'templates/app/package.json', 'templates/app/db/migrations/0001_init.sql', 'managed/errors/README.md']) {
      assert(files.has(path), `CLI 缺少分发资源 ${path}`);
    }
    const template = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/templates/app/package.json'], { encoding: 'utf8', windowsHide: true }));
    for (const [name, range] of Object.entries(template.devDependencies)) {
      if (names.has(name)) assert.equal(range, version, `模板的 ${name} 仍引用旧版本`);
    }
  }
  const digest = createHash('sha512').update(readFileSync(archive)).digest('base64');
  results.push({ name: pkg.name, version, file: archive, files: files.size, integrity: `sha512-${digest}` });
  console.log(`✓ ${pkg.name}@${version}：${files.size} 个文件，入口、依赖和分发资源通过`);
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ version, packages: results }, null, 2) + '\n');
console.log(`发布包与清单：${output}（仅打包，未上传 npm）`);
