/**
 * 把注册表与运行时本体编译为当前主体可见、可校验的模型工具。
 * 请求规划器选择完整定义，运行时按 effect 执行读、写、交互、发现或裁决；工具调用不会绕过内核安全读、领域命令、审批身份或动作回执事务。
 */
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

/**
 * 模型工具的服务端可执行定义；公开 JSON Schema 与真实 Zod 校验同时保留。
 * effect 决定运行时是否确认、暂停或在事务内完成；模型只看到名称、说明和 input，不获得 execute 函数或数据库连接。
 */
export interface Tool extends ModelTool {
  /**
   * 可选业务本体 key，供发现和预算选择；基础工具没有 key。
   */
  key?: string;
  /**
   * 真实执行前的输入 schema，与发送给模型的 JSON Schema 对应。
   */
  schema: z.ZodType;
  /**
   * 副作用分类：读、写、用户互动、审批裁决或工具发现/加载。
   */
  effect: 'read' | 'write' | 'interaction' | 'decision' | 'load' | 'discover';
  /**
   * 执行已解析参数；写工具要求运行时传入动作事务，读取工具通常不使用该事务。
   */
  execute(execution: Execution, args: any, tx?: Transaction<any>): Promise<unknown>;
  /**
   * 可选写入确认预览；应重新取当前可见事实并掩码，不在预览阶段提交业务变化。
   */
  preview?(execution: Execution, args: any): Promise<unknown>;
}
/**
 * 工具参数通用标识符校验，与 params 共同构成基础输入片段。
 * 名称长度为 1 至 160 字符；params 是默认空对象的参数字典，具体字段合法性由被调用内核读接口继续校验。
 */
const name = z.string().min(1).max(160),
  params = z.record(z.string(), z.unknown()).default({});
/**
 * 本体与证据目录的分页输入，offset 为零基，单页默认 10 项、最多 20 项。
 * 这是目录/证据页限制，不替代业务列表和命名查询各自的行数边界。
 */
const paging = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20).default(10),
};
/**
 * 严格的本体搜索输入：允许最长 500 字符关键词、可选聚合筛选和有界分页；空关键词用于浏览目录。
 */
const searchSchema = z
  .object({ query: z.string().max(500).default(''), aggregate: name.optional(), ...paging })
  .strict();
/**
 * 从已注册 ROUTE 扩展解析进程内审批引擎，供待办、历史与审核工具复用。
 * 只发现框架已注册引擎，不创建外部审批权限，也不按模型任意字符串动态加载实现。
 */
export function engines(execution: Pick<Execution, 'kernel'>): InCodeEngine[] {
  return execution.kernel.registry.extensions
    .filter((e) => e.kind === 'ROUTE')
    .map((e) => e.value.engine(execution.kernel));
}
/**
 * 按 Zod 实例缓存 JSON Schema，避免每轮重复转换完整参数定义；弱引用不会永久保留已废弃声明。
 */
const inputDefinitions = new WeakMap<z.ZodType, Record<string, unknown>>();
/**
 * 按命令声明对象缓存 input/expectedVersion 包装 schema；真实执行仍校验当前命令状态、权限与版本。
 */
const commandSchemas = new WeakMap<object, z.ZodType>();
/**
 * 把名称、说明、Zod schema 和服务端执行/预览函数组合为 Tool。
 * JSON Schema 用于模型理解输入，真实 Zod schema 继续在执行前校验；转换缓存不等于校验缓存或授权缓存。
 */
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
/**
 * 按当前运行模式、主体权限和持久工具选择生成工具集合。
 * 助理可取本体、安全读、已加载业务命令/查询、本人审批及交互/偏好工具；审批仅有上下文读取、策略白名单查询和 review_decide，不获得通用业务写入口。
 * 命名查询要求所有 reads 能力并最多交付 200 行；业务写必须同动作回执事务执行，更新已有对象必须带 expectedVersion，确认预览重新读取并掩码。
 * 发现/加载只产出候选，容量由请求规划器决定；工具名校验、当前授权和内核约束仍在每次实际动作中执行。
 */
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
  // 查询同时受 reads 能力与审批策略白名单限制；助理还要求完整 schema 已装载，搜索命中不等于当前已可执行。
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
  // 只暴露用户身份入口。命令 schema 加 expectedVersion 包装，真实写入复用内核流水线并与持久动作回执同事务。
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
  // 本人待办仍需逐个确认业务对象可读；不可读项被省略，不能用空列表推断整个审批流程不存在。
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
      comment: z.string().max(1000).optional(),
      // 将用户确认绑定到待办版本；不能在执行时自动换成最新版本而让旧确认批准转回来的新任务。
      expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict();
  tools.push(
    define(
      'approval_decide',
      '对本人待办通过、拒绝或退回修改；携带 approval_tasks 返回的 revision 作为 expectedRevision，委派未归还时不能决定。',
      taskSchema,
      'write',
      async (e, a, tx) => {
        const engine = engines(e).find((v) => v.route.process === a.process);
        if (!engine || !tx) throw cageError('NOT_FOUND');
        return engine.decideIn(tx, a.taskId, e.ctx.userId!, e.ctx.tenantId, a.outcome, a.comment, a.expectedRevision);
      },
      async (e, a) => {
        const engine = engines(e).find((v) => v.route.process === a.process);
        const task = (await engine?.tasksOf(e.ctx.userId!, e.ctx.tenantId))?.find((t) => t.id === a.taskId);
        if (!task) throw cageError('NOT_FOUND');
        if (task.delegation === 'pending') throw cageError('INVALID_TRANSITION');
        if ((task.assignment === 'candidate' || Object.values(task.actions).some(Boolean)) && a.expectedRevision === undefined) throw cageError('INVALID_INPUT');
        if (a.expectedRevision !== undefined && a.expectedRevision !== task.revision) throw cageError('CONFLICT');
        return {
          process: a.process,
          taskId: a.taskId,
          outcome: a.outcome,
          comment: a.comment,
          expectedRevision: a.expectedRevision,
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
  // 偏好按当前用户隔离并始终要求运行时确认。内容用途由工具说明约束，schema 只限制长度，不声称具有敏感语义识别能力。
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

/**
 * 按本轮实际工具列表精确匹配模型名称，再用工具的 Zod schema 解析参数。
 * 未知或当前无权工具返回 FORBIDDEN，参数错误返回稳定输入错误；不允许模型直接指向任意导出函数。
 */
export function checkedTool(tools: Tool[], name: string, input: unknown): { tool: Tool; args: any } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw cageError('FORBIDDEN', '工具未注册或当前主体无权调用');
  return { tool, args: parse(tool.schema, input) };
}
