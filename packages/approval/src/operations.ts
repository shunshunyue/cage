/**
 * 通用审批运营运行时：worker 推进持久临期/超时提醒，HTTP/SDK 查询收件箱、本人申请和催办。
 * 写操作统一按实例→步骤/任务加锁，接收人实时核对授权、范围与当前责任；站内提醒不会自动通过、驳回或调用外部消息通道。
 * 本服务只使用宿主连接池；节点时限在数据库保存，跨进程靠实例锁与通知唯一键去重，停机后恢复只发送当前有效阶段。
 */
import { randomUUID } from 'node:crypto';
import { RUNTIME, MIGRATIONS, cageError, declError, loadUserGrants, userCtx,
  type Ctx, type Kernel, type Registry, type RuntimeDefinition, type RuntimeService } from '@yss123/cage-kernel';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { approvalUrgeSchema } from './operations-schema.js';
import { authorizedTaskActor, recordTaskAction } from './task-actions.js';
import { resolveApprovers } from './selectors.js';
import type { ApprovalStep } from './route.js';
import type { ApprovalReminderPolicy } from './deadlines.js';
import { ACTIVE_STEP_STATUSES, type BranchLocation, type ExecutableStep } from './execution.js';

/** 持久站内提醒摘要；不返回路由变量、人员政策或未掩码业务字段，ID 用十进制字符串避免 bigint 精度损失。 */
export interface ApprovalNoticeView {
  /** 服务端游标 ID，不能转成 JS number。 */
  id: string;
  /** 当前接收关系对应的任务与流程实例。 */
  taskId: string;
  instanceId: string;
  /** 已注册流程、业务对象类型及对象 ID，仅当前可见单据才会返回。 */
  process: string;
  aggregate: string;
  businessKey: string;
  /** 0 基节点索引及提交时保存的节点标题。 */
  step: number;
  title: string;
  /** 临期、超时或申请人催办；超时仍保持原来的审批状态。 */
  kind: 'due_soon' | 'overdue' | 'urge';
  /** 自动提醒为 null；人工催办记录当时申请人的用户 ID。 */
  actorId: string | null;
  /** 人工催办共享说明，自动提醒为 null；读取时仍校验当前接收资格。 */
  reason: string | null;
  /** UTC ISO 时间；readAt 为 null 表示本人尚未标记已读，dueAt 为 null 表示未声明时限。 */
  createdAt: string;
  readAt: string | null;
  dueAt: string | null;
}

/** 本人发起且仍运行的可见申请；只列实例明确保存 requesterField 政策的流程，不反推旧实例申请人。 */
export interface ApprovalRequestView {
  /** 实例 ID，用于催办目标，业务单据重提时新实例不会被旧页面误催办。 */
  id: string;
  /** 流程与单据定位；不暴露路由变量及敏感业务明文。 */
  process: string;
  aggregate: string;
  businessKey: string;
  /** 最小活跃节点索引，仅为旧客户端的兼容摘要；并行催办必须同时提交 currentSteps。 */
  currentStep: number;
  title: string;
  /** 全部活跃节点的索引；并行分支任一推进后旧集合失效。 */
  currentSteps: number[];
  /** 各分支当前环节及独立截止时间，主线 branchPath 为空。 */
  activeSteps: { step: number; title: string; dueAt: string | null; branchPath: BranchLocation[] }[];
  /** 节点总办理截止时间及下次可催办时间；null 分别代表无 SLA 和尚未催办。 */
  dueAt: string | null;
  nextUrgeAt: string | null;
}

/** 收件箱分页参数；after 是上次返回的十进制游标，过滤后本页可为空但仍返回后续游标。 */
export interface ApprovalNoticeOptions {
  after?: string;
  /** 默认 50，最多扫描 200 条本人记录；当前权限不符的记录不返回。 */
  limit?: number;
  /** true 仅扫描本人未读记录；省略或 false 包含已读。 */
  unreadOnly?: boolean;
}

const noticeOptionsSchema = z.strictObject({ after: z.string().regex(/^(0|[1-9]\d{0,18})$/)
  .refine(value => BigInt(value) <= 9223372036854775807n).optional(),
  limit: z.number().int().min(1).max(200).optional(), unreadOnly: z.boolean().optional() });
const services = new WeakMap<Kernel, ApprovalOperationsService>();

/** 有效时间统一按 UTC 序列化；数据库 null 保持为空，避免把无时限误显示为 1970 年。 */
function timestamp(value: Date | string | null | undefined): string | null { return value == null ? null : new Date(value).toISOString(); }

/** 仅把权限拒绝当作不适合接收；数据库、事务和未知异常必须回滚交给 worker 重试。 */
function permissionDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['FORBIDDEN', 'NOT_FOUND'].includes(String(error.code));
}

/** 当前实名用户重新加载角色与状态；传入的旧会话上下文不能让撤权/停用继续读取提醒。 */
async function currentActor(k: Kernel, tx: Transaction<any>, ctx: Ctx): Promise<Ctx> {
  if (ctx.actor?.kind !== 'user' || !ctx.userId) throw cageError('FORBIDDEN');
  const grants = await loadUserGrants(tx, ctx.userId, ctx.tenantId, k.catalogCaps());
  if (!grants) throw cageError('FORBIDDEN');
  return userCtx(grants);
}

/** 单据版本只读复核；原生审批不会为已变更业务对象继续发送可操作提醒，不直接修改其状态。 */
async function currentSubject(k: Kernel, tx: Transaction<any>, inst: any): Promise<boolean> {
  const binding = k.registry.approvalByProcess(inst.process)?.a;
  if (!binding) return false;
  const row = await tx.selectFrom(`${binding.agg.table.schema}.${binding.agg.table.name}`).select('version')
    .where('id', '=', inst.business_key).where('tenant_id', '=', inst.tenant_id).executeTakeFirst();
  return !!row && (inst.subject_version === null || row.version === inst.subject_version);
}

/** 读取当前申请人可见性而不获取业务明文；字段身份取实例快照，权限和范围始终取当前组织数据。 */
async function visibleRequest(k: Kernel, tx: Transaction<any>, inst: any, actor: Ctx, checkVersion = true): Promise<boolean> {
  const policy = inst.reminder_policy as ApprovalReminderPolicy | null;
  const binding = k.registry.approvalByProcess(inst.process)?.a;
  if (!policy || inst.vars[policy.requesterField] !== actor.userId || !binding || !actor.capabilities.has(`${binding.agg.name}.read`)) return false;
  if (checkVersion && !(await currentSubject(k, tx, inst))) return false;
  return !!(await k.read.tx(actor, read => read.selectFrom(`safe.${binding.agg.table.name}`).select('id')
    .where('id', '=', inst.business_key).executeTakeFirst()));
}

/** 接收目标仅保留任务 ID 与用户 ID；通知内容由受限公开投影构建，不复制领域变量。 */
interface Recipient { taskId: string; userId: string; step: number }

/**
 * 从当前节点 pending 票解析接收人，waiting 不催办；委派时受托人与原责任人均可接收。
 * 未领候选按当前组织规则且排除同节点已参与者，与 claim 的独立审批票边界一致；每个目标还需实时批准/read/范围权限。
 * 调用方持实例锁时，所有任务动作与此处串行；只读列表在事务内即时核验，不把历史接收人当作永久授权。
 */
async function recipients(k: Kernel, tx: Transaction<any>, inst: any, onlyUserId?: string,
  selection?: { maxRecipients: number; source?: string; step?: number }): Promise<Recipient[]> {
  if (inst.status !== 'running' || !(await currentSubject(k, tx, inst))) return [];
  const tasks = await tx.selectFrom('flow.approval_task as t')
    .innerJoin('flow.approval_step as s', join => join.onRef('s.instance_id', '=', 't.instance_id').onRef('s.step', '=', 't.step'))
    .selectAll('t').where('t.instance_id', '=', inst.id).where('t.tenant_id', '=', inst.tenant_id)
    .where('s.status', 'in', [...ACTIVE_STEP_STATUSES])
    .$if(selection?.step !== undefined, query => query.where('t.step', '=', selection!.step!)).orderBy('t.id').execute();
  const result: Recipient[] = [], authorized = new Map<string, boolean>();
  // 自动阶段只检查尚未投递的配对，每轮最多新增100条；后续扫描从唯一记录继续，不把上限当作丢弃尾部的规则。
  // 角色解析仍会读取当前候选集合；本轮限制投递事务规模，不承诺大规模组织目录的分页性能。
  const delivered = selection?.source ? await tx.selectFrom('flow.approval_notice').select(['task_id', 'recipient_id'])
    .where('instance_id', '=', inst.id).where('source', '=', selection.source).execute() : [];
  const existing = new Set(delivered.map(row => `${row.task_id}:${row.recipient_id}`));
  const candidates = new Map<number, string[]>();
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const node = (inst.steps as ApprovalStep[])[task.step];
    let people: string[];
    if (task.assignee) people = [...new Set([task.assignee, ...(task.delegation === 'pending' && task.owner_id ? [task.owner_id] : [])])] as string[];
    else {
      if (task.assignment !== 'candidate' || node.kind === 'ai' || node.assignment !== 'candidate') continue;
      if (!candidates.has(task.step)) candidates.set(task.step, await resolveApprovers(tx, node.approver, inst.vars, inst.tenant_id));
      people = candidates.get(task.step)!.filter(id => !tasks.some(peer => peer.step === task.step && peer.id !== task.id && (peer.assignee === id || peer.owner_id === id)));
    }
    for (const userId of people) {
      if (onlyUserId !== undefined && userId !== onlyUserId) continue;
      if (existing.has(`${task.id}:${userId}`)) continue;
      if (!authorized.has(userId)) {
        try { await authorizedTaskActor(k, tx, inst, userId); authorized.set(userId, true); }
        catch (error) { if (!permissionDenied(error)) throw error; authorized.set(userId, false); }
      }
      if (authorized.get(userId)) {
        result.push({ taskId: task.id, userId, step: task.step });
        if (selection && result.length >= selection.maxRecipients) return result;
      }
    }
  }
  return result;
}

/**
 * 在持实例锁事务内按来源/任务/接收人插入；自动阶段使用固定 source，人工催办每次使用独立 UUID。
 * 返回新增投递数，唯一冲突表示已送达，不重复写历史；任意写入失败会连同全部投递和冷却一起回滚。
 */
async function deliver(tx: Transaction<any>, inst: any, people: Recipient[], kind: ApprovalNoticeView['kind'], source: string,
  actorId: string | null = null, reason: string | null = null): Promise<number> {
  let count = 0;
  for (const person of people) {
    const row = await tx.insertInto('flow.approval_notice').values({ tenant_id: inst.tenant_id, instance_id: inst.id,
      task_id: person.taskId, step: person.step, recipient_id: person.userId, kind, source, actor_id: actorId, reason })
      .onConflict(conflict => conflict.columns(['instance_id', 'step', 'source', 'task_id', 'recipient_id']).doNothing())
      .returning('id').executeTakeFirst();
    if (row) count++;
  }
  return count;
}

/**
 * 原生审批的可选持久运营服务，公开方法重新校验内部调用输入，不依赖 HTTP 才执行校验。
 * 实例锁与 SQL 唯一键支持多个 worker；本对象不持有额外连接、定时器或队列，close 无需关闭宿主资源。
 */
export class ApprovalOperationsService implements RuntimeService {
  constructor(private readonly k: Kernel) {}

  /** 仅扫描当前仍注册的原生流程；没有 ROUTE 的空应用启用运行时也不访问不存在的 flow 表。 */
  private processes(): string[] { return this.k.registry.extensions.filter(ext => ext.kind === 'ROUTE').map(ext => ext.value.process); }

  /** 启动时验证新迁移可读；无原生路由时服务为空操作，不代替 migrate 自动建表。 */
  async ready(): Promise<void> {
    if (!this.processes().length) return;
    await this.k.app.selectFrom('flow.approval_step').select(['due_at', 'next_notice_scan_at']).limit(0).execute();
  }

  /** 服务不创建独立资源，停机时由宿主 worker 等待在途事务并关闭宿主连接。 */
  async close(): Promise<void> {}

  /**
   * 每轮最多检查 25 个到期节点，实例 FOR UPDATE SKIP LOCKED 后再读节点与任务，保持既有锁序。
   * 扫描时间持久后移一秒，已投递节点不会饿死后续节点；未找到当前合格人也保留后续补投机会。
   * 超时优先于临期，停机跨过截止时不会同时补两阶段；新接收人下一轮补投，既有人由唯一键去重。
   */
  async tick(signal?: AbortSignal): Promise<number> {
    const processes = this.processes();
    if (!processes.length || signal?.aborted) return 0;
    let delivered = 0;
    for (let index = 0; index < 25 && !signal?.aborted; index++) {
      const count = await this.k.app.transaction().execute(async tx => {
        const inst = await tx.selectFrom('flow.approval_instance as i')
          .innerJoin('flow.approval_step as s', 's.instance_id', 'i.id')
          .selectAll('i').select('s.step as timer_step').where('i.process', 'in', processes).where('i.status', '=', 'running')
          .where('s.status', '=', 'running').where('s.next_notice_scan_at', '<=', sql`now()`)
          .orderBy('s.next_notice_scan_at').orderBy('i.id').forUpdate('i').skipLocked().limit(1).executeTakeFirst();
        if (!inst) return null;
        const current = await tx.selectFrom('flow.approval_step').selectAll().where('instance_id', '=', inst.id)
          .where('step', '=', inst.timer_step).forUpdate().executeTakeFirstOrThrow();
        const clock = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx), now = new Date(clock.rows[0].now);
        // 加锁等待期间节点可能推进；必须复核当前行，不能沿锁前关联结果把新步骤当成旧计时器处理。
        if (current.status !== 'running' || current.due_at === null || current.next_notice_scan_at === null ||
          new Date(current.next_notice_scan_at).getTime() > now.getTime() ||
          new Date(current.remind_at ?? current.due_at).getTime() > now.getTime()) return 0;
        const dueAt = new Date(current.due_at).getTime();
        // 无效业务版本不会恢复，停止该节点后续扫描；状态仍由已有审批/领域命令流程负责。
        if (!(await currentSubject(this.k, tx, inst))) {
          await tx.updateTable('flow.approval_step').set({ next_notice_scan_at: null }).where('id', '=', current.id).execute();
          return 0;
        }
        await tx.updateTable('flow.approval_step').set({ next_notice_scan_at: new Date(now.getTime() + 1000) }).where('id', '=', current.id).execute();
        const kind = dueAt <= now.getTime() ? 'overdue' : 'due_soon';
        const count = await deliver(tx, inst, await recipients(this.k, tx, inst, undefined, { maxRecipients: 100, source: kind, step: current.step }), kind, kind);
        if (count) await recordTaskAction(tx, inst, null, null, 'reminded', null, { step: current.step, kind, recipientCount: count, dueAt: timestamp(current.due_at) });
        return count;
      });
      if (count === null) break;
      delivered += count;
    }
    return delivered;
  }

  /**
   * 本人收件箱按 bigint 游标递增分页，返回前重新核对当前任务接收关系与业务权限。
   * 转出、候选被他人领取、任务结束、停用或撤权后对应内容不再可见；过滤不篡改原始通知或全局已读状态。
   */
  async notices(ctx: Ctx, options: ApprovalNoticeOptions = {}): Promise<{ items: ApprovalNoticeView[]; nextCursor: string | null }> {
    const parsed = noticeOptionsSchema.safeParse(options);
    if (!parsed.success) throw cageError('INVALID_INPUT');
    return this.k.app.transaction().execute(async tx => {
      const actor = await currentActor(this.k, tx, ctx), limit = parsed.data.limit ?? 50;
      if (!this.processes().length) return { items: [], nextCursor: null };
      const rows = await tx.selectFrom('flow.approval_notice as n')
        .innerJoin('flow.approval_instance as i', 'i.id', 'n.instance_id')
        .innerJoin('flow.approval_step as s', join => join.onRef('s.instance_id', '=', 'i.id').onRef('s.step', '=', 'n.step'))
        .select(['n.id', 'n.task_id', 'n.instance_id', 'n.step', 'n.kind', 'n.actor_id', 'n.reason', 'n.created_at', 'n.read_at', 's.due_at'])
        .where('n.tenant_id', '=', actor.tenantId).where('i.tenant_id', '=', actor.tenantId).where('n.recipient_id', '=', actor.userId!)
        .where('n.id', '>', parsed.data.after ?? '0').where('i.status', '=', 'running').where('s.status', 'in', [...ACTIVE_STEP_STATUSES])
        .$if(parsed.data.unreadOnly === true, query => query.where('n.read_at', 'is', null)).orderBy('n.id').limit(limit + 1).execute();
      const items: ApprovalNoticeView[] = [], cache = new Map<string, { inst: any; tasks: Set<string> }>();
      for (const row of rows.slice(0, limit)) {
        if (!cache.has(row.instance_id)) {
          const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', row.instance_id)
            .where('tenant_id', '=', actor.tenantId).executeTakeFirstOrThrow();
          cache.set(row.instance_id, { inst, tasks: new Set((await recipients(this.k, tx, inst, actor.userId!)).map(person => person.taskId)) });
        }
        const entry = cache.get(row.instance_id)!;
        if (!entry.tasks.has(row.task_id)) continue;
        items.push({ id: String(row.id), taskId: row.task_id, instanceId: row.instance_id, process: entry.inst.process,
          aggregate: entry.inst.aggregate, businessKey: entry.inst.business_key, step: row.step, title: entry.inst.steps[row.step].title,
          kind: row.kind as ApprovalNoticeView['kind'], actorId: row.actor_id, reason: row.reason,
          createdAt: timestamp(row.created_at)!, readAt: timestamp(row.read_at), dueAt: timestamp(row.due_at) });
      }
      return { items, nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null };
    });
  }

  /** 本人已读是幂等操作；先锁实例再核验接收资格，不能用他人 ID 或旧转办页面修改提醒。 */
  async readNotice(id: string, ctx: Ctx): Promise<{ id: string; readAt: string }> {
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw cageError('INVALID_INPUT');
    return this.k.app.transaction().execute(async tx => {
      const actor = await currentActor(this.k, tx, ctx);
      if (!this.processes().length) throw cageError('NOT_FOUND');
      const notice = await tx.selectFrom('flow.approval_notice').selectAll().where('id', '=', id).where('tenant_id', '=', actor.tenantId)
        .where('recipient_id', '=', actor.userId!).executeTakeFirst();
      if (!notice) throw cageError('NOT_FOUND');
      const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', notice.instance_id)
        .where('tenant_id', '=', actor.tenantId).forUpdate().executeTakeFirstOrThrow();
      if (!(await recipients(this.k, tx, inst, actor.userId!)).some(person => person.taskId === notice.task_id)) throw cageError('NOT_FOUND');
      const row = await tx.updateTable('flow.approval_notice').set({ read_at: sql`coalesce(read_at, now())` }).where('id', '=', id)
        .where('recipient_id', '=', actor.userId!).returning('read_at').executeTakeFirstOrThrow();
      return { id, readAt: timestamp(row.read_at)! };
    });
  }

  /** 本人当前申请清单最多返回最近 200 项；当前 read/范围和提交版本均复核，旧实例不补造催办政策。 */
  async requests(ctx: Ctx): Promise<ApprovalRequestView[]> {
    return this.k.app.transaction().execute(async tx => {
      const actor = await currentActor(this.k, tx, ctx), processes = this.processes();
      if (!processes.length) return [];
      const rows = await tx.selectFrom('flow.approval_instance as i')
        .selectAll('i').where('i.tenant_id', '=', actor.tenantId).where('i.process', 'in', processes)
        .where('i.status', '=', 'running').where(sql<boolean>`i.vars ->> (i.reminder_policy ->> 'requesterField') = ${actor.userId}`)
        .orderBy('i.created_at', 'desc').limit(200).execute();
      const result: ApprovalRequestView[] = [];
      for (const inst of rows) if (await visibleRequest(this.k, tx, inst, actor)) {
        const active = await tx.selectFrom('flow.approval_step').select(['step', 'due_at']).where('instance_id', '=', inst.id)
          .where('status', 'in', [...ACTIVE_STEP_STATUSES]).orderBy('step').execute();
        const activeSteps = active.map(row => ({ step: row.step, title: inst.steps[row.step].title as string, dueAt: timestamp(row.due_at),
          branchPath: (inst.steps as ExecutableStep[])[row.step].execution?.branchPath ?? [] }));
        const deadlines = activeSteps.flatMap(row => row.dueAt ? [row.dueAt] : []).sort();
        result.push({ id: inst.id, process: inst.process, aggregate: inst.aggregate, businessKey: inst.business_key,
          currentStep: inst.current_step, currentSteps: activeSteps.map(row => row.step), activeSteps,
          title: activeSteps.map(row => row.title).join(' / '), dueAt: deadlines[0] ?? null, nextUrgeAt: timestamp(inst.next_urge_at) });
      }
      return result;
    });
  }

  /**
   * 发起人催办当前实例/节点；锁内再次检查业务版本、本人字段、范围与冷却，收件人与说明不可由客户端越权指定。
   * 一次成功催办独立来源去重，投递、不可覆盖动作历史与冷却同时提交；无可处理人工任务明确拒绝且不占冷却。
   */
  async urge(instanceId: string, ctx: Ctx, input: { expectedStep: number; expectedSteps?: number[]; reason: string }): Promise<{ recipientCount: number; nextUrgeAt: string }> {
    const parsed = approvalUrgeSchema.safeParse(input);
    if (!z.uuid().safeParse(instanceId).success || !parsed.success) throw cageError('INVALID_INPUT');
    return this.k.app.transaction().execute(async tx => {
      const actor = await currentActor(this.k, tx, ctx), processes = this.processes();
      if (!processes.length) throw cageError('NOT_FOUND');
      const inst = await tx.selectFrom('flow.approval_instance').selectAll().where('id', '=', instanceId).where('tenant_id', '=', actor.tenantId)
        .where('process', 'in', processes).forUpdate().executeTakeFirst();
      if (!inst || !(await visibleRequest(this.k, tx, inst, actor, false))) throw cageError('NOT_FOUND');
      if (inst.status !== 'running') throw cageError('INVALID_TRANSITION');
      if (inst.current_step !== parsed.data.expectedStep) throw cageError('CONFLICT', { reason: '审批节点已变化，请刷新后催办' });
      // 兼容摘要可能在另一分支推进时保持不变；并行实例必须核对完整集合，避免旧页面催办新环节。
      const active = await tx.selectFrom('flow.approval_step').select('step').where('instance_id', '=', inst.id)
        .where('status', 'in', [...ACTIVE_STEP_STATUSES]).orderBy('step').execute();
      const parallel = (inst.steps as ExecutableStep[]).some(node => node.execution?.branchPath.length);
      if (parallel && parsed.data.expectedSteps === undefined) throw cageError('INVALID_INPUT', { reason: '并行催办必须携带 expectedSteps' });
      if (parsed.data.expectedSteps && JSON.stringify(parsed.data.expectedSteps) !== JSON.stringify(active.map(row => row.step)))
        throw cageError('CONFLICT', { reason: '并行审批环节已变化，请刷新后催办' });
      if (!(await currentSubject(this.k, tx, inst))) throw cageError('CONFLICT', { reason: '审批所针对的业务版本已变化，请刷新后处理' });
      const clock = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx), now = new Date(clock.rows[0].now);
      if (inst.next_urge_at && new Date(inst.next_urge_at).getTime() > now.getTime())
        throw cageError('CONFLICT', { reason: '催办仍在冷却期内', nextUrgeAt: timestamp(inst.next_urge_at) });
      const people = await recipients(this.k, tx, inst, undefined, { maxRecipients: 201 });
      if (!people.length) throw cageError('INVALID_TRANSITION', { reason: '当前节点没有可接收提醒的人工审批人' });
      if (people.length > 200) throw cageError('INVALID_TRANSITION', { reason: '单次人工催办最多支持200个任务接收人，请缩小当前节点的审批范围' });
      const source = randomUUID(), recipientCount = await deliver(tx, inst, people, 'urge', source, actor.userId!, parsed.data.reason);
      const nextUrgeAt = new Date(now.getTime() + Math.round((inst.reminder_policy as ApprovalReminderPolicy).cooldownMinutes * 60_000));
      await tx.updateTable('flow.approval_instance').set({ next_urge_at: nextUrgeAt }).where('id', '=', inst.id).execute();
      await recordTaskAction(tx, inst, null, actor.userId!, 'urged', parsed.data.reason, { source, step: inst.current_step, steps: active.map(row => row.step), recipientCount, nextUrgeAt: nextUrgeAt.toISOString() });
      return { recipientCount, nextUrgeAt: nextUrgeAt.toISOString() };
    });
  }
}

/**
 * 取得当前内核唯一运营服务；只有 domain 显式导出 approvalOperations 才开放，不因安装包而隐式启用。
 * HTTP 和 worker 复用同一弱缓存对象，但一致性由数据库事务保证，不能依赖这个内存缓存跨进程去重。
 */
export function approvalOperationsService(kernel: Kernel): ApprovalOperationsService {
  if (!kernel.registry.extensions.some(ext => ext.kind === 'RUNTIME' && ext.value.name === 'approval-operations')) throw cageError('NOT_FOUND');
  let service = services.get(kernel);
  if (!service) { service = new ApprovalOperationsService(kernel); services.set(kernel, service); }
  return service;
}

/**
 * 独立 RUNTIME 声明启用审批运营；不能把同一对象同时标记 ROUTE，否则注册表只会识别其运行时身份。
 * 迁移由原生路由统一追加，空应用可以启用本声明且保持无操作；不新增生产角色能力或默认授权。
 */
export function approvalOperations(): RuntimeDefinition & { validate(registry: Registry): void } {
  return Object.freeze({ [RUNTIME]: true as const, name: 'approval-operations', spec: Object.freeze({}), capabilities: [],
    [MIGRATIONS]: () => [], service: approvalOperationsService,
    validate(registry: Registry) {
      if (registry.extensions.filter(ext => ext.kind === 'RUNTIME' && ext.value.name === 'approval-operations').length !== 1)
        throw declError('CAGE-APPR-006', '只能导出一个 approvalOperations 运行时');
    },
  });
}
