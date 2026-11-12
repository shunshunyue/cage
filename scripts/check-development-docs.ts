/**
 * 检查规范教材是否完整进入待分发模板或显式指定的独立应用目录，同时检查整个框架文档目录。
 * 比较全部教材与课程源码的分发快照，检查同源 Skill 入口和 AGENTS，并验证 Markdown 文件及章节链接。
 * 代码块剥离后才扫描链接，避免把语法反例当导航；本脚本不编译文档示例或运行浏览器验收。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSkillEntries } from './sync-agent-skill.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
// 可选目录用于验证从真实 npm 压缩包创建的项目，默认检查待分发模板。
const applications = process.argv[2]
  ? [resolve(process.argv[2])]
  : ['app', 'blank'].map((name) => join(root, 'templates', name));

/**
 * 递归枚举给定资料目录的全部文件，包含课程源码，供来源与分发快照逐一比对。
 * 返回路径列表，不读取正文、不跟进网页，也不修改文档。
 */
function materialFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? materialFiles(path) : [path];
  });
}

const checked = new Set<string>();
// 文档根与教材根只保留导航页，新增资料进入用途子目录；检查全部框架文档可发现搬迁后的历史交叉链接。
for (const directory of ['docs', 'docs/development']) {
  const misplaced = readdirSync(join(root, directory), { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name !== 'README.md',
  );
  if (misplaced.length)
    throw new Error(
      `${directory} 根目录只放 README.md，请按用途归类：${misplaced.map((entry) => entry.name).join('、')}`,
    );
}
for (const file of materialFiles(join(root, 'docs'))) if (file.endsWith('.md')) checked.add(file);
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  const readme = join(root, 'packages', entry.name, 'README.md');
  if (entry.isDirectory() && existsSync(readme)) checked.add(readme);
}
for (const application of applications) {
  for (const directory of ['docs/development', 'docs/errors']) {
    const sources = materialFiles(join(root, directory));
    const expected = new Set(sources.map((source) => relative(join(root, directory), source)));
    for (const target of materialFiles(join(application, directory))) {
      if (!expected.has(relative(join(application, directory), target)))
        throw new Error(`应用保留已删除的学习资料：${target}`);
    }
    for (const source of sources) {
      const target = join(application, relative(root, source));
      if (!existsSync(target) || readFileSync(source, 'utf8') !== readFileSync(target, 'utf8')) {
        throw new Error(
          `应用学习资料不完整或未同步：${relative(root, target)}。核对模板同步与当前 CLI 构建。`,
        );
      }
      if (source.endsWith('.md')) checked.add(source).add(target);
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
  checked.add(join(application, 'docs/README.md'));
  const reference = join(application, 'docs/examples/purchase-admin');
  if (existsSync(reference)) checked.add(join(reference, 'README.md'));

  const agents = readFileSync(join(application, 'AGENTS.md'), 'utf8');
  if (
    !agents.includes('docs/development/README.md') ||
    !agents.includes('docs/development/guides/intelligence.md') ||
    !agents.includes('docs/development/skills/cage-development/SKILL.md') ||
    !agents.includes('docs/errors/README.md') ||
    !agents.includes('<!-- cage:end -->')
  ) {
    throw new Error(
      '模板 AGENTS.md 必须包含框架 Skill、本地学习入口、原生智能化入口、错误码入口与完整托管区',
    );
  }
}

// 发现入口仅是同源正文的链接；同时核对仓库和实际分发根，防止遗漏隐藏目录或指向框架外部。
for (const application of [root, ...applications]) {
  for (const [path, expected] of Object.entries(agentSkillEntries(application))) {
    const target = join(application, path);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== expected)
      throw new Error(`Agent Skill 入口缺失或不同步：${target}`);
    checked.add(target);
  }
}

const brokenLinks: string[] = [];
/**
 * 提取 Markdown 的可导航章节标识，忽略代码块并保留显式 HTML 锚点。
 * 中文标题保留文字，格式标记和标点不进入标识；同名标题依次追加 -1、-2，便于检查重写后的跨页引用。
 * 这里只检查本地章节存在，不判断远端网页、业务含义或浏览器交互。
 */
function anchors(content: string): Set<string> {
  const body = content.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const found = new Set<string>();
  const repeats = new Map<string, number>();
  for (const match of body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const title = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/<[^>]*>/g, '');
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').trim().replace(/\s/g, '-');
    const count = repeats.get(base) ?? 0;
    repeats.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  for (const match of body.matchAll(/<a\b[^>]*(?:id|name)=["']([^"']+)["']/gi)) found.add(match[1]);
  return found;
}

// 一个章节可能被多个页面链接；按目标文件缓存锚点，避免模板快照验证重复解析。
const anchorCache = new Map<string, Set<string>>();
for (const path of checked) {
  // 代码块中的链接可能是语法反例，不能当作真实文档导航。
  const content = readFileSync(path, 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    let link = match[1];
    // 本仓库 GitHub 链接也按当前 checkout 验证，不访问远端；其他网站链接不属于本地文档门禁。
    const repositoryLink = link.match(
      /^https:\/\/github\.com\/shunshunyue\/cage\/(?:blob|tree)\/main\/(.+)$/,
    );
    if (repositoryLink) {
      const [file, fragment] = repositoryLink[1].split('#');
      link = relative(dirname(path), join(root, decodeURIComponent(file))) + (fragment ? `#${fragment}` : '');
    }
    if (/^[a-z]+:/i.test(link)) continue;
    const [file, fragment] = link.replace(/^<|>$/g, '').split('#');
    const local = decodeURIComponent(file);
    const target = local ? resolve(dirname(path), local) : path;
    if (!existsSync(target)) {
      brokenLinks.push(`${relative(root, path)} 链接不存在：${match[1]}`);
    } else if (fragment && target.endsWith('.md')) {
      if (!anchorCache.has(target)) anchorCache.set(target, anchors(readFileSync(target, 'utf8')));
      if (!anchorCache.get(target)!.has(decodeURIComponent(fragment)))
        brokenLinks.push(`${relative(root, path)} 章节不存在：${match[1]}`);
    }
  }
}
if (brokenLinks.length) throw new Error(brokenLinks.join('\n'));

console.log(
  `学习资料检查通过：${applications.length} 个应用、${checked.size} 个文件，模板快照、文件和章节链接完整。`,
);
