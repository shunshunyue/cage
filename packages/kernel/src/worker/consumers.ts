// 内核自带的事件消费者：异步反应、审批启动与取消。连接器出站映射等由声明对象通过 CONSUMERS 扩展点提供。
import type { Transaction } from 'kysely';
import { CONSUMERS } from '../brands.js';
import type { Kernel } from '../kernel.js';
import { systemCtx } from '../org.js';
import { loadScoped } from '../pipeline/load.js';
import type { Approval } from '../primitives/flow.js';
import { reactionEntries, reactionEntryError } from '../primitives/collection.js';
import type { EventConsumer, OutboxRow } from './outbox.js';

/** 审批引擎的最小接口（完整接口见 @yss123/cage-approval）。引擎只给结论，结论由桥接代码转成命令。 */
export interface ApprovalEngine {
  start(input: {
    process: string;
    businessKey: string;
    tenantId: string;
    /** 只包含声明过的 routable 字段 */
    vars: Record<string, unknown>;
    subjectVersion?: number;
    eventId?: number;
    tx: Transaction<any>;
  }): Promise<{ instanceId: string }>;
  cancel(input: { process: string; businessKey: string; tenantId: string; tx: Transaction<any> }): Promise<void>;
}

function actorUser(row: OutboxRow): string | null {
  return row.actor?.userId ?? row.actor?.onBehalfOf ?? null;
}

export function reactionConsumers(k: Kernel): EventConsumer[] {
  const events = new Set(k.registry.reactions.map(({ r }) => r.event.name));
  return [...events].flatMap((event) => k.registry.reactionsFor(event).filter(({ r }) => r.tx === 'outbox'))
    .map(({ r, name }) => ({
      name: `reaction:${name}`,
      event: r.event.name,
      async handle(row, tx) {
        const ctx = systemCtx({
          kind: 'reaction',
          name,
          tenantId: row.tenant_id,
          capabilities: [k.registry.capabilityOf(r.command)],
          onBehalfOf: actorUser(row),
          requestId: row.request_id ?? undefined,
        });
        // 集合调用和去重登记共享同一事务；串行执行保留声明的锁顺序。
        for (const entry of reactionEntries(r, row.payload)) {
          try { await k.executeIn(tx, r.command, entry.input, ctx, 0); }
          catch (error) { throw reactionEntryError(error, r, name, entry); }
        }
      },
    }));
}

/** 审批启动：只把 routable 字段作为流程变量传给引擎 */
export function approvalConsumers(k: Kernel, engines: Record<string, ApprovalEngine>): EventConsumer[] {
  const out: EventConsumer[] = [];
  for (const { a, name } of k.registry.approvals) {
    const engine = engines[a.process];
    if (!engine) {
      throw new Error(`[CAGE-WORKER-001] 审批绑定 ${name} 缺少流程 ${a.process} 的审批引擎；补齐路由或装配引擎后再启动 worker`);
    }
    out.push({
      name: `approval:${name}:start`,
      event: a.start.name,
      async handle(row, tx) {
        const vars = await routableVars(k, a, row, tx);
        await engine.start({ process: a.process, businessKey: row.aggregate_id, tenantId: row.tenant_id, vars, tx, subjectVersion: row.aggregate_version ?? undefined, eventId: row.id });
      },
    });
    for (const ev of a.cancelOn) {
      out.push({
        name: `approval:${name}:cancel:${ev.name}`,
        event: ev.name,
        async handle(row, tx) {
          await engine.cancel({ process: a.process, businessKey: row.aggregate_id, tenantId: row.tenant_id, tx });
        },
      });
    }
  }
  return out;
}

async function routableVars(k: Kernel, a: Approval, row: OutboxRow, tx: Transaction<any>) {
  const ctx = systemCtx({ kind: 'process', name: a.process, tenantId: row.tenant_id, capabilities: [] });
  const snap = await loadScoped(tx, a.agg, row.aggregate_id, ctx, false);
  const vars: Record<string, unknown> = {};
  for (const f of a.routable) vars[f] = snap?.[f] ?? (row.payload as any)?.[f] ?? null;
  return vars;
}

/** 声明对象通过 CONSUMERS 扩展点提供的消费者（例如 @yss123/cage-connectors 的出站映射） */
export function extensionConsumers(k: Kernel): EventConsumer[] {
  return k.registry.consumerProviders().flatMap((p) => (p[CONSUMERS](k) as EventConsumer[]) ?? []);
}

/** 从 ROUTE 扩展（代码内封闭路由）里找审批引擎 */
export function routeEngines(k: Kernel): Record<string, ApprovalEngine> {
  const out: Record<string, ApprovalEngine> = {};
  for (const e of k.registry.extensions) {
    if (e.kind === 'ROUTE' && typeof e.value?.engine === 'function') out[e.value.process] = e.value.engine(k);
  }
  return out;
}
