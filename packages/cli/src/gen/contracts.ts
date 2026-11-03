// 前端契约（packages/contracts）：每个聚合一个目录，容纳 schema、调用方法和查询 hooks。
// 前端只能从这里引入，所以调用方式、参数、错误码都有类型检查。
import {
  kebab,
  isRelation,
  lowerFirst,
  upperFirst,
  type AnyAggregate,
  type Fields,
  type Registry,
  type RegisteredCommand,
} from '@yss123/cage-kernel';
import { z } from 'zod';
import type { DeclSite } from '../static-check.js';
import { snapshotCode, zodCodeOf } from './zod-code.js';

const HEADER = '// 生成物：由 cage gen 从 domain 声明生成，不要手改。\n/* eslint-disable */\n';

function commandUrlExpr(c: RegisteredCommand): string {
  const base = `/api/${kebab(c.cmd.agg.name)}`;
  return c.cmd.from === 'new'
    ? `'${base}/${kebab(c.name)}'`
    : `\`${base}/\${encodeURIComponent(id)}/${kebab(c.name)}\``;
}

function errorUnion(c: RegisteredCommand): string[] {
  const codes = new Set(['FORBIDDEN', 'INVALID_INPUT', 'DOMAIN_ERROR', 'CONFLICT']);
  if (c.cmd.from !== 'new') ['NOT_FOUND', 'INVALID_TRANSITION'].forEach((x) => codes.add(x));
  if (Object.values(c.cmd.agg.fields as Fields).some((f) => ['manyToMany', 'file', 'files'].includes(f.kind))) codes.add('NOT_FOUND');
  if (c.cmd.constraints.length || c.cmd.from === 'new') codes.add('CONSTRAINT_VIOLATED');
  if (Object.keys(c.cmd.agg.invariants).length) codes.add('INVARIANT_VIOLATED');
  return [...codes].sort();
}

function isIdOnly(c: RegisteredCommand): boolean {
  const s = c.cmd.input;
  return s instanceof z.ZodObject && Object.keys(s.shape).length === 1 && 'id' in s.shape;
}

export function aggregateFile(reg: Registry, a: AnyAggregate, sites: DeclSite[]): string {
  const N = a.name;
  const m = lowerFirst(N);
  const cmds = reg.commands.filter((c) => c.cmd.agg === a && c.cmd.invokedBy.includes('user'));
  const relations = Object.entries(a.fields as Fields).filter(([, field]) => isRelation(field));
  const out: string[] = [HEADER];
  out.push(`import { z } from 'zod';`);
  out.push(`import { client, useCageList, useCageQuery, type TransferTask, type RequestOptions } from '@yss123/cage-client';`);
  for (const target of new Set(relations.map(([, field]) => field.ref!)))
    if (target !== N)
      out.push(
        `import { ${target}Schema, type ${target}, type ${target}ListParams } from '../${kebab(target)}';`,
      );
  out.push('');
  out.push(`/** ${a.description ?? N}：读侧快照（敏感字段是按权限掩码后的值） */`);
  out.push(`export const ${N}Schema = ${snapshotCode(a.fields as Fields, a.states.values)};`);
  out.push(`export type ${N} = z.infer<typeof ${N}Schema>;`);
  out.push(`export type ${N}Status = ${N}['status'];`);
  out.push(`export const ${N}States = [${a.states.values.map((s) => `'${s}'`).join(', ')}] as const;`);
  const fileFields = Object.fromEntries(Object.entries(a.fields as Fields).filter(([, f]) => f.filePolicy).map(([key, f]) => [key, { ...f.filePolicy, multiple: f.kind === 'files' }]));
  if (Object.keys(fileFields).length) out.push(`/** 文件字段限制；服务端仍执行权威校验。 */\nexport const ${N}FileFields = ${JSON.stringify(fileFields)} as const;`);
  out.push('');
  out.push(`/** 命令输入：和后端命令的输入校验完全一致 */`);
  out.push(`export const ${N}Inputs = {`);
  for (const c of cmds) out.push(`  ${c.name}: ${zodCodeOf(c.cmd.input)},`);
  out.push('};');
  out.push('');
  for (const c of cmds) {
    const site = sites.find((s) => s.exportName === c.exportName);
    out.push(
      `/** ${c.capability} 可能返回的错误码${site?.domainCodes.length ? `；业务码（domainCode）：${site.domainCodes.join('、')}` : ''} */`,
    );
    out.push(
      `export type ${N}${upperFirst(c.name)}Error = ${errorUnion(c)
        .map((x) => `'${x}'`)
        .join(' | ')};`,
    );
    if (site?.domainCodes.length)
      out.push(
        `export type ${N}${upperFirst(c.name)}DomainCode = ${site.domainCodes.map((x) => `'${x}'`).join(' | ')};`,
      );
  }
  out.push('');
  const fieldKeys = Object.entries(a.fields as Fields)
    .filter(([, f]) => !f.isHidden && !isRelation(f) && f.sql !== 'jsonb' && !f.sensitiveKind)
    .map(([k]) => k);
  const sortKeys = [
    'createdAt',
    'updatedAt',
    ...Object.entries(a.fields as Fields)
      .filter(([, f]) => !f.isHidden && !isRelation(f) && f.sql !== 'jsonb')
      .map(([k]) => k),
  ];
  out.push(`export type ${N}SortKey = ${sortKeys.map((k) => `'${k}'`).join(' | ')};`);
  out.push(`export interface ${N}ListParams {`);
  out.push('  page?: number;');
  out.push('  pageSize?: number;');
  out.push(`  /** 排序：字段名，前面加 - 表示倒序 */`);
  out.push(`  sort?: ${N}SortKey | \`-\${${N}SortKey}\`;`);
  out.push(`  /** 可以逗号分隔多个状态 */`);
  out.push('  status?: string;');
  out.push('  createdAfter?: string;');
  out.push('  createdBefore?: string;');
  for (const k of fieldKeys) out.push(`  ${k}?: string | number | boolean;`);
  out.push('}');
  out.push('');
  out.push(`/** 调用方法：每个命令一个；client 自动生成并附带幂等键和 CSRF 令牌 */`);
  out.push(`export const ${m} = {`);
  for (const c of cmds) {
    const E = `${N}${upperFirst(c.name)}Error`;
    const url = commandUrlExpr(c);
    const desc = c.cmd.description ? `  /** ${c.cmd.description} */\n` : '';
    if (c.cmd.from === 'new') {
      out.push(
        `${desc}  ${c.name}: (input: z.input<typeof ${N}Inputs.${c.name}>, options: RequestOptions = {}) => client.post<${N}, ${E}>(${url}, input, options),`,
      );
    } else if (isIdOnly(c)) {
      out.push(
        `${desc}  ${c.name}: (id: string, expectedVersion?: number, options: RequestOptions = {}) => client.post<${N}, ${E}>(${url}, { expectedVersion }, options),`,
      );
    } else {
      out.push(
        `${desc}  ${c.name}: (id: string, input: Omit<z.input<typeof ${N}Inputs.${c.name}>, 'id'>, expectedVersion?: number, options: RequestOptions = {}) => client.post<${N}, ${E}>(${url}, { ...input, expectedVersion }, options),`,
      );
    }
  }
  out.push(
    `  /** 异步导出 CSV：返回任务，使用 client.transfer(id) 查状态，完成后下载。需要 ${N}.export 能力。 */`,
  );
  out.push(
    `  export: (params: ${N}ListParams = {}, options: RequestOptions = {}) => client.post<TransferTask, 'CONFLICT'>('/api/${kebab(N)}/export', params, options),`,
  );
  out.push(`  get: (id: string, options: RequestOptions = {}) => client.get<${N}>(\`/api/${kebab(N)}/\${encodeURIComponent(id)}\`, undefined, options),`);
  out.push(
    `  list: (params: ${N}ListParams = {}, options: RequestOptions = {}) => client.get<{ items: ${N}[]; total: number; page: number; pageSize: number }>('/api/${kebab(N)}', params as Record<string, unknown>, options),`,
  );
  if (relations.length) {
    out.push('  /** 关联对象按需分页读取；不会随主对象详情自动展开。 */', '  related: {');
    for (const [key, field] of relations) {
      const target = field.ref!;
      out.push(`    /** ${field.description ?? key}：同时需要 ${N}.read 和 ${target}.read。 */`);
      out.push(
        `    ${key}: (id: string, params: ${target}ListParams = {}, options: RequestOptions = {}) => client.get<{ items: ${target}[]; total: number; page: number; pageSize: number }>(\`/api/${kebab(N)}/\${encodeURIComponent(id)}/relations/${kebab(key)}\`, params as Record<string, unknown>, options),`,
      );
    }
    out.push('  },');
  }
  out.push('};');
  out.push('');
  out.push(`/** 详情查询 hook：响应也用 schema 校验；范围外返回 NOT_FOUND */`);
  out.push(
    `export const use${N} = (id: string) => useCageQuery(['${kebab(N)}', id], \`/api/${kebab(N)}/\${encodeURIComponent(id)}\`, ${N}Schema, { enabled: !!id });`,
  );
  out.push(`/** 列表查询 hook：走读侧账号与安全视图 */`);
  out.push(
    `export const use${N}List = (params: ${N}ListParams = {}) => useCageList(['${kebab(N)}'], '/api/${kebab(N)}', params as Record<string, unknown>, ${N}Schema);`,
  );
  for (const [key, field] of relations) {
    out.push(`/** ${field.description ?? key}：独立分页缓存，命令成功后使所属对象缓存失效。 */`);
    out.push(
      `export const use${N}Related${upperFirst(key)} = (id: string, params: ${field.ref}ListParams = {}) => useCageList(['${kebab(N)}', id, 'relations', '${key}'], \`/api/${kebab(N)}/\${encodeURIComponent(id)}/relations/${kebab(key)}\`, params as Record<string, unknown>, ${field.ref}Schema, { enabled: !!id });`,
    );
  }
  out.push(`/** 查询缓存键前缀：命令成功后让它失效 */`);
  out.push(
    `export const ${m}Keys = { all: ['${kebab(N)}'] as const, one: (id: string) => ['${kebab(N)}', id] as const };`,
  );
  return out.join('\n') + '\n';
}

export function queriesFile(reg: Registry): string {
  const out: string[] = [
    HEADER,
    `import { z } from 'zod';`,
    `import { client, useCageQuery, type RequestOptions } from '@yss123/cage-client';`,
    '',
  ];
  out.push('/** 查询输入 */');
  out.push('export const QueryInputs = {');
  for (const q of reg.queries) out.push(`  ${q.name}: ${zodCodeOf(q.input)},`);
  out.push('};');
  out.push('');
  out.push('export const queries = {');
  for (const q of reg.queries) {
    out.push(
      `  /** ${q.description ?? q.name}（需要 ${q.reads.map((r) => `${r.name}.read`).join('、')}） */`,
    );
    out.push(
      `  ${q.name}: (input: z.input<typeof QueryInputs.${q.name}> = {} as any, options: RequestOptions = {}) => client.get<Record<string, unknown>[]>('/api/queries/${kebab(q.name)}', input as Record<string, unknown>, options),`,
    );
  }
  out.push('};');
  out.push('');
  for (const q of reg.queries) {
    out.push(
      `export const use${upperFirst(q.name)} = (input: z.input<typeof QueryInputs.${q.name}> = {} as any) => useCageQuery<Record<string, unknown>[]>(['query', '${q.name}'], '/api/queries/${kebab(q.name)}', undefined, { query: input as Record<string, unknown> });`,
    );
  }
  return out.join('\n') + '\n';
}

export function indexFile(reg: Registry): string {
  const caps = reg.capabilityCatalog().map((c) => c.capability);
  const out: string[] = [HEADER];
  for (const a of reg.aggregates) out.push(`export * from './aggregates/${kebab(a.name)}';`);
  out.push(`export * from './queries';`);
  out.push(`import { can as baseCan, useCan as baseUseCan } from '@yss123/cage-client';`);
  for (const a of reg.aggregates)
    out.push(`import { ${a.name}Inputs } from './aggregates/${kebab(a.name)}';`);
  out.push(
    `export { client, configureClient, loadMe, currentUser, CageQueryError, CageCommandError, useTransfer, useFileUpload, FileUploadError, type FileUploadTask, type FileUploadSnapshot, type UploadSession, type FileInfo, type RequestOptions, type CageResult, type CommonError, type TransferTask, type ImportReport } from '@yss123/cage-client';`,
  );
  out.push('');
  out.push('/** 能力目录（由代码派生）：写错能力点名会编译失败 */');
  out.push(`export const capabilities = [\n${caps.map((c) => `  '${c}',`).join('\n')}\n] as const;`);
  out.push('export type Capability = (typeof capabilities)[number];');
  out.push('');
  out.push('/** 当前用户有没有某个能力点。只影响界面显示：绕过前端直接调接口，内核一样会拒绝 */');
  out.push('export const can = (capability: Capability): boolean => baseCan(capability);');
  out.push('export const useCan = (capability: Capability): boolean => baseUseCan(capability);');
  out.push('');
  out.push('/** 各聚合的命令输入 schema：按聚合名、命令名访问，可直接供表单库校验 */');
  out.push(
    `export const schemas = {\n${reg.aggregates.map((a) => `  ${a.name}: ${a.name}Inputs,`).join('\n')}\n};`,
  );
  return out.join('\n') + '\n';
}

export function contractsFiles(reg: Registry, sites: DeclSite[]): Record<string, string> {
  const files: Record<string, string> = {};
  // 路径只取稳定的聚合名，不依赖后端文件位置；移动领域模块不会改变前端公共 API。
  // 根 index 保留统一导出，业务仍从 @app/contracts 引入，不绑定生成目录内部结构。
  for (const a of reg.aggregates)
    files[`aggregates/${kebab(a.name)}/index.ts`] = aggregateFile(reg, a, sites);
  files['queries/index.ts'] = queriesFile(reg);
  files['index.ts'] = indexFile(reg);
  return files;
}
