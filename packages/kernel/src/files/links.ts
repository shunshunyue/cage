// 文件字节属于存储扩展；内核只在命令事务里维护独占关联，清理也锁同一文件行。
import type { Transaction } from 'kysely';
import { cageError } from '../errors.js';
import type { AnyAggregate } from '../primitives/aggregate.js';
import { isFile, type Fields } from '../primitives/fields.js';
import type { Ctx } from '../types.js';

/**
 * 把已完成临时上传绑定到业务对象，或将被移除附件退回临时状态；全程处于主命令事务中。
 * 先归一化 ID/拒绝重复，再按 ID 排序加锁，与清理任务争用同一行锁以避免刚绑定就被清掉。
 * 新增必须属于当前真人、聚合、字段与目标对象，且状态 ready、未过期、符合当前字段政策。
 * 移除只解绑，不立即删除字节；延长 24 小时临时期限后交由文件清理服务处理。
 */
export async function writeFileLinks(tx: Transaction<any>, agg: AnyAggregate, previous: Record<string, any>, next: Record<string, any>, ctx: Ctx) {
  const changes: { key: string; added: string[]; removed: string[] }[] = [];
  const ids = (value: unknown): string[] => value == null ? [] : (Array.isArray(value) ? value : [value]) as string[];
  for (const [key, field] of Object.entries(agg.fields as Fields)) if (isFile(field)) {
    const old = ids(previous[key]), current = ids(next[key]).map(id => id.toLowerCase());
    if (new Set(current).size !== current.length) throw cageError('INVALID_INPUT', { field: key, message: '附件不能重复' });
    next[key] = field.kind === 'files' ? current : current[0] ?? null;
    changes.push({ key, added: current.filter(id => !old.includes(id)), removed: old.filter(id => !current.includes(id)) });
  }
  const all = [...new Set(changes.flatMap(c => [...c.added, ...c.removed]))].sort();
  if (!all.length) return;
  const rows = await tx.selectFrom('sys.file_upload').selectAll().where('tenant_id', '=', ctx.tenantId).where('id', 'in', all).orderBy('id').forUpdate().execute();
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const { key, added, removed } of changes) {
    const policy = (agg.fields as Fields)[key].filePolicy!;
    for (const id of added) {
      const row = byId.get(id);
      if (!row || row.aggregate_name !== agg.name || row.field_name !== key ||
          row.user_id !== (ctx.userId ?? ctx.onBehalfOf) || (row.target_id && row.target_id !== next.id)) throw cageError('NOT_FOUND');
      if (row.status !== 'ready' || new Date(row.expires_at) <= new Date()) throw cageError('CONFLICT', '附件未完成、已绑定或已过期');
      if (Number(row.bytes) > policy.maxBytes || !policy.accept.includes(row.content_type)) throw cageError('INVALID_INPUT', { field: key, message: '附件不符合当前字段限制' });
      await tx.updateTable('sys.file_upload').set({ status: 'bound', bound_id: next.id }).where('id', '=', id).execute();
      // 同一事务若试图把一个文件绑定到多个字段/对象，也会被拒绝。
      row.status = 'bound'; row.bound_id = next.id;
    }
    for (const id of removed) {
      const row = byId.get(id);
      if (!row || row.status !== 'bound' || row.bound_id !== next.id || row.aggregate_name !== agg.name || row.field_name !== key)
        throw cageError('CONFLICT', '附件关联不一致');
      // 移除后保留一段时间供恢复；下载不再沿用原业务对象的权限。
      await tx.updateTable('sys.file_upload').set({ status: 'ready', bound_id: null, expires_at: new Date(Date.now() + 86400_000) }).where('id', '=', id).execute();
    }
  }
}
