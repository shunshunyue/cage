/**
 * 在隔离的空白脚手架中验证完整入门课：复制教程源码、注册声明、生成实际契约并编译领域与页面。
 * 使用已安装的框架/范例依赖，通过临时目录中的 junction 或目录链接复用，不安装依赖或接触数据库。
 * 这只能证明声明、生成及类型接入可用；真实身份、持久化、浏览器交互仍须另做业务验收。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApp } from '../packages/cli/dist/create.js';
import { analyze } from '../packages/cli/dist/analyze.js';
import { loadConfig } from '../packages/cli/dist/config.js';
import { generate } from '../packages/cli/dist/gen/index.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cache = resolve(repository, '.cage/learning-examples');
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, 'check-'));

try {
  const application = createApp(join(temporary, 'application'), repository);
  const course = join(repository, 'docs/development/examples/note');
  /** 仅向本次脚手架目录写文件，父目录由本次创建，输入源码来自框架规范教材。 */
  function put(path: string, content: string): void {
    const destination = join(application, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  for (const workspace of ['packages/domain', 'packages/contracts', 'apps/web']) {
    symlinkSync(
      join(repository, 'examples/purchase-admin', workspace, 'node_modules'),
      join(application, workspace, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const domainFile = 'packages/domain/src/modules/note/note.ts';
  put(domainFile, readFileSync(join(course, 'note.ts'), 'utf8'));
  put('packages/domain/src/modules/note/index.ts', "export * from './note.js';\n");
  put(
    'packages/domain/src/index.ts',
    "export * from '@yss123/cage-admin/domain';\nexport * from './modules/note/index.js';\n",
  );
  for (const page of ['notes-page.tsx', 'note-detail-page.tsx']) {
    put(`apps/web/src/modules/note/pages/${page}`, readFileSync(join(course, page), 'utf8'));
  }
  put(
    'apps/web/src/modules/note/index.ts',
    "export { NotesPage } from './pages/notes-page';\nexport { NoteDetailPage } from './pages/note-detail-page';\n",
  );
  // 从教材原文抽取真实路由片段并接到脚手架 app，避免只编译组件却漏掉课程中的接线错误。
  const lesson = readFileSync(join(repository, 'docs/development/getting-started/first-feature.md'), 'utf8');
  const routes = lesson.match(/```tsx\r?\n([\s\S]*?)```/)?.[1];
  if (!routes) throw new Error('入门课缺少路由接入片段');
  const appPath = 'apps/web/src/app/app.tsx';
  const app = readFileSync(join(application, appPath), 'utf8');
  const routeAnchor = '<Route index element={<Navigate to="/workspace" replace />} />';
  if (!app.includes(routeAnchor)) throw new Error('空白模板路由结构已变化，请更新课程接入验证');
  put(
    appPath,
    "import { NotesPage, NoteDetailPage } from '../modules/note';\n" +
      app.replace(routeAnchor, routeAnchor + '\n' + routes),
  );

  const cfg = loadConfig(application);
  const analysis = await analyze(cfg);
  const failures = analysis.findings.filter((finding) => finding.severity !== 'warning');
  if (failures.length || !analysis.registry || !analysis.graph)
    throw new Error(JSON.stringify(failures, null, 2));
  const generated = generate(cfg, analysis.registry, analysis.graph, analysis.source.sites);
  if (generated.findings.some((finding) => finding.severity !== 'warning'))
    throw new Error(JSON.stringify(generated.findings, null, 2));

  // 将 @app/contracts 显式指向刚生成的契约，避免依赖链接误用采购范例的旧契约而漏检教学错误。
  put(
    'tsconfig.lesson.json',
    JSON.stringify(
      {
        extends: join(repository, 'tsconfig.base.json'),
        compilerOptions: {
          noEmit: true,
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
          paths: { '@app/contracts': ['./packages/contracts/src/index.ts'] },
        },
        include: ['packages/domain/src', 'packages/contracts/src', 'apps/web/src'],
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(application, 'tsconfig.lesson.json')],
    { cwd: application, stdio: 'inherit', windowsHide: true },
  );
  const consistency = generate(cfg, analysis.registry, analysis.graph, analysis.source.sites, {
    check: true,
  });
  if (consistency.findings.some((finding) => finding.severity !== 'warning'))
    throw new Error(JSON.stringify(consistency.findings, null, 2));
  console.log(
    '入门课验证通过：真实空白模板、领域检查、契约生成、领域/页面类型及生成一致性；未连接数据库或浏览器。',
  );
} finally {
  // 只清理本次 mkdtemp 创建的确定目录；junction 删除仅解除链接，不清理被复用的范例依赖。
  if (!resolve(temporary).startsWith(cache + sep)) throw new Error('课程临时目录越界');
  rmSync(temporary, { recursive: true, force: true });
}
