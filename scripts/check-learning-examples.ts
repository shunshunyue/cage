/**
 * 在隔离空白脚手架验证便笺及关系、自动化、审批、附件、AI、页面与任务：注册、生成并编译真实调用。
 * 正文标记的完整片段直接编译，摘录与已编译源码逐段比对；评论 handler 的成功和拒绝例子实际执行。
 * 使用已安装的框架/范例依赖，通过临时目录中的 junction 或目录链接复用，不安装依赖或接触数据库。
 * 这只能证明声明、生成及类型接入可用；真实身份、持久化、浏览器交互仍须另做业务验收。
 */
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const materials = join(repository, 'docs/development');
/** 标记只用于定位作者写好的代码，不生成或改写教材；同一 ID 全册唯一，避免验证错段。 */
const examples = new Map<string, { guide: string; code: string }>();
for (const guide of globSync('**/*.md', { cwd: materials }).sort()) {
  const text = readFileSync(join(materials, guide), 'utf8');
  for (const match of text.matchAll(/<!-- cage:example ([a-z0-9-]+) -->\r?\n```(?:ts|tsx)\r?\n([\s\S]*?)```/g)) {
    if (examples.has(match[1])) throw new Error(`教学示例标记重复：${match[1]}`);
    examples.set(match[1], { guide: guide.replace(/\\/g, '/'), code: match[2].trimEnd() });
  }
}
const checked = new Set<string>();
/** 新增短片段在明确的领域、Web 或测试上下文中逐个编译；共享 import 只提供教材已有真实符号。 */
const snippets: {
  /** 全册唯一的片段 ID，同时用于隔离验证文件命名。 */
  id: string;
  /** 由匹配规则限定的 domain/web/test 上下文，决定可用依赖及包内位置。 */
  scope: string;
  /** ts 或 tsx，保留原片段是否需要 JSX 编译。 */
  language: string;
  /** 作者手写的正文代码，只用于编译验证，不反向生成教材。 */
  code: string;
}[] = [];
for (const guide of globSync('**/*.md', { cwd: materials }).sort()) {
  const text = readFileSync(join(materials, guide), 'utf8');
  for (const match of text.matchAll(/<!-- cage:check (domain|web|test) ([a-z0-9-]+) -->\r?\n```(ts|tsx)\r?\n([\s\S]*?)```/g)) {
    if (snippets.some(snippet => snippet.id === match[2])) throw new Error(`短示例标记重复：${match[2]}`);
    snippets.push({ scope: match[1], id: match[2], language: match[3], code: match[4] });
  }
}

/** 取得指定教材代码并登记覆盖，路径和 ID 必须同时匹配，防止移动段落后悄悄检验其他例子。 */
function example(guide: string, id: string): string {
  const entry = examples.get(id);
  if (!entry || entry.guide !== guide) throw new Error(`教学示例缺失：${guide} / ${id}`);
  checked.add(id);
  return entry.code;
}

/** 仅忽略排版缩进和换行差异；保留每行具体代码，避免正文摘录与实际编译文件各写一套。 */
const comparable = (code: string) => code.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).join('\n').trim();

try {
  const application = createApp(join(temporary, 'application'), repository);
  const course = join(repository, 'docs/development/examples/note');
  /** 仅向本次脚手架目录写文件，父目录由本次创建，输入源码来自框架规范教材。 */
  function put(path: string, content: string): void {
    const destination = join(application, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  // 根依赖提供测试工具，各 workspace 依赖提供框架与界面库；均复用本地安装，不在临时应用安装包。
  for (const workspace of ['', 'packages/domain', 'packages/contracts', 'apps/web']) {
    symlinkSync(
      join(repository, 'examples/purchase-admin', workspace, 'node_modules'),
      join(application, workspace, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const domainFile = 'packages/domain/src/modules/note/note.ts';
  const fileExamples = ['files-field', 'files-upload', 'files-bind'].map(id => example('guides/files.md', id));
  // 用教程规定的附件扩展更新临时 Note，强制实际契约接受文件 ID；正式便笺源码保持最小业务。
  const noteSource = readFileSync(join(course, 'note.ts'), 'utf8')
    .replace('aggregate, command, ref', 'aggregate, command, emit, files, hasMany, manyToMany, ref')
    .replace("import { z } from 'zod';", "import { z } from 'zod';\nimport { NoteArchived } from './archive-log.js';")
    .replace('  fields: {', '  fields: {\n' + [fileExamples[0], example('guides/relations.md', 'note-relations-fields')].join('\n').split('\n').map(line => '    ' + line).join('\n'))
    .replace('input: z.object({ title: z.string().trim().min(1).max(120) })',
      'input: z.object({ title: z.string().trim().min(1).max(120), attachments: z.array(z.string().uuid()).max(3).optional() })')
    .replace("  description: '归档便笺',", "  description: '归档便笺',\n  invokedBy: ['user', 'job'],\n" +
      example('guides/automation.md', 'note-archive-emits').split('\n').map(line => '  ' + line).join('\n'));
  put(domainFile, noteSource);
  for (const file of ['note-comments.ts', 'note-members.ts', 'archive-log.ts', 'jobs.ts', 'note-comments.test.ts'])
    put(`packages/domain/src/modules/note/${file}`, readFileSync(join(course, file), 'utf8'));
  put('packages/domain/src/modules/note/index.ts', example('reference/project-structure.md', 'note-module-exports') +
    "\nexport * from './archive-log.js';\nexport * from './jobs.js';\n");
  put('packages/domain/src/workflows/note-process.ts', readFileSync(join(course, 'note-process.ts'), 'utf8'));
  put('packages/domain/src/integrations/archive-service.ts', readFileSync(join(course, 'archive-service.ts'), 'utf8'));
  // 查询正文是完整声明：直接编译手册中的代码，避免只校验源码链接却漏掉文字示例的签名漂移。
  const primitives = readFileSync(join(repository, 'docs/development/reference/primitives.md'), 'utf8');
  const queryExample = primitives.match(/## 查询\r?\n[\s\S]*?```ts\r?\n([\s\S]*?)```/)?.[1];
  if (!queryExample) throw new Error('原语参考缺少完整查询示例');
  put('packages/domain/src/modules/note/queries.ts', queryExample);
  // 审批教材只增加本次临时应用的声明；不修改正式空白模板或采购业务。
  const approvalCourse = join(repository, 'docs/development/examples/approval');
  put('packages/domain/src/modules/review-request/review-request.ts', readFileSync(join(approvalCourse, 'review-request.ts'), 'utf8'));
  put('packages/domain/src/modules/review-request/index.ts', "export * from './review-request.js';\n");
  const intelligenceExample = example('guides/intelligence.md', 'ai-runtime');
  const assistantExample = example('guides/intelligence.md', 'ai-page-context');
  put('packages/domain/src/integrations/intelligence.ts', intelligenceExample);
  put(
    'packages/domain/src/index.ts',
    "export * from '@yss123/cage-admin/domain';\nexport * from './modules/note/index.js';\nexport * from './modules/review-request/index.js';\nexport * from './integrations/intelligence.js';\nexport * from './integrations/archive-service.js';\nexport * from './workflows/note-process.js';\n",
  );
  for (const page of ['notes-page.tsx', 'note-detail-page.tsx', 'notes-table-page.tsx']) {
    put(`apps/web/src/modules/note/pages/${page}`, readFileSync(join(course, page), 'utf8'));
  }
  put(
    'apps/web/src/modules/note/index.ts',
    example('reference/project-structure.md', 'note-web-exports') + '\n',
  );
  for (const file of ['note-client.ts', 'transfer-panel.tsx'])
    put(`apps/web/src/modules/note/${file}`, readFileSync(join(course, file), 'utf8'));
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
  // 完整片段直接写到可解析真实依赖的包内；替代配置在 src 外仅做类型接入，不注册第二套同名运行时或路由。
  const completeExamples: [string, string, string][] = [
    ['reference/primitives.md', 'expense-fields', 'packages/domain/guide-checks/expense-fields.ts'],
    ['reference/authorization.md', 'dept-editor', 'packages/domain/guide-checks/dept-editor.ts'],
    ['reference/authorization.md', 'protected-fields', 'packages/domain/guide-checks/protected-fields.ts'],
    ['reference/approval.md', 'parallel-request-route', 'packages/domain/guide-checks/advanced-route.ts'],
    ['reference/intelligence.md', 'responses-model', 'packages/domain/guide-checks/responses-model.ts'],
    ['reference/approval.md', 'transfer-approval-task', 'apps/web/src/modules/review-request/transfer-task.ts'],
    ['guides/relations.md', 'relation-client', 'apps/web/src/modules/note/relation-usage.ts'],
    ['guides/transfers.md', 'transfer-result', 'apps/web/src/modules/note/transfer-result.tsx'],
  ];
  for (const [guide, id, target] of completeExamples) put(target, example(guide, id) + '\n');
  const domainImports = [
    "import { aggregate, command, fail, states, scope, text, int, number, money, id, ref, date, datetime, bool, enumOf, list, json, hasMany, manyToMany, file, files, event, emit, reaction, reactionEach, query, approval, job, unsafe, sod, stepUp, ok, violation, type Constraint, type SnapshotOf, type ReadRepo } from '@yss123/cage-kernel';",
    "import { approver, route, step, when, gt, gte, lt, lte, eq, ne, isIn, parallel, branch, approvalOperations } from '@yss123/cage-approval';",
    "import { connector, op, outbound, inbound, hmacSha256, fakeConnector } from '@yss123/cage-connectors';",
    "import { ai, managedModel, chatModel, responsesModel } from '@yss123/cage-ai';",
    "import { z } from 'zod';",
    "import { Note, createNote, updateNote, archiveNote, NoteArchived, NoteArchiveLog, recordNoteArchive } from '../src/modules/note/index.js';",
    "import { ReviewRequest, ReviewRequestSubmitted, ReviewRequestWithdrawn, approveReviewRequest, rejectReviewRequest } from '../src/modules/review-request/index.js';",
    "import { archiveService } from '../src/integrations/archive-service.js';",
  ].join('\n');
  const webImports = [
    "import { client, can, loadMe, useCan, useCageCommand, useTransfer, useAssistant, useAiPageContext, AiPageContext, type ApprovalTask, type ApprovalRequest, type AiEvent, type FileUploadTask, type UploadSession } from '@yss123/cage-client';",
    "import { note, noteComment, reviewRequest, queries, useNote, useNoteList, type Note } from '@app/contracts';",
    "import { useEffect, useRef, useState } from 'react';",
    "import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';",
    "import { useQueryClient } from '@tanstack/react-query';",
    "import { loginReturnTo } from '../src/shared/lib/navigation';",
    "import { Alert, App, Button, Descriptions, Empty, Form, Input, Select, Skeleton, Space, Table, Tag } from 'antd';",
  ].join('\n');
  const testImports = domainImports + "\nimport { expect, it } from 'vitest';\nimport { createTestEnv, draftOf, fakeRepo, handlerCtx, type TestEnv } from '@yss123/cage-testkit';\n";
  // 声明替代写法只验证类型，不注册第二份同名声明；真实组合仍由上面的完整课程通过 analyze/gen。
  for (const snippet of snippets) {
    const isWeb = snippet.scope === 'web';
    const target = isWeb ? 'apps/web/guide-checks' : 'packages/domain/guide-checks';
    const imports = isWeb ? webImports : snippet.scope === 'test' ? testImports : domainImports;
    put(`${target}/${snippet.id}.${snippet.language === 'tsx' ? 'tsx' : 'ts'}`, imports + '\n' + snippet.code);
  }
  // AI 审核步骤属于既有 route 中的局部例子；验证其真实重载，不把缺少业务绑定的片段冒充完整流程。
  const aiStep = example('guides/intelligence.md', 'ai-review-step');
  put('packages/domain/guide-checks/ai-step.ts',
    "import { approver, step } from '@yss123/cage-approval';\nexport const materialReview = " + aiStep);

  const excerpts: [string, string, string][] = [
    ['getting-started/architecture.md', 'archive-note', 'note/note.ts'],
    ['guides/recipes.md', 'recipe-archive-note', 'note/note.ts'],
    ['reference/primitives.md', 'note-invariant', 'note/note.ts'],
    ['guides/relations.md', 'create-note-comment', 'note/note-comments.ts'],
    ['guides/relations.md', 'set-note-members', 'note/note-members.ts'],
    ['guides/automation.md', 'log-note-archive', 'note/archive-log.ts'],
    ['guides/automation.md', 'archive-old-notes', 'note/jobs.ts'],
    ['guides/automation.md', 'archive-service', 'note/archive-service.ts'],
    ['guides/automation.md', 'send-note-archive', 'note/archive-service.ts'],
    ['guides/frontend-ui.md', 'create-note-form', 'note/notes-table-page.tsx'],
    ['guides/frontend-ui.md', 'note-form-view', 'note/notes-table-page.tsx'],
    ['guides/routing.md', 'note-url-query', 'note/notes-table-page.tsx'],
    ['guides/routing.md', 'note-url-change', 'note/notes-table-page.tsx'],
    ['reference/authorization.md', 'approve-review-request', 'approval/review-request.ts'],
    ['reference/client.md', 'rename-note', 'note/note-client.ts'],
    ['reference/client.md', 'prepare-note-creation', 'note/note-client.ts'],
    ['reference/execution.md', 'same-archive-log', 'note/archive-log.ts'],
    ['guides/ontology-modeling.md', 'note-lifecycle', 'note/note-process.ts'],
    ['reference/verification.md', 'archived-comment-test', 'note/note-comments.test.ts'],
  ];
  for (const [guide, id, source] of excerpts) {
    const actual = readFileSync(join(materials, 'examples', source), 'utf8');
    if (!comparable(actual).includes(comparable(example(guide, id))))
      throw new Error(`正文代码与教学源码不一致：${guide} / ${id}`);
  }
  // 采购导读展示当前范例原文，单独核对来源，防止维护课程时把真实路径或业务边界改成自造写法。
  const purchaseExcerpts: [string, string][] = [
    ['purchase-domain-exports', 'index.ts'],
    ['purchase-invariants', 'modules/purchase/purchase-order.ts'],
    ['purchase-submit', 'modules/purchase/purchase-order.ts'],
    ['purchase-conditional-review', 'modules/purchase/approvals.ts'],
    ['purchase-lock-reaction', 'workflows/purchase-inventory.ts'],
    ['purchase-release-reaction', 'workflows/purchase-inventory.ts'],
    ['purchase-erp-outbound', 'integrations/erp.ts'],
    ['purchase-erp-receipt-options', 'modules/purchase/purchase-order.ts'],
    ['purchase-erp-inbound', 'integrations/erp.ts'],
  ];
  for (const [id, source] of purchaseExcerpts) {
    const actual = readFileSync(join(repository, 'examples/purchase-admin/packages/domain/src', source), 'utf8');
    if (!comparable(actual).includes(comparable(example('examples/purchase-example.md', id))))
      throw new Error(`采购正文与实际源码不一致：${id}`);
  }
  const unchecked = [...examples.keys()].filter(id => !checked.has(id));
  if (unchecked.length) throw new Error(`教学示例尚未接入验证：${unchecked.join('、')}`);
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
        include: ['packages/domain/src', 'packages/domain/guide-checks', 'packages/contracts/src', 'apps/web/src', 'apps/web/guide-checks'],
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
  put('vitest.lesson.config.mts',
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['packages/domain/src/modules/note/note-comments.test.ts'] } });\n");
  execFileSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(application, 'vitest.lesson.config.mts')],
    { cwd: application, stdio: 'inherit', windowsHide: true });
  console.log(
    `教学验证通过：${checked.size} 段组合/摘录与 ${snippets.length} 段逐项短例、真实契约与页面、生成一致性及评论 handler 测试；未连接数据库、外部服务、模型或浏览器。`,
  );
} finally {
  // 只清理本次 mkdtemp 创建的确定目录；junction 删除仅解除链接，不清理被复用的范例依赖。
  if (!resolve(temporary).startsWith(cache + sep)) throw new Error('课程临时目录越界');
  rmSync(temporary, { recursive: true, force: true });
}
