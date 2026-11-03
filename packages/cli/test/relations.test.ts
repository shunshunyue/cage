// 关系声明、生成契约和图谱的定向回归；数据库行为由 testkit 的真实 PG 用例覆盖。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, expect, it } from 'vitest';
import {
  aggregate,
  buildRegistry,
  event,
  hasMany,
  id,
  list,
  manyToMany,
  ref,
  text,
} from '@yss123/cage-kernel';
import * as domain from '../../testkit/test/fixtures/relations.js';
import { contractsFiles } from '../src/gen/contracts.js';
import { routes } from '../src/gen/index.js';
import { extract } from '../src/ontology.js';
import { explainEdge } from '../ui/relations.js';
import { projectGraph } from '../ui/model.js';
import { fieldType } from '../ui/structure.js';
import { impact } from '../src/impact.js';

const reg = buildRegistry(domain),
  graph = extract(reg);
const temporary = mkdtempSync(join(tmpdir(), 'cage-relations-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

it('无效反向外键、遗漏目标导出和 JSON/事件内关系在声明期给出明确诊断', () => {
  const Target = aggregate('Target', { fields: { title: text() } });
  const Owner = aggregate('Owner', { fields: { children: hasMany('Target', { mappedBy: 'ownerId' }) } });
  expect(() => buildRegistry({ Owner, Target })).toThrow(/CAGE-REL-001/);
  expect(() => buildRegistry({ Owner })).toThrow(/未从 domain 导出/);
  expect(() => list({ members: manyToMany('Target') })).toThrow(/CAGE-REL-001/);
  expect(() => list(hasMany('Target', { mappedBy: 'ownerId' }))).toThrow(/CAGE-REL-001/);
  expect(() => event('BadEvent', { members: manyToMany('Target') })).toThrow(/事件载荷/);
  expect(() => manyToMany('Target').optional()).toThrow(/CAGE-REL-001/);
  // 事件里的普通 ID 数组仍受支持，关系存储不能混入事件结构。
  expect(event('ValidEvent', { memberIds: list(id()) }).schema.safeParse({ memberIds: [] }).success).toBe(
    true,
  );
});

it('中间表名冲突被拦下，不会把既有业务表当成自动关系表', () => {
  const Target = aggregate('Target', { fields: {} });
  const Owner = aggregate('Owner', { fields: { members: manyToMany('Target') } });
  const Taken = aggregate('Taken', { fields: {}, table: { name: 'owner__members' } });
  expect(() => buildRegistry({ Owner, Target, Taken })).toThrow(/关系表名冲突/);
});

it('图谱记录四种关系基数，中文解释区分反查、外键和自动中间表', () => {
  const view = projectGraph(graph);
  for (const [from, cardinality, label] of [
    ['Note.members', 'many-to-many', '多对多'],
    ['Notebook.notes', 'one-to-many', '一对多'],
    ['Note.notebookId', 'many-to-one', '多对一'],
    ['Note.reviewerId', 'one-to-one', '一对一'],
  ]) {
    const edge = view.edges.find((e) => e.kind === 'refs' && e.from === `field:${from}`)!;
    expect(edge.cardinality).toBe(cardinality);
    expect(explainEdge(edge, view).label).toContain(label);
  }
  const members = view.nodes.find((n) => n.id === 'Note.members')!;
  expect(members.attrs.through).toBe('core.note__members');
  expect(fieldType(members)).toBe('多对多');
  expect(routes(reg)).toContainEqual({
    method: 'GET',
    url: '/api/note/:id/relations/members',
    capability: 'Note.read,User.read',
  });
});

it('目标字段变化能沿关联传播到来源对象，帮助定位关联页面的影响', () => {
  const Group = aggregate('Group', { fields: { members: manyToMany('Person') } });
  const person = (description: string) =>
    aggregate('Person', { fields: { name: text().describe(description) } });
  const before = extract(buildRegistry({ Group, Person: person('展示名') }));
  const after = extract(buildRegistry({ Group, Person: person('法定姓名') }));
  expect(impact(before, after, []).affected).toEqual(
    expect.arrayContaining(['Person.name', 'Person', 'Group.members', 'Group']),
  );
});

it('生成 SDK、关系 hooks、自关联与领域草稿通过真实 TypeScript 类型检查', () => {
  const generated = contractsFiles(reg, []);
  for (const [name, content] of Object.entries(generated)) {
    mkdirSync(dirname(join(temporary, name)), { recursive: true });
    writeFileSync(join(temporary, name), content);
  }
  writeFileSync(
    join(temporary, 'usage.ts'),
    `
import { note, notebook, useNoteRelatedMembers, type Note } from './index';
import { aggregate, hasMany, manyToMany, type Draft } from '@yss123/cage-kernel';
void note.related.members('id', { page: 2, username: 'zhangsan' });
void note.related.relatedNotes('id', { title: '目标便笺' });
void notebook.related.notes('id');
void useNoteRelatedMembers;
declare const snapshot: Note;
// @ts-expect-error 普通详情不承诺加载关系数组。
void snapshot.members;
const Parent = aggregate('Parent', { fields: { children: hasMany('Child', { mappedBy: 'parentId' }), members: manyToMany('Child') } });
declare const draft: Draft<typeof Parent>;
draft.members = ['id'];
// @ts-expect-error hasMany 不进入可写草稿。
draft.children = ['id'];
`,
  );
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  // 教材中的完整业务文件也参与编译，避免分发给 AI 的示例只在文字上成立。
  const guide = readFileSync(join(root, 'docs/ai/relations.md'), 'utf8');
  writeFileSync(join(temporary, 'guide-domain.ts'), guide.match(/```ts\n([\s\S]*?)\n```/)![1]);
  const program = ts.createProgram(
    [
      ...Object.keys(generated).map((name) => join(temporary, name)),
      join(temporary, 'usage.ts'),
      join(temporary, 'guide-domain.ts'),
      resolve(root, 'packages/testkit/test/fixtures/relations.ts'),
    ],
    {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      paths: {
        '@yss123/cage-client': [join(root, 'packages/client/dist/index.d.ts')],
        '@yss123/cage-kernel': [join(root, 'packages/kernel/dist/index.d.ts')],
        zod: [join(root, 'packages/cli/node_modules/zod/index.d.ts')],
      },
    },
  );
  expect(
    ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  ).toEqual([]);
});
