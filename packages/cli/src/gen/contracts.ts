// 前端契约（packages/contracts）：每个聚合一个文件——字段 schema、错误码类型、调用方法和查询 hooks。
// 前端只能从这里引入，所以调用方式、参数、错误码都有类型检查。
import {
  kebab,
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
  const out: string[] = [HEADER];
  out.push(`import { z } from 'zod';`);
  out.push(`import { client, useCageList, useCageQuery } from '@yss123/cage-client';`);
  out.push('');
  out.push(`/** ${a.description ?? N}：读侧快照（敏感字段是按权限掩码后的值） */`);
  out.push(`export const ${N}Schema = ${snapshotCode(a.fields as Fields, a.states.values)};`);
  out.push(`export type ${N} = z.infer<typeof ${N}Schema>;`);
  out.push(`export type ${N}Status = ${N}['status'];`);
  out.push(`export const ${N}States = [${a.states.values.map((s) => `'${s}'`).join(', ')}] as const;`);
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
    .filter(([, f]) => !f.isHidden && f.sql !== 'jsonb' && !f.sensitiveKind)
    .map(([k]) => k);
  const sortKeys = [
    'createdAt',
    'updatedAt',
    ...Object.entries(a.fields as Fields)
      .filter(([, f]) => !f.isHidden && f.sql !== 'jsonb')
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
        `${desc}  ${c.name}: (input: z.input<typeof ${N}Inputs.${c.name}>) => client.post<${N}, ${E}>(${url}, input),`,
      );
    } else if (isIdOnly(c)) {
      out.push(
        `${desc}  ${c.name}: (id: string, expectedVersion?: number) => client.post<${N}, ${E}>(${url}, { expectedVersion }),`,
      );
    } else {
      out.push(
        `${desc}  ${c.name}: (id: string, input: Omit<z.input<typeof ${N}Inputs.${c.name}>, 'id'>, expectedVersion?: number) => client.post<${N}, ${E}>(${url}, { ...input, expectedVersion }),`,
      );
    }
  }
  out.push(`  /** 导出 CSV：需要 ${N}.export 能力 */`);
  out.push(
    `  export: (params: ${N}ListParams = {}) => client.post<string, never>('/api/${kebab(N)}/export', params),`,
  );
  out.push(`  get: (id: string) => client.get<${N}>(\`/api/${kebab(N)}/\${encodeURIComponent(id)}\`),`);
  out.push(
    `  list: (params: ${N}ListParams = {}) => client.get<{ items: ${N}[]; total: number; page: number; pageSize: number }>('/api/${kebab(N)}', params as Record<string, unknown>),`,
  );
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
    `import { client, useCageQuery } from '@yss123/cage-client';`,
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
      `  ${q.name}: (input: z.input<typeof QueryInputs.${q.name}> = {} as any) => client.get<Record<string, unknown>[]>('/api/queries/${kebab(q.name)}', input as Record<string, unknown>),`,
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
  for (const a of reg.aggregates) out.push(`export * from './${kebab(a.name)}';`);
  out.push(`export * from './queries';`);
  out.push(`import { can as baseCan, useCan as baseUseCan } from '@yss123/cage-client';`);
  for (const a of reg.aggregates) out.push(`import { ${a.name}Inputs } from './${kebab(a.name)}';`);
  out.push(
    `export { client, configureClient, loadMe, currentUser, CageQueryError, type CageResult, type CommonError } from '@yss123/cage-client';`,
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
  out.push('/** 各聚合的命令输入 schema：schemas.PurchaseOrder.create 可以直接给表单库做校验 */');
  out.push(
    `export const schemas = {\n${reg.aggregates.map((a) => `  ${a.name}: ${a.name}Inputs,`).join('\n')}\n};`,
  );
  return out.join('\n') + '\n';
}

export function contractsFiles(reg: Registry, sites: DeclSite[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const a of reg.aggregates) files[`${kebab(a.name)}.ts`] = aggregateFile(reg, a, sites);
  files['queries.ts'] = queriesFile(reg);
  files['index.ts'] = indexFile(reg);
  return files;
}
