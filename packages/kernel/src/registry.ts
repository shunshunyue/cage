// 注册表：遍历 domain 包的导出，靠品牌标记识别原语，用导出名给命令和反应命名。
import { CONSUMERS, CONNECTOR, INBOUND, OUTBOUND, ROUTE, SYSTEM_DDL, brandOf } from './brands.js';
import { declError } from './errors.js';
import { type AnyAggregate, sensitiveFields } from './primitives/aggregate.js';
import type { AnyCommand } from './primitives/command.js';
import type { AnyEvent } from './primitives/event.js';
import type { AnyQuery, AnyReaction, Approval, Job } from './primitives/flow.js';

export interface RegisteredCommand {
  readonly cmd: AnyCommand;
  /** 命令名（导出名或显式 name） */
  readonly name: string;
  /** 能力点：聚合名.命令名 */
  readonly capability: string;
  readonly exportName: string;
}

export interface CatalogEntry {
  capability: string;
  kind: 'command' | 'read' | 'export' | 'unmask' | 'system';
  aggregate?: string;
  description?: string;
  /** 命令的调用方限制，管理界面据此提示 */
  invokedBy?: readonly string[];
}

export interface RuntimeExtension {
  kind: 'CONNECTOR' | 'OUTBOUND' | 'INBOUND' | 'ROUTE';
  name: string;
  value: any;
}

export interface Registry {
  readonly aggregates: readonly AnyAggregate[];
  readonly commands: readonly RegisteredCommand[];
  readonly events: readonly AnyEvent[];
  readonly reactions: readonly { r: AnyReaction; name: string }[];
  readonly queries: readonly AnyQuery[];
  readonly approvals: readonly { a: Approval; name: string }[];
  readonly jobs: readonly Job[];
  readonly extensions: readonly RuntimeExtension[];
  readonly systemDdl: readonly string[];
  aggregate(name: string): AnyAggregate | undefined;
  /** 按能力点或命令对象找命令 */
  command(ref: string | AnyCommand): RegisteredCommand | undefined;
  capabilityOf(cmd: AnyCommand): string;
  /** 任意原语对象的导出名 */
  nameOf(v: object): string | undefined;
  reactionsFor(eventName: string): { r: AnyReaction; name: string }[];
  approvalFor(aggName: string): { a: Approval; name: string } | undefined;
  approvalByProcess(process: string): { a: Approval; name: string } | undefined;
  capabilityCatalog(): CatalogEntry[];
  /** 带 CONSUMERS 标记的声明对象（连接器出站映射等） */
  consumerProviders(): any[];
}

export interface RegistryOptions {
  /** 框架额外的系统能力点，例如 Sys.audit.read */
  extraCapabilities?: CatalogEntry[];
}

/** 遍历一个或多个 domain 模块的导出，建立注册表。 */
export function buildRegistry(domains: object | object[], opts: RegistryOptions = {}): Registry {
  const mods = Array.isArray(domains) ? domains : [domains];
  const names = new Map<object, string>();
  const aggregates: AnyAggregate[] = [];
  const commands: RegisteredCommand[] = [];
  const events: AnyEvent[] = [];
  const reactions: { r: AnyReaction; name: string }[] = [];
  const queries: AnyQuery[] = [];
  const approvals: { a: Approval; name: string }[] = [];
  const jobs: Job[] = [];
  const extensions: RuntimeExtension[] = [];
  const systemDdl: string[] = [];

  for (const mod of mods) {
    for (const [exportName, v] of Object.entries(mod)) {
      if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
      if (names.has(v)) continue; // 同一个对象被重复导出：保留第一个名字
      const brand = brandOf(v);
      if (!brand) continue;
      names.set(v, exportName);
      switch (brand) {
        case 'AGGREGATE':
          if (aggregates.some((a) => a.name === (v as AnyAggregate).name)) {
            throw declError('CAGE-REG-002', `聚合名重复：${(v as AnyAggregate).name}`);
          }
          aggregates.push(v as AnyAggregate);
          break;
        case 'COMMAND': {
          const cmd = v as AnyCommand;
          const name = cmd.name ?? exportName;
          commands.push({ cmd, name, capability: `${cmd.agg.name}.${name}`, exportName });
          break;
        }
        case 'EVENT':
          events.push(v as AnyEvent);
          break;
        case 'REACTION':
          reactions.push({ r: v as AnyReaction, name: (v as AnyReaction).name ?? exportName });
          break;
        case 'QUERY':
          queries.push(v as AnyQuery);
          break;
        case 'APPROVAL':
          approvals.push({ a: v as Approval, name: exportName });
          break;
        case 'JOB':
          jobs.push(v as Job);
          break;
        case 'CONNECTOR':
        case 'OUTBOUND':
        case 'INBOUND':
        case 'ROUTE':
          extensions.push({ kind: brand, name: exportName, value: v });
          break;
        default:
          break;
      }
      const ddl = (v as any)[SYSTEM_DDL];
      if (typeof ddl === 'function') {
        const text = String(ddl());
        if (!systemDdl.includes(text)) systemDdl.push(text);
      }
    }
  }

  // ---- 一致性校验：引用的东西都必须被导出，否则抽取器和内核看不到 ----
  const aggSet = new Set(aggregates);
  const caps = new Set<string>();
  for (const c of commands) {
    if (!aggSet.has(c.cmd.agg)) throw declError('CAGE-REG-001', `命令 ${c.capability} 所属的聚合 ${c.cmd.agg.name} 没有从 domain 导出`);
    if (caps.has(c.capability)) throw declError('CAGE-REG-003', `能力点重复：${c.capability}，可用 command({ name }) 区分`);
    caps.add(c.capability);
    for (const [alias, a] of Object.entries(c.cmd.reads)) {
      if (!aggSet.has(a)) throw declError('CAGE-REG-001', `命令 ${c.capability} 的 reads.${alias} 引用的聚合没有导出`);
    }
  }
  const cmdSet = new Set(commands.map((c) => c.cmd));
  for (const { r, name } of reactions) {
    if (!cmdSet.has(r.command)) throw declError('CAGE-REG-001', `反应 ${name} 调用的命令没有从 domain 导出`);
  }
  for (const { a, name } of approvals) {
    if (!cmdSet.has(a.onApproved) || !cmdSet.has(a.onRejected)) {
      throw declError('CAGE-REG-001', `审批绑定 ${name} 的结论命令没有从 domain 导出`);
    }
  }
  for (const j of jobs) {
    for (const c of j.calls) if (!cmdSet.has(c)) throw declError('CAGE-REG-001', `任务 ${j.name} 调用的命令没有导出`);
  }
  const queryNames = new Set<string>();
  for (const q of queries) {
    if (queryNames.has(q.name)) throw declError('CAGE-REG-002', `查询名重复：${q.name}`);
    queryNames.add(q.name);
  }

  const byCap = new Map(commands.map((c) => [c.capability, c]));
  const byCmd = new Map(commands.map((c) => [c.cmd, c]));
  const byAgg = new Map(aggregates.map((a) => [a.name, a]));

  const registry: Registry = {
    aggregates, commands, events, reactions, queries, approvals, jobs, extensions, systemDdl,
    aggregate: (name) => byAgg.get(name),
    command: (ref) => (typeof ref === 'string' ? byCap.get(ref) : byCmd.get(ref)),
    capabilityOf: (cmd) => {
      const c = byCmd.get(cmd);
      if (!c) throw declError('CAGE-REG-001', `命令（${cmd.agg.name}）没有从 domain 导出，无法确定能力点`);
      return c.capability;
    },
    nameOf: (v) => names.get(v),
    reactionsFor: (eventName) => reactions.filter((x) => x.r.event.name === eventName),
    approvalFor: (aggName) => approvals.find((x) => x.a.agg.name === aggName),
    approvalByProcess: (process) => approvals.find((x) => x.a.process === process),
    capabilityCatalog: () => {
      const out: CatalogEntry[] = [];
      for (const a of aggregates) {
        out.push({ capability: `${a.name}.read`, kind: 'read', aggregate: a.name, description: `查看${a.description ?? a.name}` });
        out.push({ capability: `${a.name}.export`, kind: 'export', aggregate: a.name, description: `导出${a.description ?? a.name}` });
        for (const kind of new Set(Object.values(sensitiveFields(a)))) {
          out.push({ capability: `${a.name}.unmask.${kind}`, kind: 'unmask', aggregate: a.name, description: `查看 ${a.name} 的 ${kind} 明文` });
        }
      }
      for (const c of commands) {
        out.push({
          capability: c.capability, kind: 'command', aggregate: c.cmd.agg.name,
          description: c.cmd.description, invokedBy: c.cmd.invokedBy,
        });
      }
      // 框架系统能力：审计查询、异步任务运维（内核拥有审计表和 outbox）
      out.push(
        { capability: 'Sys.audit.read', kind: 'system', description: '查询审计记录' },
        { capability: 'Sys.ops.read', kind: 'system', description: '查看异步任务、死信、第三方同步记录' },
        { capability: 'Sys.ops.manage', kind: 'system', description: '重放或丢弃死信、启停定时任务' },
      );
      for (const e of opts.extraCapabilities ?? []) out.push(e);
      return out.sort((x, y) => x.capability.localeCompare(y.capability));
    },
    consumerProviders: () =>
      extensions.map((e) => e.value).filter((v) => typeof v?.[CONSUMERS] === 'function'),
  };
  return Object.freeze(registry);
}

export { CONNECTOR, INBOUND, OUTBOUND, ROUTE };
