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

export const json = (value: unknown): string => JSON.stringify(value);
export const iso = (value: any): string => new Date(value).toISOString();
const sessionDto = (r: any): AiSession => ({
  id: r.id,
  title: r.title,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  personalityKey: r.personality_key,
  personalityVersion: r.personality_version,
});

/** 所有流事件在持有 run 行锁的事务内编号；断线可以按 sequence 重放。 */
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

export class AiStore {
  readonly personalities: PersonalityManager;
  constructor(
    readonly kernel: Kernel,
    readonly options: AiOptions,
    readonly fingerprint: string,
  ) {
    this.personalities = new PersonalityManager(kernel);
  }

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
  async events(ctx: Ctx, id: string, after = 0): Promise<AiEvent[]> {
    return (await this.eventPage(ctx, id, after)).events;
  }
  /** SSE 同时读取状态与事件，避免每次追赶都再次查询完整运行及互动列表。 */
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
