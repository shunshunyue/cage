import { cageError, present, type Ctx } from '@yss123/cage-kernel';
import { type InCodeEngine } from '@yss123/cage-approval';
import { ontologyCatalog } from '@yss123/cage-ontology';
import { aiDecisionSchema, queryPlanSchema } from '@yss123/cage-ai-protocol';
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Execution, ModelTool } from './types.js';
import { queryPlan } from './query.js';
import { digest, parse } from './security.js';
import { authorizedToolKeys, callable, loadToolKeys } from './tool-catalog.js';
import { readContext } from './context-read.js';

export interface Tool extends ModelTool {
  key?: string;
  schema: z.ZodType;
  effect: 'read' | 'write' | 'interaction' | 'decision' | 'load' | 'discover';
  execute(execution: Execution, args: any, tx?: Transaction<any>): Promise<unknown>;
  preview?(execution: Execution, args: any): Promise<unknown>;
}
const name = z.string().min(1).max(160),
  params = z.record(z.string(), z.unknown()).default({});
const paging = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20).default(10),
};
const searchSchema = z
  .object({ query: z.string().max(500).default(''), aggregate: name.optional(), ...paging })
  .strict();
export function engines(execution: Pick<Execution, 'kernel'>): InCodeEngine[] {
  return execution.kernel.registry.extensions
    .filter((e) => e.kind === 'ROUTE')
    .map((e) => e.value.engine(execution.kernel));
}
const inputDefinitions = new WeakMap<z.ZodType, Record<string, unknown>>();
const commandSchemas = new WeakMap<object, z.ZodType>();
function define(
  name: string,
  description: string,
  schema: z.ZodType,
  effect: Tool['effect'],
  execute: Tool['execute'],
  preview?: Tool['preview'],
): Tool {
  let input = inputDefinitions.get(schema);
  if (!input) {
    input = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    inputDefinitions.set(schema, input);
  }
  return { name, description, schema, effect, execute, preview, input };
}

/** 注册声明编译成工具；应用无需为每个业务对象重新实现工具。当前权限决定每轮可见目录。 */
export function toolsFor(execution: Execution, selection?: { keys: string[]; discovery: boolean }): Tool[] {
  const { kernel, ctx, run, ontology } = execution,
    review = run.mode === 'approval';
  const selected = new Set(selection?.keys ?? run.tool_keys ?? []);
  // 动作执行使用模型调用前持久化的选择，不能在执行中重算并意外撤掉已提供的工具。
  const needsDiscovery =
    !review &&
    (selection?.discovery ??
      (run.tool_plan ? run.tool_plan.mode === 'discovery' : selected.size < authorizedToolKeys(execution).length));
  const tools: Tool[] = [];
  tools.push(
    define(
      'context_read',
      '按引用取回已收起的完整页面、工具回执或会话。先列目录，再用 runId/ref/path 和分页展开；不重新执行业务操作。',
      z
        .object({
          source: z.enum(['context', 'action', 'conversation']),
          runId: z.uuid().optional(),
          ref: z.uuid().optional(),
          path: z
            .array(z.union([name, z.number().int().nonnegative()]))
            .max(16)
            .default([]),
          ...paging,
        })
        .strict(),
      'read',
      readContext,
    ),
  );
  if (!review) {
    tools.push(
      define(
        'ontology_search',
        '检索当前权限内的本体摘要，空 query 分页浏览目录。未命中可缩短关键词；详细规则用 ontology_describe 展开。',
        searchSchema,
        'read',
        async (_e, a) => ontologyCatalog(ontology).search(ctx, a),
      ),
    );
    tools.push(
      define(
        'ontology_describe',
        '按本体 key 查看完整规则、字段、参数或关联节点。字段与关系可分页；不会把未返回的部分当作不存在。',
        z
          .object({
            key: name,
            section: z.enum(['overview', 'fields', 'input', 'related']).default('overview'),
            ...paging,
          })
          .strict(),
        'read',
        async (_e, a) => ontologyCatalog(ontology).describe(ctx, a.key, a.section, a.offset, a.limit),
      ),
    );
    if (needsDiscovery) {
      tools.push(
        define(
          'tool_search',
          '检索可用业务命令和查询，支持分页。命中的候选会在预算内自动加载完整参数，下一轮即可调用；以回执 loaded 为准，未命中可缩短关键词或分页浏览。',
          searchSchema,
          'discover',
          async (_e, a) => ontologyCatalog(ontology).search(ctx, a, callable),
        ),
      );
      tools.push(
        define(
          'tool_load',
          '已知本体 key 时显式加载完整业务工具定义。搜索已自动加载的工具无需再次加载；完整参数超出预算时需减少 keys。',
          z.object({ keys: z.array(name).min(1).max(128) }).strict(),
          'load',
          async (e, a) => loadToolKeys(e, a.keys),
        ),
      );
    }
    tools.push(
      define(
        'data_get',
        '按聚合名和 ID 读取当前权限内的对象。',
        z.object({ aggregate: name, id: z.uuid() }).strict(),
        'read',
        (e, a) => kernel.read.get(a.aggregate, a.id, e.ctx),
      ),
    );
    tools.push(
      define(
        'data_list',
        '按声明字段过滤并分页读取；默认 20 条，最多 200 条。',
        z.object({ aggregate: name, params }).strict(),
        'read',
        (e, a) => kernel.read.list(a.aggregate, a.params, e.ctx),
      ),
    );
    tools.push(
      define(
        'data_related',
        '按字段声明分页读取关联对象。',
        z.object({ aggregate: name, id: z.uuid(), field: name, params }).strict(),
        'read',
        (e, a) => kernel.read.related(a.aggregate, a.id, a.field, a.params, e.ctx),
      ),
    );
    tools.push(
      define('data_query', '执行有限查询计划，支持范围过滤和统计，不接受 SQL。', queryPlanSchema, 'read', (e, a) =>
        queryPlan(kernel, e.ctx, a),
      ),
    );
  }
  for (const query of kernel.registry.queries) {
    if (
      !query.reads.every((agg) => ctx.capabilities.has(`${agg.name}.read`)) ||
      (review && !run.policy.context.queries?.includes(query.name))
    )
      continue;
    if (!review && !selected.has(`query:${query.name}`)) continue;
    tools.push(
      define(
        `query_${digest(query.name).slice(0, 16)}`,
        `${query.name}: ${query.description ?? '已声明查询'}`,
        query.input,
        'read',
        async (e, a) => {
          const rows = await kernel.read.run(query, a, e.ctx);
          return { source: `query:${query.name}`, rows: rows.slice(0, 200), truncated: rows.length > 200, limit: 200 };
        },
      ),
    );
    tools[tools.length - 1].key = `query:${query.name}`;
  }
  if (review) {
    tools.push(
      define(
        'review_decide',
        '完成本审批节点：pass 通过，return 退回修改，manual 转人工。须说明理由并引用 subject 或已执行的 query:名称。',
        aiDecisionSchema,
        'decision',
        async (_e, a) => a,
      ),
    );
    return tools;
  }
  for (const command of kernel.registry.commands) {
    if (!command.cmd.invokedBy.includes('user') || !ctx.capabilities.has(command.capability)) continue;
    if (!selected.has(`command:${command.capability}`)) continue;
    let schema = commandSchemas.get(command.cmd);
    if (!schema) {
      schema = z.object({ input: command.cmd.input, expectedVersion: z.number().int().positive().optional() }).strict();
      commandSchemas.set(command.cmd, schema);
    }
    tools.push(
      define(
        `command_${digest(command.capability).slice(0, 16)}`,
        `${command.capability}: ${command.cmd.description ?? '领域命令'}。修改现有对象必须提供读取到的 expectedVersion。`,
        schema,
        'write',
        async (e, a, tx) => {
          if (!tx) throw new Error('命令必须与动作回执在同一事务执行');
          if (command.cmd.from !== 'new' && !a.expectedVersion)
            throw cageError('INVALID_INPUT', '修改需要 expectedVersion');
          return kernel.executePresentedIn(
            tx,
            command.cmd,
            { ...a.input, expectedVersion: a.expectedVersion },
            { ...e.ctx, idempotencyKey: undefined },
          );
        },
        async (e, a) => {
          if (command.cmd.from !== 'new' && !a.expectedVersion)
            throw cageError('INVALID_INPUT', '修改需要 expectedVersion');
          const subject = command.cmd.from !== 'new' ? await kernel.read.get(command.cmd.agg, a.input.id, e.ctx) : null;
          if (subject && subject.version !== a.expectedVersion) throw cageError('CONFLICT');
          return {
            command: command.capability,
            input: present(command.cmd.agg, a.input, e.ctx),
            expectedVersion: a.expectedVersion,
            subject,
          };
        },
      ),
    );
    tools[tools.length - 1].key = `command:${command.capability}`;
  }
  // 进度查询面向可读单据，不能拿“本人待办为空”推断流程已结束或尚未开始。
  tools.push(
    define(
      'approval_history',
      '查询可读业务对象的审批进度、当前步骤、历史轮次及可见审核理由。询问单据到哪一步时使用；本人没有待办也能查看有权读取的单据进度。',
      z.object({ aggregate: name, id: z.uuid() }).strict(),
      'read',
      async (e, a) => {
        await kernel.read.get(a.aggregate, a.id, e.ctx);
        return (await Promise.all(engines(e).map((engine) => engine.history(a.aggregate, a.id, e.ctx))))
          .flat()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
    ),
  );
  tools.push(
    define(
      'approval_tasks',
      '读取当前用户的待办；决定必须通过 approval_decide。',
      z.object({}).strict(),
      'read',
      async (e) => {
        const result = [];
        for (const engine of engines(e))
          for (const task of await engine.tasksOf(e.ctx.userId!, e.ctx.tenantId)) {
            try {
              const record = await kernel.read.get(task.aggregate, task.businessKey, e.ctx);
              result.push({ ...task, vars: undefined, record });
            } catch (error: any) {
              if (!['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) throw error;
            }
          }
        return result;
      },
    ),
  );
  const taskSchema = z
    .object({
      process: name,
      taskId: z.uuid(),
      outcome: z.enum(['approved', 'rejected', 'returned']),
      comment: z.string().max(2000).optional(),
    })
    .strict();
  tools.push(
    define(
      'approval_decide',
      '对本人待办通过、拒绝或退回修改；不能代替他人。',
      taskSchema,
      'write',
      async (e, a, tx) => {
        const engine = engines(e).find((v) => v.route.process === a.process);
        if (!engine || !tx) throw cageError('NOT_FOUND');
        return engine.decideIn(tx, a.taskId, e.ctx.userId!, e.ctx.tenantId, a.outcome, a.comment);
      },
      async (e, a) => {
        const engine = engines(e).find((v) => v.route.process === a.process);
        const task = (await engine?.tasksOf(e.ctx.userId!, e.ctx.tenantId))?.find((t) => t.id === a.taskId);
        if (!task) throw cageError('NOT_FOUND');
        return {
          process: a.process,
          taskId: a.taskId,
          outcome: a.outcome,
          comment: a.comment,
          subject: await kernel.read.get(task.aggregate, task.businessKey, e.ctx),
        };
      },
    ),
  );
  tools.push(
    define(
      'request_input',
      '缺少操作参数或意图不明确时向用户提问并暂停。',
      z.object({ prompt: z.string().min(1).max(2000) }).strict(),
      'interaction',
      async (_e, a) => a,
    ),
  );
  tools.push(
    define(
      'request_page_context',
      '请当前发起页面提供新快照并暂停；跨标签页快照不可替换。',
      z.object({ prompt: z.string().min(1).max(2000) }).strict(),
      'interaction',
      async (_e, a) => a,
    ),
  );
  tools.push(
    define(
      'memory_remember',
      '经用户确认保存表达偏好；不能保存密码、授权或业务查询结果。',
      z.object({ key: z.string().min(1).max(100), value: z.string().min(1).max(1000) }).strict(),
      'write',
      async (e, a, tx) => {
        if (!tx) throw new Error('记忆写入需要动作事务');
        // 多个会话可以并发执行，偏好配额按用户串行核验，避免同时通过最后一个名额。
        await sql`select pg_advisory_xact_lock(hashtext(${e.ctx.tenantId}), hashtext(${e.ctx.userId!}))`.execute(tx);
        const existing = await tx
          .selectFrom('sys.ai_memory')
          .select('id')
          .where('tenant_id', '=', e.ctx.tenantId)
          .where('user_id', '=', e.ctx.userId!)
          .where('key', '=', a.key)
          .executeTakeFirst();
        if (!existing) {
          const count = await tx
            .selectFrom('sys.ai_memory')
            .select('id')
            .where('tenant_id', '=', e.ctx.tenantId)
            .where('user_id', '=', e.ctx.userId!)
            .execute();
          if (count.length >= 50) throw cageError('RATE_LIMITED', '最多保存 50 条偏好');
        }
        await tx
          .insertInto('sys.ai_memory')
          .values({ id: randomUUID(), tenant_id: e.ctx.tenantId, user_id: e.ctx.userId!, ...a })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'user_id', 'key']).doUpdateSet({ value: a.value, updated_at: new Date() }),
          )
          .execute();
        return { remembered: true, key: a.key };
      },
      async (_e, a) => a,
    ),
  );
  return tools;
}

export function checkedTool(tools: Tool[], name: string, input: unknown): { tool: Tool; args: any } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw cageError('FORBIDDEN', '工具未注册或当前主体无权调用');
  return { tool, args: parse(tool.schema, input) };
}
