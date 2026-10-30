import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, projectManifests } from './upgrade.js';

export function createApp(target: string, frameworkPath?: string): string {
  const root = resolve(target);
  if (existsSync(root)) throw new Error('[CAGE-CREATE-001] 目标路径已存在，请选择新目录');
  const here = dirname(fileURLToPath(import.meta.url));
  const template = [resolve(here, '../templates/app'), resolve(here, '../../../templates/app')].find(
    existsSync,
  );
  if (!template) throw new Error('[CAGE-CREATE-001] CLI 发布包缺少模板');
  cpSync(template, root, {
    recursive: true,
    filter: (p) => {
      // 安装后的模板本身就在 node_modules 中，只排除模板内部的运行目录。
      // 若检查绝对路径，npm 安装场景下连模板根目录都会被过滤，产生空项目。
      const local = relative(template, p);
      return !/(^|[\\/])(node_modules|dist|\.cage|generated)([\\/]|$)/.test(local) &&
        (!/^\.env(?:\..+)?$/.test(basename(p)) || basename(p) === '.env.example');
    },
  });
  // 报错链接在新项目中也能直接打开，不要求用户另行克隆框架文档。
  const errors = [resolve(here, '../managed/errors'), resolve(here, '../../../docs/errors')].find(existsSync);
  if (errors) cpSync(errors, join(root, 'docs/errors'), { recursive: true });
  for (const path of projectManifests(root)) {
    const p = JSON.parse(readFileSync(path, 'utf8'));
    // 发布后使用统一版本号；源码试用用 link 指向已构建的本地框架，不要求先发 npm。
    for (const group of ['dependencies', 'devDependencies'])
      for (const name of Object.keys(p[group] ?? {}))
        if (name.startsWith('@yss123/cage-')) {
          p[group][name] = frameworkPath
            ? `link:${resolve(frameworkPath, 'packages', name.slice('@yss123/cage-'.length)).replace(/\\/g, '/')}`
            : VERSION;
        }
    if (path === join(root, 'package.json'))
      p.name = root
        .split(/[\\/]/)
        .pop()!
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
    writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
  }
  return root;
}
