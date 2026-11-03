import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, projectManifests } from './upgrade.js';

/** 两种模板共用框架基础能力，只让用户选择是否带业务演示。目录名与命令参数分开，
 * 保留已有 templates/app 作为采购模板，避免改写它已分发的迁移历史。 */
export const appTemplates = {
  blank: { directory: 'blank', label: '空白业务项目', hint: '保留登录、权限和系统管理，从自己的业务开始' },
  purchase: { directory: 'app', label: '采购示例项目', hint: '包含采购单、库存、审批和 fake ERP 完整链路' },
} as const;
export type AppTemplate = keyof typeof appTemplates;

export function isAppTemplate(value: string): value is AppTemplate {
  return Object.hasOwn(appTemplates, value);
}

/** 创建本身不负责交互，供 CLI、自动化和测试复用。第三个参数保留原有本地框架路径调用方式。 */
export function createApp(target: string, frameworkPath?: string, template: AppTemplate = 'blank'): string {
  if (!isAppTemplate(template)) throw new Error('[CAGE-CREATE-001] --template 只能是 blank 或 purchase');
  const root = resolve(target);
  if (existsSync(root)) throw new Error('[CAGE-CREATE-001] 目标路径已存在，请选择新目录');
  const here = dirname(fileURLToPath(import.meta.url));
  const directory = appTemplates[template].directory;
  const source = [
    resolve(here, '../templates', directory),
    resolve(here, '../../../templates', directory),
  ].find(existsSync);
  if (!source) throw new Error(`[CAGE-CREATE-001] CLI 发布包缺少 ${template} 模板`);
  cpSync(source, root, {
    recursive: true,
    filter: (p) => {
      // 安装后的模板本身就在 node_modules 中，只排除模板内部的运行目录。
      // 若检查绝对路径，npm 安装场景下连模板根目录都会被过滤，产生空项目。
      const local = relative(source, p);
      return (
        !/(^|[\\/])(node_modules|dist|\.cage|generated)([\\/]|$)/.test(local) &&
        (!/^\.env(?:\..+)?$/.test(basename(p)) || basename(p) === '.env.example')
      );
    },
  });
  // npm 不分发 .gitignore，因此模板保存为 _gitignore。创建后恢复文件名，
  // 使源码创建和 npm 创建都能忽略 .env、依赖和运行缓存。
  renameSync(join(root, '_gitignore'), join(root, '.gitignore'));
  // 模板本身包含所有学习资料。这里不另找框架仓库补文档，
  // 确保本地试用与从 npm 安装得到的是同一份完整业务项目。
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
