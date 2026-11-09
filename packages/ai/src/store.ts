/**
 * 持久化用户助理会话、运行提交、交互回复、事件和偏好。
 * HTTP 调用此层验证归属与当前指纹，worker 运行时继承此层推进任务；数据库中接受提交只表示 queued，不等于模型或业务动作已完成。
 */
import { randomUUID } from 'node:crypto';
import { cageError, type Ctx, type Kernel } from '@yss123/cage-kernel';
import { type Transaction, sql } from 'kysely';
import { z } from 'zod';
import {
  messageInputSchema,
  interactionResponseSchema,
  personalitySelectionSchema,
  type AiRun,
  type AiEvent,
  type AiSession,
  type AiMemory,
  type AiEventType,
} from '@yss123/cage-ai-protocol';
import { authFingerprint, digest, needUser, parse } from './security.js';
import { DEFAULT_LIMITS, TERMINAL, type AiOptions } from './types.js';
import { PersonalityManager, personalitySummary } from './personalities.js';
import { reservedTokens } from './budget.js';

/**
 * 将值序列化为数据库 JSON 字段文本；调用方须先完成结构校验，不在此隐藏不可序列化错误。
 */
export const json = (value: unknown): string => JSON.stringify(value);
/**
 * 把数据库时间值转为 UTC ISO 字符串供协议 DTO 使用；无效时间直接抛错，不用本机时间静默替代。
 */
export const iso = (value: any): string => new Date(value).toISOString();
/**
 * 把会话数据库行转换为公开 DTO，保留性格选择版本供并发切换校验，不暴露租户/用户存储字段。
 */
const sessionDto = (r: any): AiSession => ({
  id: r.id,
  title: r.title,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  personalityKey: r.personality_key,
  personalityVersion: r.personality_version,
});

/** 所有流事件在持有 run 行锁的事务内编号；断线可以按 sequence 重放。 */
/**
 * 在持有运行行锁的事务内递增 sequence 并插入事件，运行更新时间同步刷新。
 * 调用方必须把业务状态变更放在同一事务，使重连按序重放时不会看见未提交状态；此函数不负责 HTTP 推送。
 */
export async function event(tx: Transaction<any>, runId: string, type: AiEventType, data: unknown): Promise<void> {
  const row = await tx
    .updateTable('sys.ai_run')
    .set({ next_seq: sql`next_seq + 1`, updated_at: sql`now()` })
    .where('id', '=', runId)
    .returning('next_seq')
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('sys.ai_event')
    .values({ run_id: runId, sequence: row.next_seq, type, data: json(data) })
    .execute();
}

/**
 * 用户助理持久化服务，也是 AiRuntime 的状态存取基础。
 * 公开读取先验证用户归属、注册表与授权指纹；提交、取消及互动用事务协调并发，模型执行和业务工具调用由运行时承担。
 */
export class AiStore {
  /**
   * 会话创建、切换和运行快照共用的租户性格服务。
   */
  readonly personalities: PersonalityManager;
  /**
   * 绑定内核、AI 声明选项及注册表指纹，并创建共用性格服务；构造时不创建会话或启动 worker。
   */
  constructor(
    readonly kernel: Kernel,
    readonly options: AiOptions,
    readonly fingerprint: string,
  ) {
    this.personalities = new PersonalityManager(kernel);
  }

  /**
   * 验证助理用户及标题，在事务中确认指定或默认性格存在且启用，再创建归属当前租户/用户的会话。
   * null 性格 key 表示跟随租户默认项；本步骤不调用模型。
   */
  async createSession(ctx: Ctx, title = '新会话', personalityKey: string | null = null): Promise<AiSession> {
    needUser(ctx);
    parse(z.string().trim().min(1).max(160), title);
    return this.kernel.app.transaction().execute(async (tx) => {
      await this.personalities.resolve(ctx, personalityKey, tx);
      return sessionDto(
        await tx
          .insertInto('sys.ai_session')
          .values({
            id: randomUUID(),
            tenant_id: ctx.tenantId,
            user_id: ctx.userId,
            title,
            personality_key: personalityKey,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }
  /**
   * 返回当前租户用户最近更新的至多 100 个会话；不提供跨用户管理视图或全量导出。
   */
  async sessions(ctx: Ctx): Promise<AiSession[]> {
    needUser(ctx);
    const rows = await this.kernel.app
      .selectFrom('sys.ai_session')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .orderBy('updated_at', 'desc')
      .limit(100)
      .execute();
    return rows.map(sessionDto);
  }
  /**
   * 锁定本人会话并比较 personality_version 后切换性格，递增版本。
   * 目标必须启用，null 表示默认项；只影响以后提交的轮次，不修改运行已经保存的性格快照。
   */
  async selectPersonality(ctx: Ctx, sessionId: string, raw: unknown): Promise<AiSession> {
    needUser(ctx);
    const input = parse(personalitySelectionSchema, raw);
    return this.kernel.app.transaction().execute(async (tx) => {
      const session = await this.ownedSession(ctx, sessionId, tx, true);
      if (session.personality_version !== input.version) throw cageError('CONFLICT');
      await this.personalities.resolve(ctx, input.key, tx);
      return sessionDto(
        await tx
          .updateTable('sys.ai_session')
          .set({ personality_key: input.key, personality_version: input.version + 1, updated_at: new Date() })
          .where('id', '=', sessionId)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }
  /**
   * 验证 UUID、登录身份和租户/用户归属后读取会话；不存在或无归属统一 NOT_FOUND。
   * 可在调用方事务中加行锁，用于提交与性格切换的并发协调。
   */
  async ownedSession(ctx: Ctx, id: string, db = this.kernel.app, lock = false) {
    needUser(ctx);
    parse(z.uuid(), id);
    let query = db
      .selectFrom('sys.ai_session')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId);
    if (lock) query = query.forUpdate();
    const r = await query.executeTakeFirst();
    if (!r) throw cageError('NOT_FOUND');
    return r;
  }
  /**
   * 验证运行归属，并拒绝注册声明或授权指纹已变化的旧记录。
   * 旧回答和事件也可能包含现在不该看到的信息，因此读取同样执行指纹复核；返回内部行供本层转换，不直接作为公开 DTO。
   */
  async ownedRun(ctx: Ctx, id: string, db = this.kernel.app) {
    needUser(ctx);
    parse(z.uuid(), id);
    const r = await db
      .selectFrom('sys.ai_run')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .executeTakeFirst();
    if (!r) throw cageError('NOT_FOUND');
    // 声明可能新增隐藏字段或改变查询含义，旧版本生成的回答和事件也必须停止交付。
    if (r.fingerprint !== this.fingerprint) throw cageError('CONFLICT', '注册声明已变化，请重新发起任务');
    if (r.auth_fingerprint && r.auth_fingerprint !== authFingerprint(ctx))
      throw cageError('FORBIDDEN', '授权已变化，请开启新会话');
    return r;
  }
  /**
   * 校验启用状态、消息/页面快照及最多 80 KiB 输入，按用户事务锁执行幂等提交。
   * 相同请求键与内容复用已有运行，不重复占队列；同键不同内容冲突。锁会话后冻结性格、权限和注册表快照，非终态队列默认最多 8 个。
   * 创建 queued 运行、首个状态事件和会话更新时间共同提交，默认委托期限 30 分钟；返回状态快照，实际工作由 worker 异步执行。
   */
  async submit(ctx: Ctx, sessionId: string, input: unknown, requestKey: string, authSession?: string): Promise<AiRun> {
    needUser(ctx);
    if (!this.options.assistant) throw cageError('NOT_FOUND');
    const body = parse(messageInputSchema, input);
    parse(z.string().min(1).max(160), requestKey);
    if (Buffer.byteLength(json(body)) > 80 * 1024) throw cageError('INVALID_INPUT', '消息上下文超过限制');
    const hash = digest({ sessionId, body });
    const id = await this.kernel.app.transaction().execute(async (tx) => {
      // 同一用户并发请求共享配额锁；幂等键不会因重试消耗第二个队列名额。
      await sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId}), hashtext(${ctx.userId}))`.execute(tx);
      const old = await tx
        .selectFrom('sys.ai_run')
        .selectAll()
        .where('tenant_id', '=', ctx.tenantId)
        .where('user_id', '=', ctx.userId)
        .where('request_key', '=', requestKey)
        .executeTakeFirst();
      if (old) {
        if (old.request_hash !== hash) throw cageError('CONFLICT');
        return old.id;
      }
      const session = await this.ownedSession(ctx, sessionId, tx, true);
      const personality = await this.personalities.resolve(ctx, session.personality_key, tx);
      const count = await tx
        .selectFrom('sys.ai_run')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('tenant_id', '=', ctx.tenantId)
        .where('user_id', '=', ctx.userId)
        .where('status', 'not in', TERMINAL)
        .executeTakeFirstOrThrow();
      if (count.n >= (this.options.maxQueuedPerUser ?? 8)) throw cageError('RATE_LIMITED');
      const id = randomUUID(),
        assistant = this.options.assistant!;
      await tx
        .insertInto('sys.ai_run')
        .values({
          id,
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          session_id: sessionId,
          mode: 'assistant',
          status: 'queued',
          input: body.message,
          page_context: body.pageContext ? json(body.pageContext) : null,
          personality: json(personality),
          model: assistant.model,
          instructions: assistant.instructions ?? '',
          limits: json({ ...DEFAULT_LIMITS, ...assistant.limits }),
          fingerprint: this.fingerprint,
          auth_fingerprint: authFingerprint(ctx),
          auth_session: authSession ?? null,
          delegated_until: new Date(Date.now() + (this.options.delegationTtlMs ?? 30 * 60_000)),
          step_up_at: ctx.stepUpAt ?? null,
          request_key: requestKey,
          request_hash: hash,
        })
        .execute();
      await event(tx, id, 'run.status', { status: 'queued' });
      await tx
        .updateTable('sys.ai_session')
        .set({ updated_at: sql`now()` })
        .where('id', '=', sessionId)
        .execute();
      return id;
    });
    return this.run(ctx, id);
  }
  /**
   * 读取经归属/指纹复核的运行 DTO及未回复互动。
   * 终态一律不再交付待处理互动，避免客户端继续确认已结束任务；不返回内部模型历史、租约或凭据。
   */
  async run(ctx: Ctx, id: string): Promise<AiRun> {
    const r = await this.ownedRun(ctx, id);
    const interactions = await this.kernel.app
      .selectFrom('sys.ai_interaction')
      .selectAll()
      .where('run_id', '=', id)
      .where('answered_at', 'is', null)
      .orderBy('created_at')
      .execute();
    return {
      id,
      sessionId: r.session_id,
      status: r.status,
      phase: r.phase,
      answer: r.answer,
      error: r.error,
      steps: r.steps,
      toolCalls: r.tool_calls,
      tokens: r.tokens,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      ...(r.personality ? { personality: personalitySummary(r.personality) } : {}),
      interactions: TERMINAL.includes(r.status)
        ? []
        : interactions.map((i) => ({
            id: i.id,
            kind: i.kind,
            prompt: i.prompt,
            data: i.data,
            expiresAt: iso(i.expires_at),
          })),
    };
  }
  /**
   * 验证本人会话后取最近 100 个运行，再按时间正序逐个执行 run 的指纹检查。
   * 任一旧记录授权不再匹配时拒绝交付，不把旧敏感答案当作普通会话缓存返回。
   */
  async runs(ctx: Ctx, sessionId: string): Promise<AiRun[]> {
    await this.ownedSession(ctx, sessionId);
    const rows = await this.kernel.app
      .selectFrom('sys.ai_run')
      .select('id')
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    const runs = [];
    for (const r of rows.reverse()) runs.push(await this.run(ctx, r.id));
    return runs;
  }
  /**
   * 读取指定序号之后的单页事件，默认从 0 开始；授权与每页数量规则由 eventPage 统一执行。
   */
  async events(ctx: Ctx, id: string, after = 0): Promise<AiEvent[]> {
    return (await this.eventPage(ctx, id, after)).events;
  }
  /** SSE 同时读取状态与事件，避免每次追赶都再次查询完整运行及互动列表。 */
  /**
   * 验证归属与当前指纹，读取 after 之后最多 200 条有序事件及运行状态/最新序号。
   * SSE 据此判断是否追平或终止；状态和事件不是额外长事务快照，下一页继续通过序号追赶。
   */
  async eventPage(
    ctx: Ctx,
    id: string,
    after = 0,
  ): Promise<{ status: AiRun['status']; nextSequence: number; events: AiEvent[] }> {
    const run = await this.ownedRun(ctx, id);
    parse(z.number().int().nonnegative(), after);
    const rows = await this.kernel.app
      .selectFrom('sys.ai_event')
      .selectAll()
      .where('run_id', '=', id)
      .where('sequence', '>', after)
      .orderBy('sequence')
      .limit(200)
      .execute();
    return {
      status: run.status,
      nextSequence: run.next_seq,
      events: rows.map((r) => ({
        runId: id,
        sequence: r.sequence,
        type: r.type,
        data: r.data,
        createdAt: iso(r.created_at),
      })),
    };
  }
  /**
   * 锁定本人运行后标记取消并清除租约，终态重复取消不做变更。
   * 尚未结算的模型预留按估算一次性计入累计 Token，同时写失败和取消事件；取消阻止后续租约提交，但不会撤销之前已完成的业务命令。
   */
  async cancel(ctx: Ctx, id: string): Promise<AiRun> {
    await this.kernel.app.transaction().execute(async (tx) => {
      await this.ownedRun(ctx, id, tx);
      const run = await tx
        .selectFrom('sys.ai_run')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (TERMINAL.includes(run.status)) return;
      const charged = run.model_reservation ? reservedTokens(run.model_reservation) : 0;
      await tx
        .updateTable('sys.ai_run')
        .set({
          cancelled: true,
          status: 'cancelled',
          lease_token: null,
          lease_until: null,
          model_reservation: null,
          tokens: run.tokens + charged,
        })
        .where('id', '=', id)
        .execute();
      if (run.model_reservation)
        await event(tx, id, 'model.failed', {
          attempt: run.model_reservation.attempt,
          reason: 'cancelled',
          chargedTokens: charged,
          usageSource: 'estimate',
          retryable: false,
        });
      await event(tx, id, 'run.status', { status: 'cancelled' });
    });
    return this.run(ctx, id);
  }
  /**
   * 在运行行锁内保存确认、补充输入或页面快照回复，再把等待运行排回 queued。
   * 相同已回答内容幂等返回，不同内容冲突；拒绝过期、类型不符、其他页面实例或倒退版本快照。
   * 只记录用户回复，不在 HTTP 事务直接执行工具，worker 恢复时仍重新核验权限与业务状态。
   */
  async respond(ctx: Ctx, id: string, interactionId: string, input: unknown): Promise<AiRun> {
    parse(z.uuid(), interactionId);
    const body = parse(interactionResponseSchema, input);
    await this.kernel.app.transaction().execute(async (tx) => {
      await this.ownedRun(ctx, id, tx);
      const run = await tx
        .selectFrom('sys.ai_run')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const interaction = await tx
        .selectFrom('sys.ai_interaction')
        .selectAll()
        .where('id', '=', interactionId)
        .where('run_id', '=', id)
        .executeTakeFirst();
      if (!interaction) throw cageError('NOT_FOUND');
      if (interaction.answered_at) {
        if (digest(interaction.response) !== digest(body)) throw cageError('CONFLICT');
        return;
      }
      if (
        !['waiting_confirmation', 'waiting_input'].includes(run.status) ||
        new Date(interaction.expires_at).getTime() <= Date.now()
      )
        throw cageError('CONFLICT');
      if (
        (interaction.kind === 'confirmation' && body.approved === undefined) ||
        (interaction.kind === 'input' && body.answer === undefined) ||
        (interaction.kind === 'page_context' && !body.pageContext)
      )
        throw cageError('INVALID_INPUT');
      if (
        body.pageContext &&
        run.page_context &&
        (body.pageContext.pageInstanceId !== run.page_context.pageInstanceId ||
          body.pageContext.revision < run.page_context.revision)
      )
        throw cageError('CONFLICT', '页面快照来自其他页面或旧版本');
      await tx
        .updateTable('sys.ai_interaction')
        .set({ response: json(body), answered_at: sql`now()` })
        .where('id', '=', interactionId)
        .execute();
      await tx.updateTable('sys.ai_run').set({ status: 'queued', deadline: null }).where('id', '=', id).execute();
      await event(tx, id, 'run.status', { status: 'queued' });
    });
    return this.run(ctx, id);
  }
  /**
   * 返回当前租户用户最近更新的最多 50 条偏好；只读本人数据，内容不因被记忆就获得指令优先级。
   */
  async memories(ctx: Ctx): Promise<AiMemory[]> {
    needUser(ctx);
    const rows = await this.kernel.app
      .selectFrom('sys.ai_memory')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((r) => ({ id: r.id, key: r.key, value: r.value, updatedAt: iso(r.updated_at) }));
  }
  /**
   * 按 UUID 和当前租户/用户归属删除偏好；目标不存在时也完成，重复删除不产生额外副作用。
   */
  async deleteMemory(ctx: Ctx, id: string): Promise<void> {
    needUser(ctx);
    parse(z.uuid(), id);
    await this.kernel.app
      .deleteFrom('sys.ai_memory')
      .where('id', '=', id)
      .where('tenant_id', '=', ctx.tenantId)
      .where('user_id', '=', ctx.userId)
      .execute();
  }
}
