/**
 * 在隔离空白脚手架验证便笺、查询、审批、附件与 AI：注册教材声明、生成契约并编译真实页面与调用。
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
  const fileGuide = readFileSync(join(repository, 'docs/development/guides/files.md'), 'utf8');
  const fileExamples = [...fileGuide.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map(match => match[1]);
  if (fileExamples.length !== 3) throw new Error('附件指南应提供字段、上传和命令绑定三个片段');
  // 用教程规定的附件扩展更新临时 Note，强制实际契约接受文件 ID；正式便笺源码保持最小业务。
  const noteSource = readFileSync(join(course, 'note.ts'), 'utf8')
    .replace('aggregate, command, ref', 'aggregate, command, files, ref')
    .replace('  fields: {', '  fields: {\n' + fileExamples[0].split('\n').map(line => '    ' + line).join('\n'))
    .replace('input: z.object({ title: z.string().trim().min(1).max(120) })',
      'input: z.object({ title: z.string().trim().min(1).max(120), attachments: z.array(z.string().uuid()).max(3).optional() })');
  put(domainFile, noteSource);
  put('packages/domain/src/modules/note/index.ts', "export * from './note.js';\nexport * from './queries.js';\n");
  // 查询正文是完整声明：直接编译手册中的代码，避免只校验源码链接却漏掉文字示例的签名漂移。
  const primitives = readFileSync(join(repository, 'docs/development/reference/primitives.md'), 'utf8');
  const queryExample = primitives.match(/## 查询\r?\n[\s\S]*?```ts\r?\n([\s\S]*?)```/)?.[1];
  if (!queryExample) throw new Error('原语参考缺少完整查询示例');
  put('packages/domain/src/modules/note/queries.ts', queryExample);
  // 审批教材只增加本次临时应用的声明；不修改正式空白模板或采购业务。
  const approvalCourse = join(repository, 'docs/development/examples/approval');
  put('packages/domain/src/modules/review-request/review-request.ts', readFileSync(join(approvalCourse, 'review-request.ts'), 'utf8'));
  put('packages/domain/src/modules/review-request/index.ts', "export * from './review-request.js';\n");
  const intelligenceGuide = readFileSync(join(repository, 'docs/development/guides/intelligence.md'), 'utf8');
  const intelligenceExample = intelligenceGuide.match(/```ts\r?\n([\s\S]*?)```/)?.[1];
  const assistantExample = intelligenceGuide.match(/```tsx\r?\n([\s\S]*?)```/)?.[1];
  if (!intelligenceExample || !assistantExample) throw new Error('AI 指南缺少后端声明或页面上下文示例');
  put('packages/domain/src/integrations/intelligence.ts', intelligenceExample);
  put(
    'packages/domain/src/index.ts',
    "export * from '@yss123/cage-admin/domain';\nexport * from './modules/note/index.js';\nexport * from './modules/review-request/index.js';\nexport * from './integrations/intelligence.js';\n",
  );
  for (const page of ['notes-page.tsx', 'note-detail-page.tsx']) {
    put(`apps/web/src/modules/note/pages/${page}`, readFileSync(join(course, page), 'utf8'));
  }
  put(
    'apps/web/src/modules/note/index.ts',
    "export { NotesPage } from './pages/notes-page';\nexport { NoteDetailPage } from './pages/note-detail-page';\n",
  );
  put('apps/web/src/modules/review-request/request-actions.ts', readFileSync(join(approvalCourse, 'request-actions.ts'), 'utf8'));
  // 直接编译用户将粘贴的 SDK 片段，检查 FileUploadTask、绑定方法和 hooks 的实际参数类型。
  put('apps/web/src/modules/note/attachment-example.ts',
    "import { client, note } from '@app/contracts';\n" +
    '/** 附件指南的上传与绑定类型验收，完整页面负责错误、进度和 dispose。 */\n' +
    'export async function saveAttachment(selectedFile: File, title: string) {\n' +
    fileExamples.slice(1).join('\n') + '\nreturn result;\n}\n');
  put('apps/web/src/modules/note/assistant-example.tsx',
    "import { client, useAssistant, useAiPageContext } from '@yss123/cage-client';\nimport type { Note } from '@app/contracts';\n" +
    '/** 将指南的页面快照接到真实生成类型，只验证 SDK 接线，不执行模型或界面交互。 */\n' +
    'export function AssistantExample({ record }: { record: Note }) {\n' + assistantExample +
    '\nreturn <p>{assistant.streamingText}</p>;\n}\n');
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
  // 结论只允许 process，教学客户端必须看不到普通 approve/reject 写方法。
  const requestContract = readFileSync(join(application, 'packages/contracts/src/aggregates/review-request/index.ts'), 'utf8');
  if (/\n\s{2}(?:approve|reject):/.test(requestContract)) throw new Error('审批结论错误地暴露为用户契约');

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
    '教学验证通过：真实空白模板、便笺/查询/审批/附件/AI 声明、实际契约与页面调用、内部结论隔离及生成一致性；未连接数据库、模型或浏览器。',
  );
} finally {
  // 只清理本次 mkdtemp 创建的确定目录；junction 删除仅解除链接，不清理被复用的范例依赖。
  if (!resolve(temporary).startsWith(cache + sep)) throw new Error('课程临时目录越界');
  rmSync(temporary, { recursive: true, force: true });
}
