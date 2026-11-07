/**
 * 验证用户真正拿到的学习资料：模板快照完整、与规范来源一致、相对链接可打开。
 * 不启动数据库或生成业务行为测试；这项检查专门防止“仓库里有，脚手架里没有”。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// 可选目录用于验证从真实 npm 压缩包创建的项目，默认检查待分发模板。
const applications = process.argv[2]
  ? [resolve(process.argv[2])]
  : ['app', 'blank'].map((name) => join(root, 'templates', name));

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

const checked = new Set<string>();
for (const application of applications) {
  for (const directory of ['docs/ai', 'docs/errors']) {
    for (const source of markdownFiles(join(root, directory))) {
      const target = join(application, relative(root, source));
      if (!existsSync(target) || readFileSync(source, 'utf8') !== readFileSync(target, 'utf8')) {
        throw new Error(
          `应用学习资料不完整或未同步：${relative(root, target)}。核对模板同步与当前 CLI 构建。`,
        );
      }
      checked.add(source).add(target);
    }
  }
  for (const path of [
    'AGENTS.md',
    'README.md',
    'examples/purchase-admin/AGENTS.md',
    'examples/purchase-admin/README.md',
  ])
    checked.add(join(root, path));
  checked.add(join(application, 'AGENTS.md')).add(join(application, 'README.md'));
  const reference = join(application, 'docs/examples/purchase-admin');
  if (existsSync(reference)) checked.add(join(reference, 'README.md'));

  const agents = readFileSync(join(application, 'AGENTS.md'), 'utf8');
  if (
    !agents.includes('docs/ai/README.md') ||
    !agents.includes('docs/ai/intelligence.md') ||
    !agents.includes('docs/errors/README.md') ||
    !agents.includes('<!-- cage:end -->')
  ) {
    throw new Error('模板 AGENTS.md 必须包含本地学习入口、原生智能化入口、错误码入口与完整托管区');
  }
}

for (const path of checked) {
  // 代码块中的链接可能是语法反例，不能当作真实文档导航。
  const content = readFileSync(path, 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(?:[a-z]+:|#)/i.test(link)) continue;
    const local = decodeURIComponent(link.replace(/^<|>$/g, '').split('#')[0]);
    if (local && !existsSync(resolve(dirname(path), local))) {
      throw new Error(`${relative(root, path)} 链接不存在：${link}`);
    }
  }
}

console.log(
  `学习资料检查通过：${applications.length} 个应用、${checked.size} 个文件，模板快照与本地链接完整。`,
);
