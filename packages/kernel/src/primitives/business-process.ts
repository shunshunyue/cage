// 业务流程是可检查的阅读规格。它引用已有声明，不调度命令，也不授予执行权限。
import { BUSINESS_PROCESS, INBOUND, OUTBOUND, brandOf } from '../brands.js';
import { declError } from '../errors.js';
import type { AnyAggregate } from './aggregate.js';
import type { AnyCommand } from './command.js';
import type { AnyEvent } from './event.js';
import type { AnyQuery, AnyReaction, Approval, Job } from './flow.js';

/** 使用对象引用，让注册表能发现未导出的实现，避免字符串随重命名悄悄失效。 */
export type BusinessAction = AnyCommand | AnyEvent | AnyReaction | AnyQuery | Approval | Job
  | { readonly [INBOUND]: true } | { readonly [OUTBOUND]: true };

export interface BusinessStage {
  readonly title: string;
  readonly description: string;
  /** 业务职责说明；不替代角色授权或审批选人。 */
  readonly actor?: string;
  readonly kind?: 'action' | 'decision' | 'end';
  readonly action: BusinessAction;
  readonly details?: readonly BusinessAction[];
  readonly related?: readonly {
    readonly object: AnyAggregate;
    readonly label: string;
    /** 这份实际声明负责关联；CLI 继续核对它与阶段、对象之间的关系。 */
    readonly via: BusinessAction;
  }[];
}

export interface BusinessTransition<S extends string = string> {
  readonly from: S;
  readonly to: S;
  readonly mode: 'manual' | 'automatic' | 'wait';
  readonly label: string;
  /** 次要路径按需展开；审批通过/驳回等主要分支应保持可见。 */
  readonly branch?: boolean;
}

export interface BusinessProcess {
  readonly [BUSINESS_PROCESS]: true;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly area: { readonly id: string; readonly title: string; readonly description: string };
  readonly subject: AnyAggregate;
  readonly entry: string;
  readonly stages: Readonly<Record<string, BusinessStage>>;
  readonly transitions: readonly BusinessTransition[];
}

export function businessProcess<const S extends Record<string, BusinessStage>>(
  name: string,
  def: Omit<BusinessProcess, typeof BUSINESS_PROCESS | 'name' | 'stages' | 'entry' | 'transitions'> & {
    stages: S;
    entry: keyof S & string;
    transitions: readonly BusinessTransition<keyof S & string>[];
  },
): BusinessProcess {
  const invalid = (reason: string): never => { throw declError('CAGE-BIZ-001', `${name}：${reason}`); };
  const identifier = (value: string) => /^[a-z][a-z0-9-]*$/.test(value);
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (!identifier(name) || !identifier(def.area.id)) invalid('流程与板块标识须使用小写短横线格式');
  if (brandOf(def.subject) !== 'AGGREGATE') invalid('主业务对象必须引用实际聚合声明');
  if (![def.title, def.description, def.area.title, def.area.description].every(text)) invalid('请填写流程及业务板块的名称和说明');
  if (!Object.hasOwn(def.stages, def.entry)) invalid('入口阶段不存在');
  const stages: Record<string, BusinessStage> = {};
  const actionKinds = new Set(['COMMAND', 'EVENT', 'REACTION', 'QUERY', 'APPROVAL', 'JOB', 'INBOUND', 'OUTBOUND']);
  for (const [id, stage] of Object.entries(def.stages)) {
    if (!identifier(id) || !text(stage.title) || !text(stage.description)) invalid(`阶段 ${id} 需要有效标识、名称和说明`);
    if (stage.kind && !['action', 'decision', 'end'].includes(stage.kind)) invalid(`阶段 ${id} 的类型无效`);
    for (const action of [stage.action, ...(stage.details ?? []), ...(stage.related ?? []).map(r => r.via)]) {
      if (!actionKinds.has(brandOf(action) ?? '')) invalid(`阶段 ${id} 必须引用实际业务操作、审批或自动处理声明`);
    }
    for (const relation of stage.related ?? []) {
      if (brandOf(relation.object) !== 'AGGREGATE' || !text(relation.label)) invalid(`阶段 ${id} 的关联需要业务对象和说明`);
    }
    stages[id] = Object.freeze({ ...stage,
      details: Object.freeze([...(stage.details ?? [])]),
      related: Object.freeze((stage.related ?? []).map(r => Object.freeze({ ...r }))),
    });
  }
  const seen = new Set<string>();
  for (const edge of def.transitions) {
    if (!Object.hasOwn(stages, edge.from) || !Object.hasOwn(stages, edge.to)) invalid(`连线 ${edge.from} → ${edge.to} 引用了不存在的阶段`);
    if (!['manual', 'automatic', 'wait'].includes(edge.mode) || !text(edge.label)) invalid('每条连线需要执行方式和业务说明');
    const key = `${edge.from}>${edge.to}:${edge.mode}:${edge.label}`;
    if (seen.has(key)) invalid(`重复连线：${edge.from} → ${edge.to}`);
    seen.add(key);
    if (stages[edge.from].kind === 'end') invalid(`结束阶段 ${edge.from} 不能有后续连线`);
  }
  return Object.freeze({ ...def, [BUSINESS_PROCESS]: true as const, name,
    area: Object.freeze({ ...def.area }), stages: Object.freeze(stages),
    transitions: Object.freeze(def.transitions.map(edge => Object.freeze({ ...edge }))),
  });
}
