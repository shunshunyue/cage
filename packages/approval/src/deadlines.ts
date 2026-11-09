/**
 * 人工节点的自然时间办理政策及持久存储，由 route 校验声明、engine 在进入节点时写入。
 * 时限属于整个节点：领取、转办、委派和前后加签均不重置；这里只计时，不替代领域结论或自动批准。
 * 迁移在已发布审批表之上追加，旧实例没有时限或催办政策，升级不会自动启用新行为。
 */
import { declError } from '@yss123/cage-kernel';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';

/** 自然分钟时限；允许小数，精度至少一毫秒，最长一年，不包含工作日历或暂停扣时。 */
export interface ApprovalSla {
  /** 从进入节点起计算的总办理分钟数，前后加签共用这一截止时间。 */
  durationMinutes: number;
  /** 在截止前多少分钟产生临期提醒；省略只提醒超时，必须小于总时限。 */
  remindBeforeMinutes?: number;
}

/** 申请人催办政策随实例冻结；字段只标识申请人，不授予其审批结论能力。 */
export interface ApprovalReminderPolicy {
  /** routable 快照中的单个用户 UUID 字段，运行时还需当前用户有效且可见业务单据。 */
  requesterField: string;
  /** 两次成功催办间隔的自然分钟数，同实例各节点共用冷却；无收件人不占用冷却。 */
  cooldownMinutes: number;
}

const minutes = z.number().finite().min(1 / 60_000).max(525_600);
const slaSchema = z.strictObject({ durationMinutes: minutes, remindBeforeMinutes: minutes.optional() })
  .refine(value => value.remindBeforeMinutes === undefined || Math.round(value.remindBeforeMinutes * 60_000) < Math.round(value.durationMinutes * 60_000));
const reminderSchema = z.strictObject({ requesterField: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), cooldownMinutes: minutes });

/** 校验并冻结节点政策；未知键和不合理提前量明确报声明错误，不把配置失误静默当作关闭提醒。 */
export function approvalSla(value: ApprovalSla): Readonly<ApprovalSla> {
  const parsed = slaSchema.safeParse(value);
  if (!parsed.success) throw declError('CAGE-APPR-006', 'sla 须为有效自然分钟时限（至少一毫秒，最长一年），提前提醒必须小于总时限');
  return Object.freeze(parsed.data);
}

/** 校验申请人字段名与正数冷却；真正的字段存在性、routable 和公开性在注册表装配后再检查。 */
export function approvalReminderPolicy(value: ApprovalReminderPolicy): Readonly<ApprovalReminderPolicy> {
  const parsed = reminderSchema.safeParse(value);
  if (!parsed.success) throw declError('CAGE-APPR-006', 'reminders 需要有效 requesterField 和自然分钟 cooldownMinutes（至少一毫秒，最长一年）');
  return Object.freeze(parsed.data);
}

/**
 * 在进入人工节点的同一事务登记固定截止时间；使用数据库时间，服务重启不会丢失或重新计时。
 * next_notice_scan_at 是有界扫描的持久轮转位置，后续收件人变化可补投，不让已提醒的旧步骤长期占满扫描批次。
 */
export async function initializeDeadline(tx: Transaction<any>, instanceId: string, step: number, policy: ApprovalSla) {
  const duration = Math.round(policy.durationMinutes * 60_000);
  const before = policy.remindBeforeMinutes === undefined ? null : Math.round(policy.remindBeforeMinutes * 60_000);
  await tx.updateTable('flow.approval_step').set({
    due_at: sql`now() + ${duration} * interval '1 millisecond'`,
    remind_at: before === null ? null : sql`now() + ${duration - before} * interval '1 millisecond'`,
    next_notice_scan_at: sql`now() + ${duration - (before ?? 0)} * interval '1 millisecond'`,
  }).where('instance_id', '=', instanceId).where('step', '=', step).execute();
}

/** 前向迁移：时间只新增到节点，通知以来源/任务/接收人唯一；已读不删除历史，禁止修改已发布迁移。 */
export const APPROVAL_DEADLINES_MIGRATION = {
  name: 'cage:approval_deadlines_003',
  sql: `
ALTER TABLE flow.approval_instance ADD COLUMN reminder_policy jsonb;
ALTER TABLE flow.approval_instance ADD COLUMN next_urge_at timestamptz;
ALTER TABLE flow.approval_step ADD COLUMN due_at timestamptz;
ALTER TABLE flow.approval_step ADD COLUMN remind_at timestamptz;
ALTER TABLE flow.approval_step ADD COLUMN next_notice_scan_at timestamptz;
ALTER TABLE flow.approval_step ADD CONSTRAINT approval_step_deadline_order CHECK (remind_at IS NULL OR (due_at IS NOT NULL AND remind_at < due_at));
CREATE INDEX approval_step_notice_scan_idx ON flow.approval_step(next_notice_scan_at, instance_id) WHERE next_notice_scan_at IS NOT NULL;
CREATE TABLE flow.approval_notice (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  instance_id uuid NOT NULL REFERENCES flow.approval_instance(id),
  task_id uuid NOT NULL REFERENCES flow.approval_task(id),
  step integer NOT NULL,
  recipient_id uuid NOT NULL,
  source text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('due_soon','overdue','urge')),
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(instance_id, step, source, task_id, recipient_id)
);
CREATE INDEX approval_notice_recipient_idx ON flow.approval_notice(tenant_id, recipient_id, id);
CREATE INDEX approval_notice_unread_idx ON flow.approval_notice(tenant_id, recipient_id, id) WHERE read_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON flow.approval_notice TO cage_app;
GRANT USAGE, SELECT ON SEQUENCE flow.approval_notice_id_seq TO cage_app;
`,
};
