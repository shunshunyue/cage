/**
 * 脚手架文件复制层，由 create 命令在完成选项收集后调用。
 * 选择 CLI 内置模板，排除运行缓存和真实环境文件，恢复 .gitignore 并改写框架依赖版本或本地链接。
 * 仅创建不存在的目标目录；不安装包、不准备数据库，复制过程中发生 IO 错误会保留已经写入的文件供排查。
 */
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, projectManifests } from './upgrade.js';

/** 两种模板共用框架基础能力，只让用户选择是否带业务演示。目录名与命令参数分开，
 * 保留已有 templates/app 作为采购模板，避免改写它已分发的迁移历史。 */
/**
 * 可分发模板目录与交互标签的固定映射；blank 只有应用基础，purchase 包含采购演示。
 * 目录名与命令参数分离，保留既有模板路径及迁移历史；此映射本身不创建应用。
 */
export const appTemplates = {
  blank: { directory: 'blank', label: '空白业务项目', hint: '保留登录、权限和系统管理，从自己的业务开始' },
  purchase: { directory: 'app', label: '采购示例项目', hint: '包含采购单、库存、审批和 fake ERP 完整链路' },
} as const;
/**
 * 创建命令允许的模板键，只对应 appTemplates 中已打包的两种模板。
 */
export type AppTemplate = keyof typeof appTemplates;

/**
 * 校验外部字符串是否为已知模板键。
 * @param value CLI 参数或交互值。
 * @returns 是否存在固定映射；不访问磁盘，也不验证模板资源完整性。
 */
export function isAppTemplate(value: string): value is AppTemplate {
  return Object.hasOwn(appTemplates, value);
}

/** 创建本身不负责交互，供 CLI、自动化和测试复用。第二个参数是可选本地框架路径，第三个参数选择模板。 */
/**
 * 复制内置模板并把框架依赖改为统一版本或显式本地链接。
 * @param target 不存在的目标目录；相对当前工作目录解析。
 * @param frameworkPath 可选已构建框架路径，用于本地 link，不自动构建。
 * @param template 模板键，默认 blank。
 * @returns 创建目录的绝对路径。
 * @throws 目标已存在、模板缺失或文件 IO 失败；不覆盖既有应用，不回滚部分复制结果。
 */
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
