/**
 * 验证原生 AI 的工具发现、授权过滤与上下文预算。
 * 构造大目录、中文检索和长会话，比较模型请求视图与原始 schema/历史，确保压缩不扩大能力或悄悄截断当前问题。
 * 这些用例只运行内存规划和本体目录，不调用模型服务或数据库。
 */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { aggregate, buildRegistry, command, ref, states, text } from '@yss123/cage-kernel';
import { ontologyCatalog, runtimeOntology } from '@yss123/cage-ontology';
import { toolsFor } from '../../ai/src/tools.js';
import { loadToolKeys } from '../../ai/src/tool-catalog.js';
import { packPrompt, toolTokens, messageTokens } from '../../ai/src/prompt.js';
import { planModelRequest } from '../../ai/src/request-plan.js';
import { DEFAULT_LIMITS, type Execution, type ModelMessage } from '../../ai/src/types.js';

/**
 * 内存模型规格提供固定上下文容量，用于比较工具直传和发现模式；generate 不参与这些规划测试。
 */
const provider = {
  spec: { kind: 'test' },
  contextWindowTokens: 32768,
  generate: async () => ({ text: '', calls: [] }),
};
/**
 * 构造从空历史预算开始的运行状态基底，各例按场景覆盖；null 表示尚未保存模型接续或工具发现计划。
 */
const runDefaults = {
  limits: DEFAULT_LIMITS,
  tokens: 0,
  steps: 0,
  model_attempts: 0,
  history: [{ role: 'user' as const, content: '执行' }],
  context: null,
  model_state: null,
  continuation_disabled_key: null,
  history_omitted: false,
  tool_keys: null,
  tool_plan: null,
  instructions: '',
};

it('1200 个可执行命令按预算发现，候选保留完整参数，目录仍可分页遍历', async () => {
  const Document = aggregate('LargeDocument', { fields: { reason: text() }, states: states('draft') });
  const declarations: Record<string, unknown> = { Document };
  for (let i = 0; i < 1200; i++)
    declarations[`task${i}`] = command(Document, {
      name: `task${i}`,
      from: 'draft',
      to: null,
      description: i === 1199 ? '跨团队交接登记' : `处理第 ${i} 项事务`,
      input: z.object({ id: z.uuid(), reason: z.string().min(15), code: z.enum(['A', 'B']) }),
      handler: (o) => o,
    });
  const registry = buildRegistry(declarations),
    ontology = runtimeOntology(registry);
  const ctx = { capabilities: new Set(['LargeDocument.read', ...registry.commands.map((c) => c.capability)]) } as any;
  const execution = {
    kernel: { registry },
    ontology,
    ctx,
    run: { ...runDefaults, mode: 'assistant', input: '跨团队交接', page_context: null },
    signal: new AbortController().signal,
  } as Execution;
  const plan = planModelRequest(execution, provider),
    initial = plan.tools;
  expect(plan.selection.mode).toBe('discovery');
  expect(plan.keys).toContain('command:LargeDocument.task1199');
  expect(toolTokens(initial)).toBeLessThanOrEqual(plan.selection.tokenBudget);
  const toolBytes = Buffer.byteLength(
    JSON.stringify(initial.map(({ name, description, input }) => ({ name, description, input }))),
  );
  expect(toolBytes).toBeLessThan(20_000);
  expect(Buffer.byteLength(JSON.stringify(ontology))).toBeGreaterThan(toolBytes * 20);
  const catalog = ontologyCatalog(ontology),
    search = catalog.search(ctx, { query: '交接' });
  expect(search.items[0].key).toBe('command:LargeDocument.task1199');
  expect(JSON.stringify(search)).not.toContain('minLength');
  const loaded = loadToolKeys(execution, [search.items[0].key]);
  const tool = toolsFor({ ...execution, run: { ...execution.run, tool_keys: loaded } }).find((t) =>
    t.description.startsWith('LargeDocument.task1199:'),
  )!;
  expect((tool.input.properties as any).input.properties.reason.minLength).toBe(15);
  expect((tool.input.properties as any).input.properties.code.enum).toEqual(['A', 'B']);
  expect((tool.input.properties as any).input.required).toContain('code');
  expect(() => tool.schema.parse({ input: { id: 'bad', reason: '短', code: 'X' } })).toThrow();
  const seen = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = catalog.search(ctx, { kinds: ['command'], offset, limit: 20 });
    page.items.forEach((n) => seen.add(n.key));
    offset = page.nextOffset;
  }
  expect(seen.size).toBe(1200);
});

it('同样 9 个小工具在大窗口全部直传，schema 大小和剩余上下文才触发发现', () => {
  const Document = aggregate('CapacityRecord', { fields: { reason: text() }, states: states('draft') });
  const declarations: Record<string, unknown> = { Document };
  for (let i = 0; i < 9; i++)
    declarations[`task${i}`] = command(Document, {
      name: `task${i}`,
      from: 'draft',
      to: null,
      input: z.object({ id: z.uuid() }),
      handler: (o) => o,
    });
  const registry = buildRegistry(declarations),
    ontology = runtimeOntology(registry);
  const execution = {
    kernel: { registry },
    ontology,
    ctx: { capabilities: new Set(registry.commands.map((c) => c.capability)) },
    run: { ...runDefaults, mode: 'assistant', input: '执行', page_context: { subject: { aggregate: Document.name } } },
    signal: new AbortController().signal,
  } as Execution;
  const large = { ...provider, contextWindowTokens: 131072 };
  const full = planModelRequest(execution, large);
  expect(full.selection.mode).toBe('all');
  expect(full.keys).toHaveLength(9);
  expect(full.tools.some((tool) => tool.name === 'tool_search')).toBe(false);
  const smaller = planModelRequest(execution, large, { maxToolTokens: toolTokens(full.tools) - 300 });
  expect(smaller.selection.mode).toBe('discovery');
  expect(smaller.keys.length).toBeLessThan(9);
  expect(smaller.tools.some((tool) => tool.name === 'tool_search')).toBe(true);
  const busy = planModelRequest(
    {
      ...execution,
      run: {
        ...execution.run,
        history: [{ role: 'user', content: 'x'.repeat(32_000) }],
        limits: { ...DEFAULT_LIMITS, tokenBudget: 16000 },
      },
    },
    large,
  );
  expect(busy.selection.mode).toBe('discovery');
  expect(busy.estimatedInput + busy.outputLimit).toBeLessThanOrEqual(16000);
});

it('Responses 估算不重复计算同一条输出，开启压缩也不能凭空缩减远端历史', () => {
  const content = '完整文本'.repeat(1000);
  const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] };
  const message: ModelMessage = { role: 'assistant', content, providerItems: { key: 'test', items: [item] } };
  expect(messageTokens([message], 'test')).toBe(messageTokens([{ ...message, content: '' }], 'test'));
  const registry = buildRegistry({}),
    ontology = runtimeOntology(registry);
  const execution = {
    kernel: { registry },
    ontology,
    ctx: { capabilities: new Set() },
    run: {
      ...runDefaults,
      mode: 'assistant',
      input: '继续',
      model_state: { key: 'test', responseId: 'remote', historyLength: 0, contextTokens: 31000 },
    },
    signal: new AbortController().signal,
  } as Execution;
  const plan = planModelRequest(execution, { ...provider, continuation: { key: 'test', compaction: true } });
  expect(plan.remote).toBeNull();
});

it('中文相邻词、关系展开和命令权限过滤，允许只有创建能力的用户发现合法输入', () => {
  const Team = aggregate('OtherTeam', { fields: { name: text() } });
  const Document = aggregate('Document', { fields: { reason: text(), team: ref(Team) }, states: states('draft') });
  const create = command(Document, {
    name: 'create',
    description: '登记跨部门交接材料',
    from: 'new',
    to: 'draft',
    handler: (o) => o,
  });
  const process = command(Document, {
    name: 'complete',
    from: 'draft',
    to: null,
    invokedBy: 'process',
    handler: (o) => o,
  });
  const registry = buildRegistry({ Team, Document, create, process }),
    ontology = runtimeOntology(registry),
    catalog = ontologyCatalog(ontology);
  const writer = { capabilities: new Set(['Document.create']) } as any;
  expect(catalog.search(writer, { query: '部门交接' }).items.map((n) => n.id)).toEqual(['Document.create']);
  expect(() => catalog.node(writer, 'aggregate:Document')).toThrow();
  const reader = { capabilities: new Set(['Document.read', 'OtherTeam.read']) } as any;
  expect(catalog.describe(reader, 'aggregate:Document', 'related')).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ key: 'aggregate:OtherTeam' })]),
  });
  expect(catalog.describe(reader, 'aggregate:OtherTeam', 'related')).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ key: 'aggregate:Document' })]),
  });
  expect(catalog.search(reader, { kinds: ['command'] }).total).toBe(0);
  const context = {
    kernel: { registry },
    ctx: { capabilities: new Set(['Document.complete', 'Document.read']) },
    ontology,
    run: { input: '' },
  } as any;
  expect(() => loadToolKeys(context, ['command:Document.complete'])).toThrow();
});

it('长会话只缩小模型视图，保留当前问题和完整的最近工具组，原始历史与 schema 不变', () => {
  const history: ModelMessage[] = [];
  for (let i = 0; i < 6; i++)
    history.push({ role: 'user', content: `旧问题${i}` }, { role: 'assistant', content: '旧资料'.repeat(3000) });
  history.push({ role: 'user', content: '核对最新的凭据编号' });
  for (let i = 0; i < 8; i++)
    history.push(
      { role: 'assistant', content: '', toolCalls: [{ id: `call-${i}`, name: 'data_get', arguments: { id: i } }] },
      {
        role: 'tool',
        toolCallId: `call-${i}`,
        content: JSON.stringify({
          ref: { actionId: `action-${i}` },
          evidence: '原文'.repeat(300),
          code: i === 7 ? 'EXACT-7301' : 'old',
        }),
      },
    );
  const original = JSON.stringify(history),
    tools = [
      {
        name: 'data_get',
        description: '原始说明',
        input: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      },
    ];
  const packed = packPrompt({
    instructions: '必须核对原文',
    context: { page: '当前页面' },
    history,
    tools,
    maxInputTokens: 3500,
  });
  expect(packed.reduced).toBe(true);
  expect(packed.estimatedInput).toBeLessThanOrEqual(3500);
  expect(JSON.stringify(packed.messages)).toContain('核对最新的凭据编号');
  expect(JSON.stringify(packed.messages)).toContain('EXACT-7301');
  for (const message of packed.messages.filter((m) => m.role === 'tool'))
    expect(packed.messages.some((m) => m.toolCalls?.some((c) => c.id === message.toolCallId))).toBe(true);
  expect(JSON.stringify(history)).toBe(original);
  expect(tools[0].input.required).toEqual(['id']);
});

it('窗口过小时明确失败，不截掉当前问题或修改命令的参数定义', () => {
  expect(() =>
    packPrompt({
      instructions: '规则',
      context: {},
      history: [{ role: 'user', content: '不可截断'.repeat(4000) }],
      tools: [],
      maxInputTokens: 1000,
    }),
  ).toThrow('AI_CONTEXT_TOO_LARGE');
  expect(() =>
    packPrompt({
      instructions: '规则',
      context: {},
      history: [{ role: 'user', content: '执行' }],
      tools: [{ name: 'command', description: '原始规则'.repeat(3000), input: {} }],
      maxInputTokens: 1000,
    }),
  ).toThrow('AI_CONTEXT_TOO_LARGE');
});
