/**
 * 执行可恢复的 AI 状态机：准备上下文、调用模型、逐个工具动作、保存观察并继续推理。
 * worker 通过 tick 领取任务，数据库保存阶段、预算、动作与回执；进程只持有短期租约。模型网络调用在事务外，业务写与动作回执在同一事务，租约失效后旧执行者不得提交。
 * 审批和助理共用执行机制但使用不同身份、工具与结论边界；停止、取消、超时和远端历史恢复分别处理，不把模型文字当作业务执行成功。
 */
import { randomUUID } from 'node:crypto';
import { cageError, isCageError, type Ctx, type Kernel, type RuntimeService } from '@yss123/cage-kernel';
import { runtimeOntology, type RuntimeOntology } from '@yss123/cage-ontology';
import {
  aiDecisionSchema,
  personalityPreviewSchema,
  type AiPersonalityPreview,
} from '@yss123/cage-ai-protocol';
import { sql, type Transaction } from 'kysely';
import { AiStore, event, json } from './store.js';
import { authFingerprint, contextForRun, digest, parse } from './security.js';
import { pageContext } from './context.js';
import { checkedTool, engines, toolsFor, type Tool } from './tools.js';
import {
  DEFAULT_LIMITS,
  type AiOptions,
  type Execution,
  type ModelMessage,
  type ModelProvider,
  type ToolCall,
} from './types.js';
import { validateModelResult } from './model.js';
import { mountHttp, aiOpenApi } from './http.js';
import { ModelManager } from './models.js';
import { TextStream } from './text-stream.js';
import { personalityPrompt } from './personalities.js';
import { contextPreview } from './prompt.js';
import { ResponseHistoryExpired } from './responses.js';
import { modelBudget, reservedTokens } from './budget.js';
import { loadConversation } from './history.js';
import { planModelRequest, discoveredToolKeys } from './request-plan.js';
import type { ModelReservation, RemoteHistory, StoredRun } from './state.js';
import { modelFailure, type ModelFailure } from './model-failure.js';

/**
 * 内部控制异常，表示运行已取消、租约过期或被其他执行者接管。
 * 旧 worker 遇到它安静退出，不覆盖新执行者状态，也不把失去租约记成新的业务故障。
 */
class LostLease extends Error {}
/**
 * 运行租约有效期，单位毫秒；执行循环每 5 秒续租，所有状态写入还需在事务内重新核验租约。
 */
const LEASE_MS = 30_000;
/**
 * 以取消信号和异步操作竞争，取消时及时结束调用方等待并移除监听器。
 * 底层操作仍必须自行响应传入信号；Promise.race 不能强制终止不配合取消的外部实现，后续提交仍依赖租约校验阻止迟到结果。
 */
async function abortable<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** context → model → actions → observation 的可恢复状态机。数据库是状态源，进程只持有带期限的租约。 */
/**
 * 持久化 AI 运行服务，继承用户会话存储并接入 HTTP、OpenAPI 和 worker 生命周期。
 * 以租约行锁保护状态推进，以动作回执保护业务写恢复；模型调用失败时保守计入未知用量，工具读取可能重试，已成功相同写意图优先复用回执。
 */
export class AiRuntime extends AiStore implements RuntimeService {
  /**
   * 与当前注册表指纹一致的运行时本体，用于工具发现和上下文说明。
   */
  readonly ontology: RuntimeOntology;
  /**
   * 租户动态模型管理入口，与静态模型 provider 共存。
   */
  readonly models: ModelManager;
  /**
   * 整个 runtime 的关闭信号，传播到模型调用和执行循环。
   */
  private stopping = new AbortController();
  /**
   * 当前进程实际执行中的运行 Promise 集合，用于并发限制和关闭等待。
   */
  private active = new Set<Promise<void>>();
  /**
   * 正在处理的一次 worker tick，用于合并重入调用。
   */
  private tickPromise: Promise<number> | null = null;
  /**
   * 正在试聊的租户/用户组合，限制单用户和本进程并发，不是跨进程全局配额。
   */
  private previewing = new Set<string>();
  /**
   * 构建运行时本体与注册表指纹，绑定 managed provider 并收集可管理模型别名。
   * 外部提供的本体指纹必须与当前注册表一致，否则启动失败；构造不调用模型或执行任务。
   */
  constructor(kernel: Kernel, options: AiOptions) {
    const ontology = runtimeOntology(kernel.registry);
    super(
      kernel,
      {
        ...options,
        models: Object.fromEntries(
          Object.entries(options.models).map(([name, provider]) => [
            name,
            provider.bind?.(kernel) ?? provider,
          ]),
        ),
      },
      ontology.fingerprint,
    );
    this.models = new ModelManager(kernel, [
      ...new Set(
        Object.values(options.models)
          .filter((p) => p.spec.kind === 'managed-model')
          .map((p) => String(p.spec.key)),
      ),
    ]);
    if (options.ontology && options.ontology.fingerprint !== ontology.fingerprint)
      throw new Error('AI 本体清单与运行注册表不一致');
    this.ontology = options.ontology ?? ontology;
  }
  /**
   * 用零行查询确认运行、模型、性格及后续状态字段迁移已经可读。
   * 只检查数据库结构依赖，不代表外部模型连通、业务授权或实际 AI 流程已验证。
   */
  async ready(): Promise<void> {
    await this.kernel.app
      .selectFrom('sys.ai_run')
      .select(['id', 'model_reservation', 'tool_plan'])
      .limit(0)
      .execute();
    await this.kernel.app.selectFrom('sys.ai_model').select('key').limit(0).execute();
    await this.kernel.app.selectFrom('sys.ai_personality').select('key').limit(0).execute();
    await this.kernel.app.selectFrom('sys.ai_run').select('model_state').limit(0).execute();
  }
  /**
   * 发出进程停止信号并等待当前活跃执行结束；执行循环尝试释放租约并重新排队，不能撤销先前已提交的领域命令。
   */
  async close(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled([...this.active]);
  }
  /**
   * 把固定 AI HTTP 接口挂载到宿主服务；认证、SSE 和归属边界由 mountHttp 与存储层共同执行。
   */
  http(app: any): void {
    mountHttp(app, this);
  }
  /**
   * 返回 AI 固定接口的 OpenAPI 路径片段，供宿主统一合并，不在此注册路由。
   */
  openapi(): Record<string, Record<string, unknown>> {
    return aiOpenApi();
  }

  /** 性格试聊只请求一次模型，不提供业务工具、页面、记忆或用户历史。草稿无需先保存。 */
  /**
   * 在性格管理授权下对未保存草稿进行一次纯文本试聊。
   * 每个用户同时最多一次、当前 runtime 最多四次；20 秒中止、最多 600 输出 Token，不提供工具、页面、偏好或会话历史。
   * 开始前记录管理操作审计，拒绝任何工具调用结果，finally 等待流清理并释放并发名额；不创建正式助理运行。
   */
  async previewPersonality(
    ctx: Ctx,
    raw: unknown,
    onText?: (text: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<AiPersonalityPreview> {
    this.personalities.need(ctx);
    const input = parse(personalityPreviewSchema, raw),
      model = this.options.assistant?.model;
    if (!model) throw cageError('NOT_FOUND', '应用未启用业务助理');
    const owner = `${ctx.tenantId}:${ctx.userId}`;
    if (this.previewing.has(owner) || this.previewing.size >= 4) throw cageError('RATE_LIMITED');
    this.previewing.add(owner);
    const cancel = AbortSignal.any([
      this.stopping.signal,
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    const stream = new TextStream(async (text) => {
        if (onText) await onText(text);
      }, cancel),
      started = Date.now();
    try {
      await this.personalities.audit(this.kernel.app, ctx, 'preview', { model, label: input.profile.label });
      const result = validateModelResult(
        await abortable(cancel, () =>
          this.options.models[model].generate({
            messages: [
              {
                role: 'system',
                content: `这是助理性格试聊。请用纯文本短段落展示表达方式；未连接业务工具，不能查询或修改真实业务。不要假装执行过任何操作。\n${personalityPrompt(input.profile)}`,
              },
              { role: 'user', content: input.message },
            ],
            tools: [],
            maxOutputTokens: 600,
            context: { tenantId: ctx.tenantId, runId: randomUUID() },
            signal: cancel,
            onText: (text) => stream.push(text),
          }),
        ),
      );
      if (result.calls.length) throw cageError('INVALID_INPUT', '试聊只支持文字回复');
      await stream.finish();
      return { text: result.text, latencyMs: Date.now() - started };
    } finally {
      await stream.dispose();
      this.previewing.delete(owner);
    }
  }

  /**
   * 在调用方事务中锁定运行行，检查 token、running 状态、取消标记和未到期租约。
   * 返回锁下最新快照供变更使用；任何不满足均抛 LostLease，避免旧内存快照授权迟到提交。
   */
  private async guard(tx: Transaction<any>, id: string, token: string | null): Promise<StoredRun> {
    const run = (await tx
      .selectFrom('sys.ai_run')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow()) as StoredRun;
    if (
      !token ||
      run.lease_token !== token ||
      run.status !== 'running' ||
      run.cancelled ||
      !run.lease_until ||
      new Date(run.lease_until).getTime() <= Date.now()
    )
      throw new LostLease();
    return run;
  }
  /**
   * 为一次运行状态变更打开事务并先执行 guard，再把锁下最新状态传给回调。
   * 状态、动作和事件可由回调原子提交；不应把外部模型网络请求放在这个事务内。
   */
  private async change(
    run: StoredRun,
    fn: (tx: Transaction<any>, current: StoredRun) => Promise<void>,
  ): Promise<void> {
    await this.kernel.app.transaction().execute(async (tx) => {
      const current = await this.guard(tx, run.id, run.lease_token);
      await fn(tx, current);
    });
  }
  /**
   * 内部读取完整运行行供执行循环恢复阶段；不执行用户归属授权。
   * 公开访问必须走 ownedRun，内部使用后在执行前调用 identity 并在写入前 guard。
   */
  private async readRun(id: string): Promise<StoredRun> {
    return this.kernel.app
      .selectFrom('sys.ai_run')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow() as Promise<StoredRun>;
  }

  /** 与审批步骤关联一次；旧轮次取消后不会被再次领取。 */
  /**
   * 领取最多 20 个仍运行实例中的未绑定 AI 步骤，以行锁和 skipLocked 避免多 worker 重复建运行。
   * 创建审批 run、绑定 step.run_id、切换步骤状态及首个事件同事务完成；只处理 queued 且未关联的步骤。
   */
  private async enqueueApprovals(): Promise<number> {
    if (!engines({ kernel: this.kernel }).length) return 0;
    return this.kernel.app.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom('flow.approval_step as s')
        .innerJoin('flow.approval_instance as i', 'i.id', 's.instance_id')
        .select(['s.id', 's.step', 's.tenant_id', 'i.process', 'i.steps'])
        .where('s.kind', '=', 'ai')
        .where('s.status', '=', 'queued')
        .where('s.run_id', 'is', null)
        .where('i.status', '=', 'running')
        .orderBy('s.created_at')
        .limit(20)
        .forUpdate('s')
        .skipLocked()
        .execute();
      for (const row of rows) {
        const policy = row.steps[row.step],
          id = randomUUID();
        await tx
          .insertInto('sys.ai_run')
          .values({
            id,
            tenant_id: row.tenant_id,
            mode: 'approval',
            status: 'queued',
            approval_step_id: row.id,
            process: row.process,
            policy: json(policy),
            model: policy.model,
            instructions: policy.instructions,
            limits: json({ ...DEFAULT_LIMITS, maxSteps: 5, maxToolCalls: 8, ...policy.limits }),
            fingerprint: this.fingerprint,
            delegated_until: new Date(Date.now() + (this.options.delegationTtlMs ?? 30 * 60_000)),
          })
          .execute();
        await tx
          .updateTable('flow.approval_step')
          .set({ run_id: id, status: 'running' })
          .where('id', '=', row.id)
          .execute();
        await event(tx, id, 'run.status', { status: 'queued' });
      }
      return rows.length;
    });
  }
  /**
   * 按创建顺序领取 queued 或租约已过期的 running 任务。
   * 同会话较早非终态运行阻止后续轮次，保证用户上下文顺序；skipLocked 避免争抢阻塞。
   * 生成新租约 token，保留已有执行 deadline 或首次按 timeoutMs 创建，并同事务写 running 事件；没有可领取任务返回 null。
   */
  private async claim(): Promise<StoredRun | null> {
    return this.kernel.app.transaction().execute(async (tx) => {
      const run = await tx
        .selectFrom('sys.ai_run as r')
        .selectAll('r')
        .where((eb) =>
          eb.or([
            eb('r.status', '=', 'queued'),
            eb.and([eb('r.status', '=', 'running'), eb('r.lease_until', '<', new Date())]),
          ]),
        )
        .where(
          sql<boolean>`not exists (select 1 from sys.ai_run earlier where earlier.session_id = r.session_id
          and (earlier.created_at, earlier.id) < (r.created_at, r.id) and earlier.status not in ('succeeded','failed','cancelled','expired'))`,
        )
        .orderBy('r.created_at')
        .orderBy('r.id')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!run) return null;
      const token = randomUUID(),
        deadline = run.deadline ?? new Date(Date.now() + run.limits.timeoutMs);
      await tx
        .updateTable('sys.ai_run')
        .set({
          status: 'running',
          lease_token: token,
          lease_until: new Date(Date.now() + LEASE_MS),
          deadline,
        })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'run.status', { status: 'running' });
      return { ...run, status: 'running', lease_token: token, deadline } as StoredRun;
    });
  }
  /**
   * 合并同一 runtime 上重叠的 worker tick 调用，返回同一工作 Promise。
   * 停止后返回 0；本轮完成才清空缓存，避免并发扫描导致超过当前进程并发名额。
   */
  tick(signal?: AbortSignal): Promise<number> {
    if (this.stopping.signal.aborted) return Promise.resolve(0);
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.work(signal).finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }
  /**
   * 先入队 AI 审批并终结委托已过期的等待互动，再按 maxConcurrentRuns（默认 2）补充执行任务。
   * 等待用户不占活跃槽位；有空槽时短间隔补位，满槽只等待任务完成。结束前等活跃任务退出，返回本轮入队/领取计数。
   */
  private async work(signal?: AbortSignal): Promise<number> {
    let count = await this.enqueueApprovals();
    // 等待不占执行者；过期互动在这里终结，后续会话消息才能继续。
    const expired = await this.kernel.app
      .selectFrom('sys.ai_run')
      .select('id')
      .where('status', 'in', ['waiting_input', 'waiting_confirmation'])
      .where('delegated_until', '<=', new Date())
      .limit(100)
      .execute();
    for (const row of expired)
      await this.kernel.app.transaction().execute(async (tx) => {
        const r = await tx
          .selectFrom('sys.ai_run')
          .selectAll()
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (!['waiting_input', 'waiting_confirmation'].includes(r.status)) return;
        await tx
          .updateTable('sys.ai_run')
          .set({ status: 'expired', error: 'DELEGATION_EXPIRED' })
          .where('id', '=', r.id)
          .execute();
        await event(tx, r.id, 'run.status', { status: 'expired' });
      });
    const concurrency = this.options.maxConcurrentRuns ?? 2;
    while (!signal?.aborted && !this.stopping.signal.aborted) {
      while (this.active.size < concurrency && !signal?.aborted && !this.stopping.signal.aborted) {
        const run = await this.claim();
        if (!run) break;
        count++;
        const job = this.execute(run, signal).finally(() => this.active.delete(job));
        this.active.add(job);
      }
      if (!this.active.size) break;
      // 空闲名额持续补位；全部繁忙时只等待任务完成，不扫描队列。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = new Promise<void>((resolve) => {
        if (this.active.size < concurrency) timer = setTimeout(resolve, 100);
      });
      try {
        await Promise.race([...this.active, poll]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!signal?.aborted && !this.stopping.signal.aborted) count += await this.enqueueApprovals();
    }
    await Promise.allSettled([...this.active]);
    return count;
  }

  /**
   * 重新构建运行身份并核对注册表、委托及当前授权指纹。
   * 权限或声明变化立即拒绝继续执行，旧快照不能作为持续权限许可。
   */
  private async identity(run: StoredRun): Promise<Ctx> {
    if (run.fingerprint !== this.fingerprint) throw cageError('CONFLICT', '注册声明已变化');
    const ctx = await contextForRun(this.kernel, run);
    if (run.auth_fingerprint && run.auth_fingerprint !== authFingerprint(ctx))
      throw cageError('FORBIDDEN', '授权已变化');
    return ctx;
  }
  /**
   * 核对审批实例仍运行、该分支步骤状态和 run_id 绑定；并行实例允许多项活跃步骤。
   * 撤回、重提或步骤推进后旧 AI 运行不得继续审查或提交结论；返回当前业务对象定位及版本。
   */
  private async approvalActive(run: StoredRun) {
    const step = await this.kernel.app
      .selectFrom('flow.approval_step as s')
      .innerJoin('flow.approval_instance as i', 'i.id', 's.instance_id')
      .select([
        'i.aggregate',
        'i.business_key',
        'i.subject_version',
        'i.status',
        'i.current_step',
        's.step',
        's.status as step_status',
        's.run_id',
      ])
      .where('s.id', '=', run.approval_step_id)
      .executeTakeFirst();
    if (
      !step ||
      step.status !== 'running' ||
      step.run_id !== run.id ||
      step.step_status !== 'running'
    )
      throw cageError('CONFLICT', '审批步骤已失效');
    return step;
  }
  /**
   * 解析运行使用的模型别名；动态 provider 每个模型步进读取当前租户配置。
   * 缺少声明直接失败，不静默使用其他模型或全局租户配置。
   */
  private async provider(run: StoredRun): Promise<ModelProvider> {
    const configured = this.options.models[run.model];
    if (!configured) throw new Error('模型配置不存在');
    return configured.resolve ? configured.resolve({ tenantId: run.tenant_id }) : configured;
  }

  /**
   * 为审批重新读取指定对象并核对审批启动版本，仅投影策略允许字段；为助理重新读取页面事实、本人偏好和预算内近期历史。
   * 追加本轮任务，记录 history_start 与远端状态/省略信息，在租约事务中保存上下文并进入 model 阶段；原始页面文字不自动成为可信事实。
   */
  private async prepareContext(run: StoredRun, ctx: Ctx): Promise<void> {
    let context: Record<string, unknown>,
      history: ModelMessage[] = [];
    let modelState: RemoteHistory | null = null,
      disabledKey: string | null = null,
      omitted = false;
    if (run.mode === 'approval') {
      const step = await this.approvalActive(run);
      const record = await this.kernel.read.get(step.aggregate, step.business_key, ctx);
      if (record.version !== step.subject_version) throw cageError('CONFLICT');
      context = {
        subject: {
          aggregate: step.aggregate,
          ...Object.fromEntries(
            ['id', 'status', 'version', ...run.policy.context.fields].map((f) => [f, record[f]]),
          ),
        },
      };
    } else {
      const provider = await this.provider(run);
      const budget = modelBudget(provider, run.limits, run.tokens, this.options.context);
      const prior = await loadConversation(
        this.kernel,
        ctx,
        run,
        budget.historyTokens,
        provider.continuation?.key,
      );
      history = prior.messages;
      modelState = prior.state;
      disabledKey = prior.disabledKey;
      omitted = prior.omitted;
      context = {
        page: await pageContext(this.kernel, ctx, run.page_context),
        preferences: await this.memories(ctx),
      };
    }
    const historyStart = history.length;
    history.push({
      role: 'user',
      content:
        run.mode === 'approval'
          ? '请依据声明规则和证据审查当前对象，使用 review_decide 提交裁决。'
          : run.input,
      runId: run.id,
    });
    await this.change(run, async (tx) => {
      await tx
        .updateTable('sys.ai_run')
        .set({
          context: json(context),
          history: json(history),
          history_start: historyStart,
          model_state: modelState ? json(modelState) : null,
          history_omitted: omitted,
          continuation_disabled_key: disabledKey,
          tool_keys: '[]',
          phase: 'model',
          auth_fingerprint: authFingerprint(ctx),
        })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'context.updated', {
        pageInstanceId: run.page_context?.pageInstanceId ?? null,
        revision: run.page_context?.revision ?? null,
      });
    });
  }
  /**
   * 以单个 provider 快照规划输入、完整工具和输出预算，先持久化尝试次数及 Token 预留再外呼。
   * 文本通过 TextStream 在租约保护下落事件；有效结果按厂商用量或预留估算结算，保存历史、远端项和待执行调用，助理无工具时才完成。
   * 远端历史失效且可安全恢复时清空接续状态重建本地请求；其他不确定失败保守结算预留。审批必须提交 decision，超出累计或工具预算不进入动作阶段。
   */
  private async model(execution: Execution): Promise<void> {
    const { run } = execution;
    const provider = await this.provider(run);
    const plan = planModelRequest(execution, provider, this.options.context);
    const reservation: ModelReservation = {
      attempt: run.model_attempts + 1,
      step: run.steps + 1,
      inputTokens: plan.estimatedInput,
      outputTokens: plan.outputLimit,
      startedAt: new Date().toISOString(),
    };
    // 先持久化一次调用的预留，已结算 tokens/steps 不变。崩溃恢复会保守结算未知结果。
    await this.change(run, async (tx) => {
      await tx
        .updateTable('sys.ai_run')
        .set({
          model_attempts: reservation.attempt,
          model_reservation: json(reservation),
          tool_keys: json(plan.keys),
          tool_plan: json(plan.selection),
          model_state: plan.remote ? json(plan.remote) : null,
        })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'context.updated', {
        estimatedInputTokens: plan.estimatedInput,
        contextWindowTokens: plan.budget.window,
        loadedTools: plan.tools.length,
        toolMode: plan.selection.mode,
        toolTokenBudget: plan.selection.tokenBudget,
        reduced: plan.reduced,
        remoteContinuation: !!plan.remote,
        historyRebased: !!run.model_state && !plan.remote,
      });
      await event(tx, run.id, 'model.started', { step: reservation.step, attempt: reservation.attempt });
    });
    let firstTextMs: number | null = null;
    const started = Date.now();
    const stream = new TextStream(
      (text) =>
        this.change(run, (tx) => event(tx, run.id, 'message.delta', { step: reservation.step, text })),
      execution.signal,
    );
    let result;
    try {
      result = validateModelResult(
        await abortable(execution.signal, () =>
          provider.generate({
            messages: plan.messages,
            tools: plan.tools,
            signal: execution.signal,
            maxOutputTokens: plan.outputLimit,
            previousResponseId: plan.remote?.responseId,
            stateKey: provider.continuation?.key,
            context: { tenantId: execution.ctx.tenantId, runId: run.id },
            onText: (text) => {
              if (firstTextMs === null && text) firstTextMs = Date.now() - started;
              return stream.push(text);
            },
          }),
        ),
      );
      await stream.finish();
    } catch (error) {
      if (!(error instanceof ResponseHistoryExpired) || !plan.remote) {
        const failure = modelFailure(error);
        if (failure.code === 'AI_MODEL_TIMEOUT' && execution.signal.aborted) {
          failure.code = 'AI_TIMEOUT';
          failure.reason = 'run_timeout';
        }
        await this.settleUncertain(run, failure.reason, {
          ...failure,
          durationMs: Date.now() - started,
          firstTextMs,
        });
        if (failure.code) throw new Error(failure.code);
        throw error;
      }
      await this.change(run, async (tx) => {
        const disabled = error.reason === 'unsupported';
        await tx
          .updateTable('sys.ai_run')
          .set({
            model_reservation: null,
            model_state: null,
            ...(disabled ? { continuation_disabled_key: provider.continuation!.key } : {}),
          })
          .where('id', '=', run.id)
          .execute();
        await event(tx, run.id, 'model.failed', {
          attempt: reservation.attempt,
          step: reservation.step,
          reason: error.reason,
          durationMs: Date.now() - started,
          chargedTokens: 0,
          retryable: true,
        });
        await event(tx, run.id, 'context.updated', {
          reason: disabled ? 'remote_continuation_unsupported' : 'remote_history_expired',
          historyRebased: true,
          continuationDisabled: disabled,
        });
      });
      return;
    } finally {
      await stream.dispose();
    }
    execution.signal.throwIfAborted();
    const consumed = result.usage
      ? result.usage.inputTokens + result.usage.outputTokens
      : reservedTokens(reservation);
    const tokens = run.tokens + consumed;
    const violation =
      tokens > run.limits.tokenBudget
        ? 'AI_BUDGET_EXCEEDED'
        : run.tool_calls + result.calls.length > run.limits.maxToolCalls
          ? 'AI_TOOL_BUDGET_EXCEEDED'
          : !result.calls.length && run.mode === 'approval'
            ? 'AI_DECISION_REQUIRED'
            : null;
    const history: ModelMessage[] = [
      ...run.history,
      {
        role: 'assistant',
        content: result.text,
        runId: run.id,
        ...(result.calls.length ? { toolCalls: result.calls } : {}),
        ...(provider.continuation && result.outputItems
          ? { providerItems: { key: provider.continuation.key, items: result.outputItems } }
          : {}),
      },
    ];
    const modelState: RemoteHistory | null =
      provider.continuation &&
      result.responseId &&
      run.continuation_disabled_key !== provider.continuation.key
        ? {
            key: provider.continuation.key,
            responseId: result.responseId,
            historyLength: history.length,
            contextTokens: consumed,
          }
        : null;
    await this.change(run, async (tx) => {
      await tx
        .updateTable('sys.ai_run')
        .set({
          model_reservation: null,
          steps: reservation.step,
          tokens,
          ...(!violation
            ? {
                history: json(history),
                model_state: modelState ? json(modelState) : null,
                pending: json(result.calls),
                phase: result.calls.length ? 'actions' : 'done',
                ...(!result.calls.length
                  ? { status: 'succeeded', answer: result.text, lease_token: null, lease_until: null }
                  : {}),
              }
            : {}),
        })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'model.completed', {
        step: reservation.step,
        attempt: reservation.attempt,
        durationMs: Date.now() - started,
        firstTextMs,
        tokens: consumed,
        usageSource: result.usage ? 'provider' : 'estimate',
        toolCalls: result.calls.length,
      });
      if (!violation && !result.calls.length) {
        await event(tx, run.id, 'message.completed', { text: result.text });
        await event(tx, run.id, 'run.status', { status: 'succeeded' });
      }
    });
    if (violation) throw new Error(violation);
  }

  /**
   * 在租约行锁下读取当前模型预留并一次性计入估算 Token，随后清空预留、写 model.failed。
   * 网络断线或 worker 恢复无法证明厂商没有计费，因此不按零消耗处理；已清空时直接返回，避免重复结算。
   */
  private async settleUncertain(
    run: StoredRun,
    reason: string,
    failure?: ModelFailure & { durationMs: number; firstTextMs: number | null },
  ): Promise<void> {
    await this.change(run, async (tx, current) => {
      const reservation = current.model_reservation;
      if (!reservation) return;
      // 网络中断/进程崩溃无法证明上游未计费，保守结算预留；尝试次数独立限制恢复次数。
      const charged = reservedTokens(reservation);
      await tx
        .updateTable('sys.ai_run')
        .set({ tokens: current.tokens + charged, model_reservation: null })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'model.failed', {
        attempt: reservation.attempt,
        step: reservation.step,
        reason,
        chargedTokens: charged,
        usageSource: 'estimate',
        retryable: false,
        ...failure,
      });
    });
  }

  /**
   * 以模型步号与 call ID 建立唯一动作记录，校验输入摘要并复用已完成回执。
   * 发现/加载把实际 keys 与回执一起保存；交互暂停并释放租约，页面回复重新安全读取；写工具默认确认，偏好写始终确认，同运行相同成功写意图即使换 call ID 也复用。
   * 实际写入前重建身份，领域命令与动作成功回执、事件同事务提交；审批裁决要求引用已提供证据，并与流程结论和运行终态共同提交。读取动作可在回执保存前重试。
   */
  private async action(execution: Execution, call: ToolCall): Promise<void> {
    const { run } = execution,
      hash = digest({ tool: call.name, input: call.arguments });
    let action: any;
    await this.change(run, async (tx) => {
      const key = `${run.steps}:${call.id}`;
      const inserted = await tx
        .insertInto('sys.ai_action')
        .values({
          id: randomUUID(),
          run_id: run.id,
          tenant_id: run.tenant_id,
          call_id: key,
          tool: call.name,
          input: json(call.arguments),
          input_hash: hash,
        })
        .onConflict((oc) => oc.columns(['run_id', 'call_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) {
        const tool = toolsFor(execution).find((t) => t.name === call.name);
        await event(tx, run.id, 'tool.started', {
          callId: call.id,
          step: run.steps,
          tool: call.name,
          ...(/^(command|query)_/.test(call.name) && tool ? { name: tool.description.split(':')[0] } : {}),
        });
      }
      action = await tx
        .selectFrom('sys.ai_action')
        .selectAll()
        .where('run_id', '=', run.id)
        .where('call_id', '=', key)
        .executeTakeFirstOrThrow();
      if (action.input_hash !== hash) throw cageError('CONFLICT');
    });
    if (action.status === 'succeeded' || action.status === 'failed')
      return this.observe(run, call, action.result, action.id);
    let tool: Tool, args: any;
    try {
      ({ tool, args } = checkedTool(toolsFor(execution), call.name, call.arguments));
    } catch (err) {
      return this.actionError(run, action, call, err);
    }
    const interaction = await this.kernel.app
      .selectFrom('sys.ai_interaction')
      .selectAll()
      .where('action_id', '=', action.id)
      .executeTakeFirst();
    // 发现动作只改变下一次模型请求的工具集合；把真正装入预算的 keys 和回执一起保存，避免恢复时声称已加载却没有 schema。
    if (tool.effect === 'load' || tool.effect === 'discover') {
      try {
        const result = await tool.execute(execution, args);
        const search = tool.effect === 'discover' ? (result as { items: { key: string }[] }) : null;
        const requested = search ? search.items.map((item) => item.key) : (result as string[]);
        const keys = discoveredToolKeys(execution, requested, tool.effect === 'load');
        return this.receipt(
          run,
          action,
          call,
          {
            ...search,
            loaded: keys,
            notLoaded: requested.filter((key) => !keys.includes(key)),
            instruction:
              'loaded 中的工具已加载完整参数，下一步即可调用；无需再次 tool_load。未加载项可缩小搜索或显式选择 key。',
          },
          false,
          requested.length ? keys : (run.tool_keys ?? []),
        );
      } catch (error) {
        return this.actionError(run, action, call, error);
      }
    }
    // 未回答时持久暂停；回答中的页面数据还要重新安全读取，用户确认或浏览器快照本身都不是数据库事实。
    if (tool.effect === 'interaction') {
      if (!interaction?.answered_at)
        return this.wait(
          run,
          action,
          call.name === 'request_input' ? 'input' : 'page_context',
          args.prompt,
          {},
        );
      let result: unknown = interaction.response;
      if (interaction.response.pageContext) {
        const updated = await pageContext(this.kernel, execution.ctx, interaction.response.pageContext);
        await this.change(run, async (tx) => {
          await tx
            .updateTable('sys.ai_run')
            .set({
              page_context: json(interaction.response.pageContext),
              context: json({ ...run.context, page: updated }),
            })
            .where('id', '=', run.id)
            .execute();
          await event(tx, run.id, 'context.updated', {
            pageInstanceId: interaction.response.pageContext.pageInstanceId,
            revision: interaction.response.pageContext.revision,
          });
        });
        result = updated;
      }
      return this.receipt(run, action, call, result);
    }
    if (tool.effect === 'write') {
      // 同一任务、相同写意图重复出现时复用回执，即使模型换了 call ID 也不会再次提交。
      const old = await this.kernel.app
        .selectFrom('sys.ai_action')
        .select('result')
        .where('run_id', '=', run.id)
        .where('input_hash', '=', hash)
        .where('status', '=', 'succeeded')
        .executeTakeFirst();
      if (old) return this.receipt(run, action, call, old.result);
      if (
        (this.options.assistant?.confirmWrites !== false || call.name === 'memory_remember') &&
        !interaction
      ) {
        try {
          return this.wait(
            run,
            action,
            'confirmation',
            '请确认以下操作',
            await tool.preview?.(execution, args),
          );
        } catch (error) {
          return this.actionError(run, action, call, error);
        }
      }
      if (interaction && !interaction.answered_at) return;
      if (interaction?.response.approved === false)
        return this.receipt(run, action, call, { cancelled: true, reason: '用户拒绝该操作' });
      try {
        const ctx = await this.identity(await this.readRun(run.id));
        await this.change(run, async (tx) => {
          await sql`select set_config('statement_timeout', '10000', true)`.execute(tx);
          const result = await tool.execute({ ...execution, ctx }, args, tx);
          execution.signal.throwIfAborted();
          await this.guard(tx, run.id, run.lease_token);
          await tx
            .updateTable('sys.ai_action')
            .set({ status: 'succeeded', result: json(result ?? null), updated_at: sql`now()` })
            .where('id', '=', action.id)
            .execute();
          await event(tx, run.id, 'tool.completed', {
            callId: call.id,
            step: run.steps,
            tool: call.name,
            ok: true,
            toolCalls: run.tool_calls + 1,
          });
        });
        const saved = await this.kernel.app
          .selectFrom('sys.ai_action')
          .select('result')
          .where('id', '=', action.id)
          .executeTakeFirstOrThrow();
        return this.observe(run, call, saved.result, action.id);
      } catch (error) {
        return this.actionError(run, action, call, error);
      }
    }
    // 裁决是审批运行专用终结动作。非 manual 必须引用已提供来源，证据引用检查不宣称能证明模型推理正确。
    if (tool.effect === 'decision') {
      if (run.mode !== 'approval') throw new Error('AI_STATE_INVALID');
      const decision = parse(aiDecisionSchema, args);
      const sources = new Set([
        'subject',
        ...(run.history as ModelMessage[])
          .filter((m) => m.role === 'tool')
          .flatMap((m) => {
            try {
              return [JSON.parse(m.content).source].filter(Boolean);
            } catch {
              return [];
            }
          }),
      ]);
      if (
        decision.decision !== 'manual' &&
        (!decision.evidence.length || decision.evidence.some((e) => !sources.has(e.source)))
      )
        return this.actionError(run, action, call, cageError('INVALID_INPUT', '裁决必须引用已提供的证据'));
      const engine = engines(execution).find((e) => e.route.process === run.process)!;
      await this.change(run, async (tx) => {
        await engine.completeAi(tx, run.approval_step_id, run.id, decision, execution.ctx);
        await tx
          .updateTable('sys.ai_action')
          .set({ status: 'succeeded', result: json(decision) })
          .where('id', '=', action.id)
          .execute();
        await tx
          .updateTable('sys.ai_run')
          .set({
            status: 'succeeded',
            phase: 'done',
            answer: json(decision),
            pending: '[]',
            lease_token: null,
            lease_until: null,
          })
          .where('id', '=', run.id)
          .execute();
        await event(tx, run.id, 'message.completed', decision);
        await event(tx, run.id, 'run.status', { status: 'succeeded' });
      });
      return;
    }
    try {
      const result = await tool.execute(execution, args);
      execution.signal.throwIfAborted();
      await this.receipt(run, action, call, result);
    } catch (error) {
      await this.actionError(run, action, call, error);
    }
  }
  /**
   * 持久化待确认、补充输入或页面更新互动，并切换等待状态、释放执行租约。
   * 互动到期时间沿用委托期限，事件与状态同事务；等待期间不占 worker 执行槽位，回复由存储层重新排队。
   */
  private async wait(
    run: StoredRun,
    action: { id: string },
    kind: string,
    prompt: string,
    data: unknown,
  ): Promise<void> {
    await this.change(run, async (tx) => {
      const id = randomUUID();
      await tx
        .insertInto('sys.ai_interaction')
        .values({
          id,
          run_id: run.id,
          action_id: action.id,
          kind,
          prompt,
          data: json(data ?? {}),
          expires_at: run.delegated_until,
        })
        .execute();
      const status = kind === 'confirmation' ? 'waiting_confirmation' : 'waiting_input';
      await tx
        .updateTable('sys.ai_run')
        .set({ status, lease_token: null, lease_until: null })
        .where('id', '=', run.id)
        .execute();
      await event(tx, run.id, 'interaction.required', {
        id,
        kind,
        prompt,
        data,
        expiresAt: new Date(run.delegated_until).toISOString(),
      });
      await event(tx, run.id, 'run.status', { status });
    });
  }
  /**
   * 在租约事务中保存动作成功/失败结果、可选工具选择和 tool.completed 事件，然后独立追加观察。
   * 如果提交回执后进程退出，恢复会复用回执并继续 observe，不重复业务写；undefined 结果以 null 持久化。
   */
  private async receipt(
    run: StoredRun,
    action: { id: string },
    call: ToolCall,
    value: unknown,
    failed = false,
    toolKeys?: string[],
  ): Promise<void> {
    const result = value ?? null;
    await this.change(run, async (tx) => {
      await tx
        .updateTable('sys.ai_action')
        .set({ status: failed ? 'failed' : 'succeeded', result: json(result), updated_at: sql`now()` })
        .where('id', '=', action.id)
        .execute();
      if (toolKeys)
        await tx
          .updateTable('sys.ai_run')
          .set({ tool_keys: json(toolKeys) })
          .where('id', '=', run.id)
          .execute();
      await event(tx, run.id, 'tool.completed', {
        callId: call.id,
        step: run.steps,
        tool: call.name,
        ok: !failed,
        toolCalls: run.tool_calls + 1,
      });
    });
    await this.observe(run, call, result, action.id);
  }
  /**
   * 把可交给模型修正或解释的 CageError 保存为失败回执，只对 INVALID_INPUT 保留 detail。
   * LostLease、非 Cage 异常、UNAUTHENTICATED 和 INTERNAL 继续上抛终结或中止执行；FORBIDDEN 等其他 Cage 错误成为观察，不因此授予重试绕过权限。
   */
  private async actionError(
    run: StoredRun,
    action: { id: string },
    call: ToolCall,
    error: unknown,
  ): Promise<void> {
    if (error instanceof LostLease) throw error;
    // 未认证、内部故障和非 Cage 异常终结任务；FORBIDDEN 等其余业务错误作为失败观察返回，模型不能因此绕过权限。
    if (!isCageError(error) || ['UNAUTHENTICATED', 'INTERNAL'].includes(error.code)) throw error;
    await this.receipt(
      run,
      action,
      call,
      { error: error.code, detail: error.code === 'INVALID_INPUT' ? error.detail : undefined },
      true,
    );
  }
  /**
   * 把动作结果追加为匹配 call ID 的工具消息，移除队首 pending 并递增工具调用数。
   * 用户补充输入完整保留，较大证据缩为带动作引用的预览；使用锁下当前历史避免覆盖前一次状态，剩余调用继续 actions，否则回到 model。
   */
  private async observe(run: StoredRun, call: ToolCall, value: unknown, actionId?: string): Promise<void> {
    // 用户补充是任务输入，必须完整参与当前推理与跨轮恢复；大查询结果才使用预览。
    const preview = call.name === 'request_input' ? value : contextPreview(value);
    const observation =
      preview === value
        ? value
        : { truncated: true, source: (value as any)?.source, ref: { runId: run.id, actionId }, preview };
    await this.change(run, async (tx, current) => {
      const pending = current.pending.slice(1),
        history: ModelMessage[] = [
          ...current.history,
          {
            role: 'tool',
            toolCallId: call.id,
            content: json(observation),
            runId: run.id,
            ...(actionId ? { receipt: { runId: run.id, actionId } } : {}),
          },
        ];
      await tx
        .updateTable('sys.ai_run')
        .set({
          history: json(history),
          pending: json(pending),
          phase: pending.length ? 'actions' : 'model',
          tool_calls: current.tool_calls + 1,
        })
        .where('id', '=', run.id)
        .execute();
    });
  }
  /**
   * 持有一轮领取租约运行状态机，每 5 秒单次续租，组合外部停止、进程关闭、期限和失去租约信号。
   * 每步重新读取持久状态、处理遗留模型预留并核验身份/审批有效性；最近三次相同输入摘要触发无进展失败。
   * 失去租约退出；主动停机尝试重新排队，其他失败进入 fail；finally 清除续租定时器并等待在途续租结束。
   */
  private async execute(initial: StoredRun, outer?: AbortSignal): Promise<void> {
    const lease = new AbortController(),
      timeout = AbortSignal.timeout(Math.max(1, new Date(initial.deadline!).getTime() - Date.now()));
    const signal = AbortSignal.any([lease.signal, timeout, this.stopping.signal, ...(outer ? [outer] : [])]);
    let renewal: Promise<void> | null = null;
    const renew = setInterval(() => {
      if (renewal) return;
      renewal = this.kernel.app
        .updateTable('sys.ai_run')
        .set({ lease_until: new Date(Date.now() + LEASE_MS) })
        .where('id', '=', initial.id)
        .where('lease_token', '=', initial.lease_token)
        .where('status', '=', 'running')
        .where('lease_until', '>', new Date())
        .executeTakeFirst()
        .then(
          (r) => {
            if (Number(r.numUpdatedRows) !== 1) lease.abort(new LostLease());
          },
          () => lease.abort(new LostLease()),
        )
        .finally(() => {
          renewal = null;
        });
    }, 5000);
    try {
      for (;;) {
        signal.throwIfAborted();
        const run = await this.readRun(initial.id);
        if (run.status !== 'running' || run.lease_token !== initial.lease_token) return;
        if (run.model_reservation) {
          await this.settleUncertain(run, 'worker_recovered');
          continue;
        }
        const ctx = await this.identity(run);
        if (run.mode === 'approval') await this.approvalActive(run);
        const execution = { kernel: this.kernel, ontology: this.ontology, ctx, run, signal };
        if (run.phase === 'context') await this.prepareContext(run, ctx);
        else if (run.phase === 'model') {
          const actions = await this.kernel.app
            .selectFrom('sys.ai_action')
            .select('input_hash')
            .where('run_id', '=', run.id)
            .orderBy('created_at', 'desc')
            .limit(3)
            .execute();
          if (actions.length === 3 && actions.every((a) => a.input_hash === actions[0].input_hash))
            throw new Error('AI_NO_PROGRESS');
          await this.model(execution);
        } else if (run.phase === 'actions' && run.pending.length)
          await this.action(execution, run.pending[0]);
        else throw new Error('AI_STATE_INVALID');
      }
    } catch (error) {
      if (error instanceof LostLease || lease.signal.aborted) return;
      await this.settleUncertain(initial, 'execution_stopped');
      if (this.stopping.signal.aborted || outer?.aborted) {
        await this.change(initial, async (tx) => {
          await tx
            .updateTable('sys.ai_run')
            .set({ status: 'queued', lease_token: null, lease_until: null })
            .where('id', '=', initial.id)
            .execute();
        }).catch(() => {});
        return;
      }
      await this.fail(initial, error, timeout.aborted);
    } finally {
      clearInterval(renew);
      await renewal;
    }
  }
  /**
   * 将执行异常收敛为稳定代码，并在租约事务内终结运行。
   * 审批按 onFailure 决定系统转人工或标记失败，不能伪造模型通过/退回；人工接管不可用时仍标记失败，避免旧任务反复领取。
   * 租约已转移时不覆盖新执行者；原始上游错误正文不会成为公开运行错误。
   */
  private async fail(run: StoredRun, error: unknown, expired: boolean): Promise<void> {
    const code = isCageError(error)
      ? error.code
      : expired
        ? 'AI_TIMEOUT'
        : /^AI_[A-Z_]+$/.test((error as Error)?.message)
          ? (error as Error).message
          : 'AI_EXECUTION_FAILED';
    try {
      await this.change(run, async (tx, current) => {
        if (current.mode === 'approval' && current.policy.onFailure !== 'failed') {
          const engine = engines({ kernel: this.kernel }).find((e) => e.route.process === current.process)!;
          // 基础设施失败明确转人工，不伪造模型的通过/退回裁决。
          await engine.completeAi(tx, current.approval_step_id, current.id, {
            decision: 'manual',
            reason: `系统转人工：${code}`,
            suggestions: [],
            evidence: [],
          });
        } else if (current.mode === 'approval') {
          // 其他并行分支可能已经驳回/取消整轮；迟到模型失败只能终结仍可运行的节点，不能覆盖 skipped/cancelled。
          await tx
            .updateTable('flow.approval_step')
            .set({ status: 'failed' })
            .where('id', '=', current.approval_step_id)
            .where('run_id', '=', current.id)
            .where('status', 'in', ['queued', 'running'])
            .execute();
        }
        await tx
          .updateTable('sys.ai_run')
          .set({ status: expired ? 'expired' : 'failed', error: code, lease_token: null, lease_until: null })
          .where('id', '=', run.id)
          .execute();
        await event(tx, run.id, 'run.status', { status: expired ? 'expired' : 'failed', error: code });
      });
    } catch (failure) {
      if (failure instanceof LostLease) return;
      // 撤回/重提或人工接管失败也必须停下；不让不可执行的旧任务循环领取。
      await this.change(run, async (tx) => {
        await tx
          .updateTable('sys.ai_run')
          .set({
            status: 'failed',
            error: `${code}:HANDOFF_UNAVAILABLE`,
            lease_token: null,
            lease_until: null,
          })
          .where('id', '=', run.id)
          .execute();
        if (run.mode === 'approval')
          await tx
            .updateTable('flow.approval_step')
            .set({ status: 'failed' })
            .where('id', '=', run.approval_step_id)
            .where('status', '=', 'running')
            .where('run_id', '=', run.id)
            .execute();
        await event(tx, run.id, 'run.status', { status: 'failed', error: `${code}:HANDOFF_UNAVAILABLE` });
      }).catch((e) => {
        if (!(e instanceof LostLease)) throw e;
      });
    }
  }
}
