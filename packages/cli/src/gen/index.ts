// cage gen：从声明生成 contracts、路由清单、安全视图与策略 DDL、迁移草稿、状态图、本体图。
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isRelation, kebab, type Fields, type Registry } from '@yss123/cage-kernel';
import {
  createTableSql,
  diffSchemas,
  embedSnapshot,
  latestSnapshot,
  readMigrations,
  safeLayerSql,
  schemaModel,
} from '@yss123/cage-kernel/db';
import { abs, type CageConfig } from '../config.js';
import type { Finding } from '../findings.js';
import { statesHoldingResources } from '../rules.js';
import type { Ontology } from '../ontology.js';
import type { DeclSite } from '../static-check.js';
import { contractsFiles } from './contracts.js';
import { runtimeOntology } from '@yss123/cage-ontology';
import { schemaDiagnostics } from './zod-code.js';

export function stateDiagram(g: Ontology, agg: string): string {
  const lines = ['stateDiagram-v2'];
  const states = g.nodes.filter((n) => n.kind === 'state' && n.id.startsWith(`${agg}.`));
  const short = (id: string) => id.slice(agg.length + 1);
  for (const t of g.edges.filter((e) => e.kind === 'transition' && e.to.startsWith(`${agg}.`))) {
    const from = t.from.endsWith('.[new]') ? '[*]' : short(t.from);
    lines.push(`  ${from} --> ${short(t.to)} : ${t.via!.slice(agg.length + 1)}`);
  }
  for (const s of states) if (s.attrs.terminal) lines.push(`  ${short(s.id)} --> [*]`);
  for (const h of statesHoldingResources(g).filter((x) => x.state.startsWith(`${agg}.`))) {
    lines.push(`  note right of ${short(h.state)} : 持有 ${h.resource}`);
  }
  return lines.join('\n') + '\n';
}

export interface GenResult {
  written: string[];
  findings: Finding[];
  migrationDraft?: string;
}

function writeIf(
  path: string,
  content: string,
  check: boolean,
  written: string[],
  findings: Finding[],
  code = 'CAGE-GEN-001',
) {
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (cur === content) return;
  if (check) {
    findings.push({
      code,
      at: path,
      reason: '生成物和声明不一致（有人手改了生成物，或声明改了没有重新生成）',
      fix: '运行 cage gen，并提交生成结果',
    });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  written.push(path);
}

/**
 * 升级目录布局或删除聚合后，旧契约不能继续留在包里参与编译和导出。
 * 只清理由生成器签名标记的文件；用户自己添加的代码不属于生成器的删除范围。
 * check 仅报告，不写文件，因此 CI 不会悄悄“修正”待审查的工作区。
 */
function removeStaleContracts(
  root: string,
  expected: Record<string, string>,
  check: boolean,
  written: string[],
  findings: Finding[],
) {
  if (!existsSync(root)) return;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.name.endsWith('.ts') &&
        !(relative(root, path).replace(/\\/g, '/') in expected) &&
        readFileSync(path, 'utf8').startsWith('// 生成物：由 cage gen 从 domain 声明生成，不要手改。')
      ) {
        if (check)
          findings.push({
            code: 'CAGE-GEN-001',
            at: path,
            reason: '存在已过期的生成契约（聚合已删除或生成目录布局已更新）',
            fix: '运行 cage gen 清理旧生成文件，并提交目录变更',
          });
        else {
          unlinkSync(path);
          written.push(path);
        }
      }
    }
  };
  visit(root);
}

export function generate(
  cfg: CageConfig,
  reg: Registry,
  g: Ontology,
  sites: DeclSite[],
  opts: { check?: boolean } = {},
): GenResult {
  const check = !!opts.check;
  const written: string[] = [];
  const findings: Finding[] = [];
  const gen = abs(cfg, cfg.generated);
  for (const entry of [...reg.commands.map(c => ({ name: c.capability, input: c.cmd.input })), ...reg.queries.map(q => ({ name: q.name, input: q.input }))])
    for (const diagnostic of schemaDiagnostics(entry.input)) findings.push({
      code: 'CAGE-GEN-003', severity: 'warning', at: `${entry.name}:${diagnostic.path}`,
      reason: diagnostic.reason, fix: '前端校验只提供即时提示，以服务端命令校验为准；不要复制可执行函数到契约。',
    });

  // 不入库的生成物：直接覆盖（check 模式不比较）
  if (!check) {
    const put = (rel: string, content: string) => {
      const p = join(gen, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      written.push(p);
    };
    mkdirSync(abs(cfg, '.cage'), { recursive: true });
    writeFileSync(abs(cfg, '.cage/ontology.json'), JSON.stringify(g, null, 2));
    const model = schemaModel(reg);
    put(
      'sql/schema.sql',
      `-- 生成物：期望的表结构（不要手改）\n\n${model.tables.map(createTableSql).join('\n\n')}\n`,
    );
    put(
      'sql/safe-layer.sql',
      `-- 生成物：安全层（函数、行级策略、安全视图），cage migrate 每次整体重建\n${safeLayerSql(reg)}\n`,
    );
    put('capabilities.json', JSON.stringify(reg.capabilityCatalog(), null, 2));
    put('ai/ontology.json', JSON.stringify(runtimeOntology(reg), null, 2));
    put('routes.json', JSON.stringify(routes(reg), null, 2));
    const md = ['# 状态图（生成物）', ''];
    for (const a of reg.aggregates) {
      const d = stateDiagram(g, a.name);
      put(`diagrams/${a.name}.mmd`, d);
      md.push(`## ${a.description ?? a.name}（${a.name}）`, '', '```mermaid', d.trimEnd(), '```', '');
    }
    put('diagrams/README.md', md.join('\n'));
  }

  // 入库的生成物：前端契约
  const files = contractsFiles(reg, sites);
  removeStaleContracts(abs(cfg, cfg.contracts), files, check, written, findings);
  for (const [name, content] of Object.entries(files))
    writeIf(join(abs(cfg, cfg.contracts), name), content, check, written, findings);

  // 迁移草稿：声明的期望结构 vs 最后一个迁移里内嵌的结构快照
  const dir = abs(cfg, cfg.migrations);
  const migrations = readMigrations(dir);
  const model = schemaModel(reg);
  const stmts = diffSchemas(latestSnapshot(migrations), model);
  let migrationDraft: string | undefined;
  if (stmts.length > 0) {
    if (check) {
      findings.push({
        code: 'CAGE-GEN-002',
        at: cfg.migrations,
        reason: `声明的表结构与迁移不一致（${stmts.length} 处变化）`,
        fix: '运行 cage gen 生成迁移草稿，人审后提交',
      });
    } else {
      const n = String(migrations.length + 1).padStart(4, '0');
      const name = `${n}_${migrations.length === 0 ? 'init' : 'draft'}.sql`;
      const body = [
        `-- 迁移草稿：由 cage gen 生成，人审后提交；已发布的迁移不要修改`,
        `-- 破坏性变更按「先扩展再收缩」分多次发布`,
        '',
        stmts.join('\n\n'),
      ].join('\n');
      mkdirSync(dir, { recursive: true });
      migrationDraft = join(dir, name);
      writeFileSync(migrationDraft, embedSnapshot(body, model));
      written.push(migrationDraft);
    }
  }
  return { written, findings, migrationDraft };
}

export function routes(reg: Registry) {
  const out: { method: string; url: string; capability: string }[] = [
    { method: 'POST', url: '/api/sys/uploads', capability: '目标用户命令能力及字段限制' },
    { method: 'GET', url: '/api/sys/uploads', capability: '本人会话及目标命令能力' },
    { method: 'GET', url: '/api/sys/uploads/:id', capability: '本人会话及目标命令能力' },
    { method: 'POST', url: '/api/sys/uploads/:id/parts/:number', capability: '本人会话及目标命令能力' },
    { method: 'POST', url: '/api/sys/uploads/:id/complete', capability: '本人会话及目标命令能力' },
    { method: 'POST', url: '/api/sys/uploads/:id/cancel', capability: '本人会话及目标命令能力' },
    { method: 'GET', url: '/api/sys/files/:id', capability: '所属对象 read/范围；临时文件限本人' },
    { method: 'GET', url: '/api/sys/files/:id/download', capability: '所属对象 read/范围；临时文件限本人' },
  ];
  for (const c of reg.commands) {
    if (!c.cmd.invokedBy.includes('user')) continue;
    const base = `/api/${kebab(c.cmd.agg.name)}`;
    out.push({
      method: 'POST',
      url: c.cmd.from === 'new' ? `${base}/${kebab(c.name)}` : `${base}/:id/${kebab(c.name)}`,
      capability: c.capability,
    });
  }
  for (const a of reg.aggregates) {
    const base = `/api/${kebab(a.name)}`;
    out.push(
      { method: 'GET', url: base, capability: `${a.name}.read` },
      { method: 'GET', url: `${base}/:id`, capability: `${a.name}.read` },
      { method: 'POST', url: `${base}/export`, capability: `${a.name}.export` },
    );
    for (const [key, field] of Object.entries(a.fields as Fields))
      if (isRelation(field))
        out.push({
          method: 'GET',
          url: `${base}/:id/relations/${kebab(key)}`,
          capability: [...new Set([`${a.name}.read`, `${field.ref}.read`])].join(','),
        });
  }
  for (const q of reg.queries)
    out.push({
      method: 'GET',
      url: `/api/queries/${kebab(q.name)}`,
      capability: q.reads.map((r) => `${r.name}.read`).join(' + '),
    });
  for (const e of reg.extensions)
    if (e.kind === 'INBOUND')
      out.push({
        method: 'POST',
        url: `/hooks/${e.value.connector.name}/${kebab(e.value.event)}`,
        capability: `验签 ${e.value.verify.secret}`,
      });
  if (reg.extensions.some(e => e.kind === 'RUNTIME' && e.value.name === 'ai')) {
    for (const [method, url] of [['GET', '/api/ai/sessions'], ['POST', '/api/ai/sessions'], ['GET', '/api/ai/sessions/:id/runs'],
      ['POST', '/api/ai/sessions/:id/messages'], ['GET', '/api/ai/runs/:id'], ['GET', '/api/ai/runs/:id/events'],
      ['POST', '/api/ai/runs/:id/cancel'], ['POST', '/api/ai/runs/:id/interactions/:interactionId'], ['GET', '/api/ai/memory'], ['DELETE', '/api/ai/memory/:id'],
      ['GET', '/api/ai/personalities'], ['POST', '/api/ai/sessions/:id/personality']])
      out.push({ method, url, capability: 'Sys.ai.use' });
    for (const [method, url] of [['GET', '/api/ai/admin/models'], ['POST', '/api/ai/admin/models/:key'], ['POST', '/api/ai/admin/models/:key/test']])
      out.push({ method, url, capability: 'Sys.ai.models.manage' });
    for (const [method, url] of [['GET', '/api/ai/admin/personalities'], ['POST', '/api/ai/admin/personalities/:key'],
      ['POST', '/api/ai/admin/assistant-settings'], ['POST', '/api/ai/admin/personality-preview']])
      out.push({ method, url, capability: 'Sys.ai.personalities.manage' });
  }
  return out;
}
