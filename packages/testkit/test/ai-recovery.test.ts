/**
 * AI 持久运行的故障恢复回归，覆盖上游历史失效、超时分类、预算预留结算、历史重建及并发补位。
 * 模型适配器由 generate 脚本控制，真实数据库记录运行和上下文；通过重建 runtime 验证跨实例恢复。
 * 工具回执与有效步骤/额外尝试分开核对，避免崩溃重试重复动作或绕过预算。结束时关闭运行时及测试库。
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import * as admin from '@yss123/cage-admin/domain';
import { ai, type AiRuntime, type ModelRequest, type ModelResult } from '../../ai/src/index.js';
import { ResponseHistoryExpired } from '../../ai/src/responses.js';
import { readContext } from '../../ai/src/context-read.js';
import { ConnectorError } from '@yss123/cage-connectors';
import { createTestEnv, type TestEnv, type TestUser } from '../src/index.js';

let generate: (request: ModelRequest) => ModelResult | Promise<ModelResult>;
/**
 * 启用可接续模型并将运行并发设为二，用于测试慢任务占位时其他运行能及时补位。
 */
const intelligence = ai({
  models: {
    main: {
      spec: { kind: 'recovery-test' },
      contextWindowTokens: 131072,
      continuation: { key: 'recovery-test', compaction: false },
      generate: async (request) => generate(request),
    },
  },
  assistant: { model: 'main' },
  maxConcurrentRuns: 2,
});
let env: TestEnv, runtime: AiRuntime, user: TestUser;
beforeAll(async () => {
  env = await createTestEnv({ domain: { ...admin, intelligence } });
  runtime = intelligence.service(env.kernel);
  user = await env.user({ caps: ['Sys.ai.use'] });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await runtime?.close();
  await env?.close();
});
/**
 * 模型工具回包夹具，携带可选 responseId 与固定用量，便于核对接续和预算结算。
 */
const call = (name: string, args: Record<string, unknown>, responseId?: string): ModelResult => ({
  text: '',
  calls: [{ id: randomUUID(), name, arguments: args }],
  responseId,
  usage: { inputTokens: 500, outputTokens: 50 },
});
/**
 * 模型最终文字回包，calls 为空代表无需继续工具循环；用量固定使恢复前后可比较。
 */
const result = (text: string, responseId?: string): ModelResult => ({
  text,
  calls: [],
  usage: { inputTokens: 500, outputTokens: 50 },
  responseId,
});
/**
 * 只在测试中读取持久运行行，核对状态/预算/接续标记，不通过该 helper 修改运行。
 */
const saved = async (id: string) => (await env.query('select * from sys.ai_run where id=$1', [id]))[0];
/**
 * 使用测试用户权限提交一轮，可复用 sessionId 构造跨轮恢复；未提供则新建会话。
 */
const start = async (message: string, sessionId?: string) => {
  const ctx = await user.ctx(),
    session = sessionId ?? (await runtime.createSession(ctx)).id;
  return runtime.submit(ctx, session, { message }, randomUUID());
};

it.each([
  [new DOMException('PRIVATE_UPSTREAM_DETAIL', 'TimeoutError'), 'AI_MODEL_TIMEOUT', 'request_timeout'],
  [
    new ConnectorError('PRIVATE_UPSTREAM_DETAIL', 503, true, 'rejected', 'service_unavailable'),
    'AI_MODEL_HTTP_ERROR',
    'http_error',
  ],
])('模型失败将分类与耗时落库，保留预算结算且不泄露原异常', async (error, code, reason) => {
  generate = () => {
    throw error;
  };
  const run = await start('故障分类验证');
  await runtime.tick();
  const row = await saved(run.id);
  expect(row).toMatchObject({
    status: 'failed',
    error: code,
    steps: 0,
    model_attempts: 1,
    model_reservation: null,
  });
  const events = await runtime.events(await user.ctx(), run.id);
  const failure = events.find((event) => event.type === 'model.failed')!.data;
  expect(failure).toMatchObject({
    code,
    reason,
    durationMs: expect.any(Number),
    firstTextMs: null,
    retryable: false,
  });
  expect(row.tokens).toBe(failure.chargedTokens);
  expect(row.tokens).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_UPSTREAM_DETAIL');
});

it('整个运行到达截止时间仍为 AI_TIMEOUT，与模型单次请求超时区分', async () => {
  generate = (request) =>
    new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  const run = await start('总截止时间验证');
  await env.query("update sys.ai_run set limits=jsonb_set(limits, '{timeoutMs}', '100') where id=$1", [
    run.id,
  ]);
  await runtime.tick();
  expect(await saved(run.id)).toMatchObject({
    status: 'expired',
    error: 'AI_TIMEOUT',
    model_reservation: null,
  });
});

it('明确拒绝的接续释放预留且不占有效步数，诊断区分尝试与实际用量', async () => {
  let count = 0;
  generate = async (request) => {
    count++;
    const row = await saved(request.context!.runId);
    expect(row.model_reservation.attempt).toBe(count);
    if (count === 1) {
      expect(row.tokens).toBe(0);
      return call('ontology_search', { query: '' }, 'r_initial');
    }
    if (count === 2) {
      expect(request.previousResponseId).toBe('r_initial');
      throw new ResponseHistoryExpired('unsupported');
    }
    expect(row.tokens).toBe(550);
    expect(request.previousResponseId).toBeUndefined();
    return result('完成');
  };
  const run = await start('查询目录');
  await runtime.tick();
  const row = await saved(run.id);
  expect(row.status).toBe('succeeded');
  expect(count).toBe(3);
  expect(row.tokens).toBe(1100);
  expect(row.steps).toBe(2);
  expect(row.model_attempts).toBe(3);
  expect(row.model_reservation).toBeNull();
  const events = await runtime.events(await user.ctx(), run.id);
  expect(events.find((event) => event.type === 'model.failed')?.data).toMatchObject({
    chargedTokens: 0,
    retryable: true,
  });
  expect(events.filter((event) => event.type === 'model.completed')).toHaveLength(2);
});

it('maxSteps=1 的单步回答仍能在接续失败后恢复，额外尝试有独立上限', async () => {
  const session = await runtime.createSession(await user.ctx());
  generate = () => result('已了解', 'r_prior');
  await start('第一轮', session.id);
  await runtime.tick();
  let count = 0;
  generate = (request) => {
    count++;
    if (request.previousResponseId) throw new ResponseHistoryExpired('unsupported');
    return result('恢复完成');
  };
  const run = await start('第二轮', session.id);
  await env.query("update sys.ai_run set limits=jsonb_set(limits, '{maxSteps}', '1') where id=$1", [run.id]);
  await runtime.tick();
  const row = await saved(run.id);
  expect(row.status).toBe('succeeded');
  expect(row.steps).toBe(1);
  expect(row.tokens).toBe(550);
  expect(count).toBe(2);
});

it('回退请求中断后不丢失接续禁用状态，同会话后续轮次也不重复探测', async () => {
  const stop = new AbortController();
  let count = 0;
  generate = (request) => {
    count++;
    if (count === 1) return call('ontology_search', { query: '' }, 'r_initial');
    if (count === 2) throw new ResponseHistoryExpired('unsupported');
    expect(request.previousResponseId).toBeUndefined();
    stop.abort();
    throw stop.signal.reason;
  };
  const run = await start('模拟回退期间停机');
  await runtime.tick(stop.signal);
  const row = await saved(run.id);
  expect(row.status).toBe('queued');
  expect(row.continuation_disabled_key).toBe('recovery-test');
  expect(row.model_reservation).toBeNull();
  expect(row.tokens).toBeGreaterThan(550);
  let resumed = 0;
  generate = (request) => {
    expect(request.previousResponseId).toBeUndefined();
    return ++resumed === 1
      ? call('ontology_search', { query: '恢复' }, 'r_resume')
      : result('完成', 'r_done');
  };
  await runtime.tick();
  expect((await saved(run.id)).status).toBe('succeeded');
  await start('下一轮', row.session_id);
  await runtime.tick();
  expect(resumed).toBe(3);
});

it('崩溃留下的未知预留只结算一次，反复恢复不能绕过尝试次数上限', async () => {
  const run = await start('恢复未知请求');
  generate = () => result('初始化');
  await runtime.tick();
  const reservation = {
    attempt: 18,
    step: 1,
    inputTokens: 100,
    outputTokens: 100,
    startedAt: new Date().toISOString(),
  };
  await env.query(
    "update sys.ai_run set status='queued', phase='model', steps=0, tokens=0, deadline=null, model_attempts=18, model_reservation=$2::jsonb where id=$1",
    [run.id, JSON.stringify(reservation)],
  );
  generate = vi.fn(() => result('不应调用'));
  await runtime.tick();
  const row = await saved(run.id);
  expect(row.error).toBe('AI_BUDGET_EXCEEDED');
  expect(row.tokens).toBe(200);
  expect(row.model_reservation).toBeNull();
  expect(generate).not.toHaveBeenCalled();
  await runtime.tick();
  expect((await saved(run.id)).tokens).toBe(200);
});

it('本地跨轮恢复用户补充与工具配对，conversation 读取也能找到原文', async () => {
  const session = await runtime.createSession(await user.ctx());
  let count = 0;
  generate = () => (++count === 1 ? call('request_input', { prompt: '请补充代号' }) : result('已了解'));
  const first = await start('记住补充条件', session.id);
  await runtime.tick();
  const waiting = await runtime.run(await user.ctx(), first.id);
  await runtime.respond(await user.ctx(), first.id, waiting.interactions[0].id, { answer: 'CONDITION-731' });
  await runtime.tick();
  let request!: ModelRequest;
  generate = (input) => {
    request = input;
    return result('已找到补充条件');
  };
  const next = await start('按刚才的代号继续', session.id);
  await runtime.tick();
  expect(JSON.stringify(request.messages)).toContain('CONDITION-731');
  const receipts = request.messages.filter((message) => message.role === 'tool');
  expect(receipts).toHaveLength(1);
  expect(
    request.messages.some((message) => message.toolCalls?.some((call) => call.id === receipts[0].toolCallId)),
  ).toBe(true);
  const execution = {
    kernel: env.kernel,
    ontology: runtime.ontology,
    ctx: await user.ctx(),
    run: await saved(next.id),
    signal: new AbortController().signal,
  };
  const conversation = await readContext(execution, {
    source: 'conversation',
    runId: first.id,
    path: ['messages'],
    offset: 0,
    limit: 20,
  });
  expect(JSON.stringify(conversation)).toContain('CONDITION-731');
});

it('近期小轮次超过六轮仍保留，恢复历史不会随轮次递归重复', async () => {
  const session = await runtime.createSession(await user.ctx());
  const requests: ModelRequest[] = [];
  generate = (input) => {
    requests.push(input);
    return result('已了解');
  };
  for (let i = 0; i < 9; i++) {
    await start(`条件-${i}`, session.id);
    await runtime.tick();
  }
  expect(requests.at(-1)!.messages.filter((message) => message.role === 'user')).toHaveLength(9);
  expect(requests.at(-1)!.messages.filter((message) => message.content === '条件-0')).toHaveLength(1);
});

it('空闲并发名额立即补位，运行中后来提交的任务也不用等慢请求', async () => {
  let releaseSlow!: () => void, fastDone!: () => void, slowStarted!: () => void, thirdDone!: () => void;
  const fastCompleted = new Promise<void>((resolve) => {
    fastDone = resolve;
  });
  const slowEntered = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const thirdCompleted = new Promise<void>((resolve) => {
    thirdDone = resolve;
  });
  const slowBlocked = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  generate = async (request) => {
    const message = request.messages.findLast((item) => item.role === 'user')!.content;
    if (message === '慢任务') {
      slowStarted();
      await slowBlocked;
    }
    return result('完成');
  };
  const fast = await start('快任务');
  await start('慢任务');
  let thirdId: string;
  const execute = (runtime as any).execute.bind(runtime);
  vi.spyOn(runtime as any, 'execute').mockImplementation(async (...args: any[]) => {
    await execute(...args);
    if (args[0].id === fast.id) fastDone();
    if (args[0].id === thirdId) thirdDone();
  });
  const tick = runtime.tick();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([fastCompleted, slowEntered]);
    const next = await start('后来提交');
    thirdId = next.id;
    await Promise.race([
      thirdCompleted,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('空闲名额未补位')), 5000);
      }),
    ]);
    expect((await saved(next.id)).status).toBe('succeeded');
  } finally {
    if (deadline) clearTimeout(deadline);
    releaseSlow();
    await tick;
  }
});
